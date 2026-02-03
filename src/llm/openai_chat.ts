import crypto from "node:crypto";
import type { RalphConfig } from "../config/config.js";
import { randomId } from "../util/id.js";
import { sleep } from "../util/time.js";
import { OpenAiChatResponseSchema } from "./schema.js";
import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  ToolSchema,
} from "./types.js";

export class OpenAiChatClient implements LlmClient {
  private autoMode?: "tools" | "functions" | "none";

  constructor(private readonly config: RalphConfig["llm"]) {}

  async generate(
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    const toolNameMap = buildToolNameMap(tools);
    const mode = this.resolveMode();
    if (mode === "auto") {
      return this.generateAuto(messages, toolNameMap);
    }
    return this.sendRequest(messages, toolNameMap, mode);
  }

  private async sendRequest(
    messages: LlmMessage[],
    toolNameMap: ToolNameMap,
    mode: "tools" | "functions" | "none",
  ): Promise<LlmResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: false,
    };
    if (toolNameMap.tools.length > 0 && mode !== "none") {
      if (mode === "tools") {
        payload.tools = toolNameMap.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        payload.tool_choice = "auto";
      } else {
        payload.functions = toolNameMap.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
        payload.function_call = "auto";
      }
    }

    const response = await requestWithRetry(url, payload, this.config.apiKey);
    const data = OpenAiChatResponseSchema.parse(await response.json());
    const choice = data.choices[0]?.message;
    if (!choice) {
      throw new Error("LLM response missing message");
    }

    let toolCalls: LlmToolCall[] | undefined = choice.tool_calls?.map(
      (call) => ({
        id: call.id,
        name:
          toolNameMap.toOriginal.get(call.function.name) ?? call.function.name,
        arguments: call.function.arguments,
      }),
    );
    let toolCallPayload = choice.tool_calls;
    if ((!toolCalls || toolCalls.length === 0) && choice.function_call) {
      const id = randomId("call");
      toolCalls = [
        {
          id,
          name:
            toolNameMap.toOriginal.get(choice.function_call.name) ??
            choice.function_call.name,
          arguments: choice.function_call.arguments,
        },
      ];
      toolCallPayload = [
        {
          id,
          type: "function",
          function: {
            name: choice.function_call.name,
            arguments: choice.function_call.arguments,
          },
        },
      ];
    }

    const role =
      choice.role === "system" ||
      choice.role === "user" ||
      choice.role === "assistant" ||
      choice.role === "tool"
        ? choice.role
        : "assistant";

    return {
      message: {
        role,
        content: choice.content ?? null,
        tool_calls: toolCallPayload,
      },
      text: choice.content ?? null,
      toolCalls,
    };
  }

  private resolveMode(): "auto" | "tools" | "functions" | "none" {
    if (this.config.toolMode === "auto") return "auto";
    return this.config.toolMode;
  }

  private async generateAuto(
    messages: LlmMessage[],
    toolNameMap: ToolNameMap,
  ): Promise<LlmResponse> {
    const order: Array<"tools" | "functions" | "none"> = this.autoMode
      ? [this.autoMode]
      : ["tools", "functions", "none"];
    let lastError: unknown;
    for (const mode of order) {
      try {
        const result = await this.sendRequest(messages, toolNameMap, mode);
        this.autoMode = mode;
        return result;
      } catch (err) {
        lastError = err;
        if (!this.isToolSupportError(err)) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  private isToolSupportError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.includes("Tool type cannot be empty") ||
      message.includes("Unknown field: tools") ||
      message.includes("invalid tools") ||
      message.includes("tool_choice") ||
      message.includes("functions not supported")
    );
  }
}

type ToolNameMap = {
  tools: ToolSchema[];
  toOriginal: Map<string, string>;
};

type RetryConfig = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type SemaphoreRelease = () => void;

class Semaphore {
  private active = 0;
  private readonly queue: Array<(release: SemaphoreRelease) => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<SemaphoreRelease> {
    if (this.active < this.capacity) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this.active += 1;
      next(() => this.release());
    }
  }
}

let requestSemaphore: Semaphore | null = null;

function getSemaphore(): Semaphore {
  if (requestSemaphore) return requestSemaphore;
  const maxConcurrency = parseEnvInt(process.env.LLM_MAX_CONCURRENCY, 1);
  requestSemaphore = new Semaphore(Math.max(1, maxConcurrency));
  return requestSemaphore;
}

function getRetryConfig(): RetryConfig {
  return {
    maxRetries: parseEnvInt(process.env.LLM_MAX_RETRIES, 3),
    baseDelayMs: parseEnvInt(process.env.LLM_RETRY_BASE_MS, 500),
    maxDelayMs: parseEnvInt(process.env.LLM_RETRY_MAX_MS, 5_000),
  };
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function computeRetryDelay(
  attempt: number,
  cfg: RetryConfig,
  retryAfter: string | null,
): number {
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(cfg.maxDelayMs, seconds * 1000);
    }
    const parsed = Date.parse(retryAfter);
    if (!Number.isNaN(parsed)) {
      const delta = parsed - Date.now();
      if (delta > 0) {
        return Math.min(cfg.maxDelayMs, delta);
      }
    }
  }
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.min(250, exp));
  return Math.min(cfg.maxDelayMs, exp + jitter);
}

async function requestWithRetry(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
): Promise<Response> {
  const cfg = getRetryConfig();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    const release = await getSemaphore().acquire();
    let response: Response | null = null;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      release();
    }

    if (response?.ok) {
      return response;
    }

    if (response) {
      const body = await response.text();
      if (shouldRetry(response.status) && attempt < cfg.maxRetries) {
        await sleep(
          computeRetryDelay(attempt, cfg, response.headers.get("retry-after")),
        );
        continue;
      }
      throw new Error(`LLM request failed: ${response.status} ${body}`);
    }

    if (attempt < cfg.maxRetries) {
      await sleep(computeRetryDelay(attempt, cfg, null));
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("LLM request failed: unknown error");
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function buildToolNameMap(tools: ToolSchema[]): ToolNameMap {
  const used = new Set<string>();
  const toOriginal = new Map<string, string>();
  const mapped: ToolSchema[] = [];
  for (const tool of tools) {
    const alias = toSafeToolName(tool.name, used);
    toOriginal.set(alias, tool.name);
    mapped.push({ ...tool, name: alias });
  }
  return { tools: mapped, toOriginal };
}

function toSafeToolName(name: string, used: Set<string>): string {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const trimmed = base.replace(/^_+|_+$/g, "") || "tool";
  const hash = crypto.createHash("sha1").update(name).digest("hex").slice(0, 6);
  let candidate = trimmed;
  if (candidate.length > 64) {
    candidate = candidate.slice(0, 64);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(candidate) || candidate.length === 0) {
    candidate = `tool_${hash}`;
  }
  if (used.has(candidate)) {
    const suffix = `_${hash}`;
    const maxPrefix = Math.max(1, 64 - suffix.length);
    candidate = `${trimmed.slice(0, maxPrefix)}${suffix}`;
    let counter = 1;
    while (used.has(candidate)) {
      const extra = `_${hash}${counter}`;
      const max = Math.max(1, 64 - extra.length);
      candidate = `${trimmed.slice(0, max)}${extra}`;
      counter += 1;
    }
  }
  used.add(candidate);
  return candidate;
}

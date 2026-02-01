import crypto from "node:crypto";
import type { RalphConfig } from "../config/config.js";
import { randomId } from "../util/id.js";
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${body}`);
    }

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

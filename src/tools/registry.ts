import type { AgentHandle } from "../agent/types.js";
import type { RalphConfig } from "../config/config.js";
import type { SessionJournal, TradeJournal } from "../journal/journal.js";
import type { ToolSchema } from "../llm/types.js";
import type { SolanaAdapter } from "../solana/adapter.js";
import { warn } from "../util/logger.js";
import { redact } from "../util/redaction.js";
import { isRecord } from "../util/types.js";
import { TOOL_VALIDATORS } from "./validate.js";

export type ToolContext = {
  config: RalphConfig;
  solana: SolanaAdapter;
  sessionJournal: SessionJournal;
  tradeJournal: TradeJournal;
  agent?: AgentHandle;
  agentControl?: {
    message: (input: {
      content: string;
      triggerTick?: boolean;
    }) => Promise<unknown>;
  };
};

export type ToolRequirement = {
  env?: string[];
  config?: string[];
};

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  schema?: ToolSchema;
  requires?: ToolRequirement;
  execute: (ctx: ToolContext, input: TInput) => Promise<TOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listSchemas(config: RalphConfig): ToolSchema[] {
    return this.list()
      .filter(
        (tool): tool is ToolDefinition & { schema: ToolSchema } =>
          Boolean(tool.schema) && this.isEligible(tool, config),
      )
      .map((tool) => tool.schema);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async invoke(
    name: string,
    ctx: ToolContext,
    input: unknown,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (!this.isEligible(tool, ctx.config)) {
      throw new Error(`Tool not eligible: ${name}`);
    }
    const validator = TOOL_VALIDATORS[name];
    if (validator) {
      const parsed = validator.safeParse(input ?? {});
      if (!parsed.success) {
        warn("tool.validation.failed", {
          tool: name,
          issues: parsed.error.flatten(),
        });
        throw new Error(`Tool validation failed: ${name}`);
      }
    }
    const result = await tool.execute(ctx, input);
    await ctx.sessionJournal.append({
      type: "tool",
      name,
      input: redact(input),
      output: redact(result),
      ts: new Date().toISOString(),
    });
    return result;
  }

  isEligible(tool: ToolDefinition, config: RalphConfig): boolean {
    const requirements = tool.requires;
    if (!requirements) return true;
    if (requirements.env) {
      for (const key of requirements.env) {
        if (!process.env[key]) return false;
      }
    }
    if (requirements.config) {
      for (const path of requirements.config) {
        if (getConfigValue(config, path) === undefined) return false;
      }
    }
    return true;
  }
}

function getConfigValue(config: RalphConfig, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

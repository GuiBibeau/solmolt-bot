import type { SolmoltConfig } from '../config/config.js';
import type { SolanaAdapter } from '../solana/adapter.js';
import { SessionJournal, TradeJournal } from '../journal/journal.js';
import { redact } from '../util/redaction.js';

export type ToolContext = {
  config: SolmoltConfig;
  solana: SolanaAdapter;
  sessionJournal: SessionJournal;
  tradeJournal: TradeJournal;
};

export type ToolRequirement = {
  env?: string[];
  config?: string[];
};

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  requires?: ToolRequirement;
  execute: (ctx: ToolContext, input: TInput) => Promise<TOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async invoke(name: string, ctx: ToolContext, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (!this.isEligible(tool, ctx.config)) {
      throw new Error(`Tool not eligible: ${name}`);
    }
    const result = await tool.execute(ctx, input);
    await ctx.sessionJournal.append({
      type: 'tool',
      name,
      input: redact(input as Record<string, unknown>),
      output: redact(result as Record<string, unknown>),
      ts: new Date().toISOString(),
    });
    return result;
  }

  isEligible(tool: ToolDefinition, config: SolmoltConfig): boolean {
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

function getConfigValue(config: SolmoltConfig, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = config as unknown;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return current;
}

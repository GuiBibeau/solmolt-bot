import { createLlmClient } from "../llm/index.js";
import type { LlmClient, LlmMessage, LlmToolCall } from "../llm/types.js";
import type { ToolContext, ToolRegistry } from "../tools/registry.js";
import { info, warn } from "../util/logger.js";
import type { AgentTickReason, AgentTickResult } from "./types.js";

export type AutopilotPlan = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
};

type AgentState = {
  inFlight: boolean;
  lastTradeAtMs?: number;
  tickCount: number;
  messages: LlmMessage[];
};

export class AgentOrchestrator {
  private state: AgentState = {
    inFlight: false,
    tickCount: 0,
    messages: [],
  };
  private readonly llm: LlmClient;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly ctx: ToolContext,
  ) {
    this.llm = createLlmClient(ctx.config.llm);
  }

  injectMessage(content: string): void {
    this.state.messages.push({ role: "user", content });
  }

  async tick(reason: AgentTickReason): Promise<AgentTickResult> {
    if (this.state.inFlight) {
      return {
        actionsTaken: [],
        nextTickInMs: this.ctx.config.autopilot.intervalMs,
        skipped: "inflight",
      };
    }

    if (!this.ctx.config.autopilot.enabled && reason === "timer") {
      return {
        actionsTaken: [],
        nextTickInMs: this.ctx.config.autopilot.intervalMs,
        skipped: "autopilot-disabled",
      };
    }

    this.state.inFlight = true;
    this.state.tickCount += 1;

    try {
      const actions: string[] = [];
      const policy = this.ctx.config.policy;
      const plan = this.ctx.config.autopilot.plan as AutopilotPlan | undefined;

      if (policy.killSwitch) {
        await this.notify("warn", "Kill switch enabled; skipping tick.", {
          reason,
        });
        return {
          actionsTaken: actions,
          nextTickInMs: this.ctx.config.autopilot.intervalMs,
          skipped: "kill-switch",
        };
      }

      const now = Date.now();
      if (this.state.lastTradeAtMs) {
        const elapsed = (now - this.state.lastTradeAtMs) / 1000;
        if (elapsed < policy.cooldownSeconds) {
          return {
            actionsTaken: actions,
            nextTickInMs: this.ctx.config.autopilot.intervalMs,
            skipped: "cooldown",
          };
        }
      }

      this.ensureSystemPrompt(plan);
      const tools = this.registry.listSchemas(this.ctx.config);

      this.state.messages.push({
        role: "user",
        content: `Tick reason: ${reason}. Decide whether to take action. Use tools when needed.`,
      });

      const maxSteps = 4;
      for (let step = 0; step < maxSteps; step += 1) {
        const response = await this.llm.generate(this.state.messages, tools);
        this.state.messages.push(response.message);
        await this.ctx.sessionJournal.append({
          type: "llm",
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls?.map((call) => ({
            id: call.id,
            name: call.name,
          })),
          ts: new Date().toISOString(),
        });

        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }

        const toolResults = await this.executeToolCalls(
          response.toolCalls,
          actions,
        );
        this.state.messages.push(...toolResults);
      }

      return {
        actionsTaken: actions,
        nextTickInMs: this.ctx.config.autopilot.intervalMs,
      };
    } catch (err) {
      warn("agent tick failed", { err: String(err) });
      return {
        actionsTaken: [],
        nextTickInMs: this.ctx.config.autopilot.intervalMs,
        error: String(err),
      };
    } finally {
      this.state.inFlight = false;
    }
  }

  private async notify(
    level: "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.registry.invoke("notify.emit", this.ctx, {
        level,
        message,
        metadata,
      });
    } catch (err) {
      info("notify failed", { err: String(err) });
    }
  }

  private ensureSystemPrompt(plan?: AutopilotPlan): void {
    if (
      this.state.messages.find((msg) => {
        const role = (msg as { role?: unknown }).role;
        return typeof role === "string" && role === "system";
      })
    ) {
      return;
    }
    const policy = this.ctx.config.policy;
    const lines = [
      "You are Serious Trader Ralph, an autonomous Solana trading agent.",
      "Use the available tools to inspect balances, request quotes, check risk, and execute swaps.",
      "Never ask for private keys or API keys. Assume tools handle signing.",
      `Policy: killSwitch=${policy.killSwitch}, maxSlippageBps=${policy.maxSlippageBps}, maxPriceImpactPct=${policy.maxPriceImpactPct}, cooldownSeconds=${policy.cooldownSeconds}.`,
      policy.allowedMints.length > 0
        ? `Allowed mints: ${policy.allowedMints.join(", ")}`
        : "Allowed mints: any",
      plan
        ? `Preferred plan: inputMint=${plan.inputMint}, outputMint=${plan.outputMint}, amount=${plan.amount}, slippageBps=${plan.slippageBps}.`
        : "No preferred plan configured; decide dynamically.",
    ];
    this.state.messages.unshift({
      role: "system",
      content: lines.join("\n"),
    });
  }

  private async executeToolCalls(
    toolCalls: LlmToolCall[],
    actions: string[],
  ): Promise<LlmMessage[]> {
    const toolResults: LlmMessage[] = [];
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch (_err) {
        await this.notify("warn", "Failed to parse tool arguments.", {
          tool: call.name,
        });
      }
      await this.ctx.sessionJournal.append({
        type: "tool_call",
        tool: call.name,
        args,
        ts: new Date().toISOString(),
      });
      const result = await this.registry.invoke(call.name, this.ctx, args);
      actions.push(call.name);
      toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
      if (call.name === "trade.jupiter_swap") {
        this.state.lastTradeAtMs = Date.now();
      }
    }
    return toolResults;
  }
}

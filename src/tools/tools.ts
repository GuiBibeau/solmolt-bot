import type { JupiterClient } from "../jupiter/client.js";
import { evaluateTrade } from "../policy/index.js";
import { info } from "../util/logger.js";
import type { ToolContext, ToolRegistry } from "./registry.js";
import type {
  BalancesSnapshot,
  PolicySnapshot,
  QuoteSummary,
} from "./types.js";

export function registerDefaultTools(
  registry: ToolRegistry,
  jupiter: JupiterClient,
): void {
  registry.register({
    name: "wallet.get_balances",
    description: "Return SOL + SPL balances for the agent wallet.",
    schema: {
      name: "wallet.get_balances",
      description: "Return SOL + SPL balances for the agent wallet.",
      parameters: {
        type: "object",
        properties: {
          mints: { type: "array", items: { type: "string" } },
        },
        required: [],
        additionalProperties: false,
      },
    },
    requires: { config: ["rpc.endpoint"] },
    execute: async (ctx: ToolContext, input: { mints?: string[] }) => {
      const solLamports = await ctx.solana.getSolBalanceLamports();
      const tokens = await ctx.solana.getSplBalances(input?.mints);
      return { solLamports, tokens };
    },
  });

  registry.register({
    name: "market.jupiter_quote",
    description: "Fetch a Jupiter swap quote.",
    schema: {
      name: "market.jupiter_quote",
      description: "Fetch a Jupiter swap quote.",
      parameters: {
        type: "object",
        properties: {
          inputMint: { type: "string" },
          outputMint: { type: "string" },
          amount: { type: "string" },
          slippageBps: { type: "integer" },
        },
        required: ["inputMint", "outputMint", "amount", "slippageBps"],
        additionalProperties: false,
      },
    },
    requires: { config: ["jupiter.apiKey"] },
    execute: async (
      _ctx: ToolContext,
      input: {
        inputMint: string;
        outputMint: string;
        amount: string;
        slippageBps: number;
      },
    ) => {
      return jupiter.quote(input);
    },
  });

  registry.register({
    name: "risk.check_trade",
    description: "Deterministic allow/deny with policy constraints.",
    schema: {
      name: "risk.check_trade",
      description: "Deterministic allow/deny with policy constraints.",
      parameters: {
        type: "object",
        properties: {
          quoteSummary: {
            type: "object",
            properties: {
              inAmount: { type: "string" },
              outAmount: { type: "string" },
              priceImpactPct: { type: "number" },
              routeLabels: { type: "array", items: { type: "string" } },
            },
            required: [
              "inAmount",
              "outAmount",
              "priceImpactPct",
              "routeLabels",
            ],
            additionalProperties: true,
          },
          balancesSnapshot: {
            type: "object",
            properties: {
              solLamports: { type: "string" },
              tokens: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    mint: { type: "string" },
                    amountRaw: { type: "string" },
                    decimals: { type: "integer" },
                    uiAmount: { type: ["number", "null"] },
                  },
                  required: ["mint", "amountRaw", "decimals", "uiAmount"],
                  additionalProperties: false,
                },
              },
            },
            required: ["solLamports", "tokens"],
            additionalProperties: false,
          },
          policySnapshot: {
            type: "object",
            properties: {
              killSwitch: { type: "boolean" },
              allowedMints: { type: "array", items: { type: "string" } },
              maxTradeAmountLamports: { type: "string" },
              maxSlippageBps: { type: "integer" },
              maxPriceImpactPct: { type: "number" },
              cooldownSeconds: { type: "integer" },
              dailySpendCapLamports: { type: ["string", "null"] },
            },
            required: [
              "killSwitch",
              "allowedMints",
              "maxTradeAmountLamports",
              "maxSlippageBps",
              "maxPriceImpactPct",
              "cooldownSeconds",
            ],
            additionalProperties: true,
          },
        },
        required: ["quoteSummary", "balancesSnapshot", "policySnapshot"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: {
        quoteSummary: QuoteSummary;
        balancesSnapshot: BalancesSnapshot;
        policySnapshot: PolicySnapshot;
      },
    ) => {
      return evaluateTrade(
        input.policySnapshot,
        input.quoteSummary,
        input.balancesSnapshot,
      );
    },
  });

  registry.register({
    name: "trade.jupiter_swap",
    description: "Build + sign + submit Jupiter swap transaction.",
    schema: {
      name: "trade.jupiter_swap",
      description: "Build + sign + submit Jupiter swap transaction.",
      parameters: {
        type: "object",
        properties: {
          quoteResponse: { type: "object" },
          txOptions: {
            type: "object",
            properties: {
              commitment: {
                type: "string",
                enum: ["processed", "confirmed", "finalized"],
              },
            },
            required: [],
            additionalProperties: false,
          },
        },
        required: ["quoteResponse"],
        additionalProperties: false,
      },
    },
    requires: { config: ["rpc.endpoint", "jupiter.apiKey"] },
    execute: async (
      ctx: ToolContext,
      input: {
        quoteResponse: import("../jupiter/schema.js").JupiterQuoteResponse;
        txOptions?: { commitment?: "processed" | "confirmed" | "finalized" };
      },
    ) => {
      enforcePolicy(ctx.config.policy, input.quoteResponse);
      const swap = await jupiter.swap({
        quoteResponse: input.quoteResponse,
        userPublicKey: ctx.solana.getPublicKey(),
      });
      const rawTx = Buffer.from(swap.swapTransaction, "base64");
      const signed = await ctx.solana.signRawTransaction(rawTx);
      const result = await ctx.solana.sendAndConfirmRawTx(signed, {
        commitment: input.txOptions?.commitment ?? "confirmed",
      });
      await ctx.tradeJournal.append({
        type: "swap",
        signature: result.signature,
        status: result.err ? "error" : "confirmed",
        lastValidBlockHeight: swap.lastValidBlockHeight,
      });
      return {
        signature: result.signature,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        status: result.err ? "error" : "confirmed",
      };
    },
  });

  registry.register({
    name: "system.autopilot_tick",
    description: "Timer-driven autonomous iteration.",
    schema: {
      name: "system.autopilot_tick",
      description: "Timer-driven autonomous iteration.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", enum: ["timer", "operator", "recovery"] },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { reason: "timer" | "operator" | "recovery" },
    ) => {
      info("autopilot tick", { reason: input.reason });
      if (ctx.agent) {
        return ctx.agent.tick(input.reason);
      }
      return {
        actionsTaken: [],
        nextTickInMs: ctx.config.autopilot.intervalMs,
      };
    },
  });

  registry.register({
    name: "agent.message",
    description: "Inject an operator message into the agent loop.",
    schema: {
      name: "agent.message",
      description: "Inject an operator message into the agent loop.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          triggerTick: { type: "boolean" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { content: string; triggerTick?: boolean },
    ) => {
      if (!ctx.agentControl) {
        return { ok: false, error: "agent-control-missing" };
      }
      return ctx.agentControl.message(input.content, input.triggerTick);
    },
  });

  registry.register({
    name: "notify.emit",
    description: "Emit operator notifications to console or webhook.",
    schema: {
      name: "notify.emit",
      description: "Emit operator notifications to console or webhook.",
      parameters: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["info", "warn", "error"] },
          message: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["level", "message"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: {
        level: "info" | "warn" | "error";
        message: string;
        metadata?: Record<string, unknown>;
      },
    ) => {
      if (input.level === "warn") {
        info(`WARN: ${input.message}`, input.metadata);
      } else if (input.level === "error") {
        info(`ERROR: ${input.message}`, input.metadata);
      } else {
        info(input.message, input.metadata);
      }
      return { ok: true };
    },
  });
}

function enforcePolicy(
  policy: PolicySnapshot,
  quoteResponse: import("../jupiter/schema.js").JupiterQuoteResponse,
): void {
  if (policy.killSwitch) {
    throw new Error("kill-switch-enabled");
  }
  const inputMint = quoteResponse.inputMint;
  const outputMint = quoteResponse.outputMint;
  if (policy.allowedMints.length > 0) {
    if (
      (inputMint && !policy.allowedMints.includes(inputMint)) ||
      (outputMint && !policy.allowedMints.includes(outputMint))
    ) {
      throw new Error("mint-not-allowed");
    }
  }
  const inAmount = quoteResponse.inAmount;
  if (policy.maxTradeAmountLamports !== "0" && inAmount) {
    if (BigInt(inAmount) > BigInt(policy.maxTradeAmountLamports)) {
      throw new Error("trade-amount-exceeds-cap");
    }
  }
  const priceImpactPctRaw = quoteResponse.priceImpactPct;
  const priceImpactPct =
    typeof priceImpactPctRaw === "string"
      ? Number(priceImpactPctRaw)
      : (priceImpactPctRaw ?? 0);
  if (priceImpactPct > policy.maxPriceImpactPct) {
    throw new Error("price-impact-too-high");
  }
}

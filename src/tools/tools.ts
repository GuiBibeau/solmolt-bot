import type { JupiterClient, TokenInfo } from "../jupiter/client.js";
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
  const tokenCache = new Map<string, TokenInfo | null>();
  let dexLabelCache: string[] | null = null;
  const solMint = "So11111111111111111111111111111111111111112";
  const solDecimals = 9;
  const priceDecimals = 9;
  const defaultSlippageBps = 50;
  const defaultSolNotional = 1_000_000_000n;

  const getDexLabels = async (): Promise<string[]> => {
    if (dexLabelCache) return dexLabelCache;
    const mapping = await jupiter.programIdToLabel();
    dexLabelCache = Array.from(new Set(Object.values(mapping))).filter(Boolean);
    return dexLabelCache;
  };

  const resolveVenueDexes = async (
    venueInput?: string,
  ): Promise<{ venueUsed: string; dexes?: string[] }> => {
    const normalized = (venueInput || "best").trim().toLowerCase();
    if (normalized === "best" || normalized === "jupiter") {
      return { venueUsed: "jupiter" };
    }
    const labels = await getDexLabels().catch(() => []);
    if (normalized === "raydium" || normalized === "orca") {
      const prefix = normalized === "raydium" ? "Raydium" : "Orca";
      const matched = labels.filter((label) => label.startsWith(prefix));
      if (matched.length > 0) {
        return { venueUsed: normalized, dexes: matched };
      }
      return { venueUsed: normalized, dexes: [prefix] };
    }
    return {
      venueUsed: venueInput ? venueInput.trim() : normalized,
      dexes: venueInput ? [venueInput] : undefined,
    };
  };

  const chunk = <T>(items: T[], size: number): T[][] => {
    if (items.length <= size) return [items];
    const output: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      output.push(items.slice(i, i + size));
    }
    return output;
  };

  const getTokenInfoMap = async (
    mints: string[],
  ): Promise<Map<string, TokenInfo | null>> => {
    const output = new Map<string, TokenInfo | null>();
    const missing = mints.filter((mint) => !tokenCache.has(mint));
    if (missing.length > 0) {
      const chunks = chunk(missing, 100);
      for (const batch of chunks) {
        const results = await jupiter.searchTokens(batch.join(","));
        const seen = new Set<string>();
        for (const token of results) {
          tokenCache.set(token.id, token);
          seen.add(token.id);
        }
        for (const mint of batch) {
          if (!seen.has(mint)) {
            tokenCache.set(mint, null);
          }
        }
      }
    }
    for (const mint of mints) {
      output.set(mint, tokenCache.get(mint) ?? null);
    }
    return output;
  };

  const formatScaled = (value: bigint, decimals: number): string => {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const scale = 10n ** BigInt(decimals);
    const integer = abs / scale;
    const fraction = abs % scale;
    let fractionStr = fraction.toString().padStart(decimals, "0");
    fractionStr = fractionStr.replace(/0+$/, "");
    const rendered = fractionStr ? `${integer}.${fractionStr}` : `${integer}`;
    return negative ? `-${rendered}` : rendered;
  };

  const calcPriceScaled = (
    inRaw: string | undefined,
    inDecimals: number,
    outRaw: string | undefined,
    outDecimals: number,
    precision: number,
  ): bigint | null => {
    if (!inRaw || !outRaw) return null;
    let inAmount: bigint;
    let outAmount: bigint;
    try {
      inAmount = BigInt(inRaw);
      outAmount = BigInt(outRaw);
    } catch {
      return null;
    }
    if (outAmount === 0n) return null;
    const scale = 10n ** BigInt(precision);
    const numerator = inAmount * scale * 10n ** BigInt(outDecimals);
    const denominator = outAmount * 10n ** BigInt(inDecimals);
    if (denominator === 0n) return null;
    return (numerator + denominator / 2n) / denominator;
  };

  const computePriceSnapshot = async (
    mint: string,
    tokenInfo: TokenInfo | null,
    dexes?: string[],
  ): Promise<{
    mint: string;
    bid: string | null;
    ask: string | null;
    mid: string | null;
  }> => {
    if (mint === solMint) {
      return { mint, bid: "1", ask: "1", mid: "1" };
    }
    if (!tokenInfo) {
      return { mint, bid: null, ask: null, mid: null };
    }
    const tokenDecimals = tokenInfo.decimals;
    const oneTokenRaw = (10n ** BigInt(tokenDecimals)).toString();
    let askScaled: bigint | null = null;
    let bidScaled: bigint | null = null;

    try {
      const askQuote = await jupiter.quote({
        inputMint: solMint,
        outputMint: mint,
        amount: oneTokenRaw,
        slippageBps: defaultSlippageBps,
        swapMode: "ExactOut",
        dexes,
      });
      askScaled = calcPriceScaled(
        askQuote.quoteResponse.inAmount,
        solDecimals,
        askQuote.quoteResponse.outAmount,
        tokenDecimals,
        priceDecimals,
      );
    } catch {
      try {
        const askQuote = await jupiter.quote({
          inputMint: solMint,
          outputMint: mint,
          amount: defaultSolNotional.toString(),
          slippageBps: defaultSlippageBps,
          dexes,
        });
        askScaled = calcPriceScaled(
          askQuote.quoteResponse.inAmount,
          solDecimals,
          askQuote.quoteResponse.outAmount,
          tokenDecimals,
          priceDecimals,
        );
      } catch {
        askScaled = null;
      }
    }

    try {
      const bidQuote = await jupiter.quote({
        inputMint: mint,
        outputMint: solMint,
        amount: oneTokenRaw,
        slippageBps: defaultSlippageBps,
        dexes,
      });
      bidScaled = calcPriceScaled(
        bidQuote.quoteResponse.outAmount,
        solDecimals,
        bidQuote.quoteResponse.inAmount,
        tokenDecimals,
        priceDecimals,
      );
    } catch {
      bidScaled = null;
    }

    const midScaled =
      askScaled !== null && bidScaled !== null
        ? (askScaled + bidScaled) / 2n
        : (askScaled ?? bidScaled);

    return {
      mint,
      bid: bidScaled !== null ? formatScaled(bidScaled, priceDecimals) : null,
      ask: askScaled !== null ? formatScaled(askScaled, priceDecimals) : null,
      mid: midScaled !== null ? formatScaled(midScaled, priceDecimals) : null,
    };
  };

  const mapWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> => {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }).map(
      async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          results[index] = await fn(items[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  };
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
    name: "market.get_prices",
    description:
      "Fetch spot prices for SOL/SPL pairs from a venue or best route.",
    schema: {
      name: "market.get_prices",
      description:
        "Fetch spot prices for SOL/SPL pairs from a venue or best route.",
      parameters: {
        type: "object",
        properties: {
          mints: { type: "array", items: { type: "string" } },
          venue: {
            type: "string",
            description: "Venue name or 'best'.",
          },
        },
        required: ["mints"],
        additionalProperties: false,
      },
    },
    requires: { config: ["jupiter.apiKey"] },
    execute: async (
      _ctx: ToolContext,
      input: { mints: string[]; venue?: string },
    ) => {
      const mints = Array.from(
        new Set((input.mints || []).map((mint) => mint.trim()).filter(Boolean)),
      );
      const { venueUsed, dexes } = await resolveVenueDexes(input.venue);
      const tokenInfoMap = await getTokenInfoMap(
        mints.filter((mint) => mint !== solMint),
      );
      const priceInputs = mints.map((mint) => ({
        mint,
        tokenInfo: tokenInfoMap.get(mint) ?? null,
      }));
      const prices = await mapWithConcurrency(
        priceInputs,
        4,
        async ({ mint, tokenInfo }) =>
          computePriceSnapshot(mint, tokenInfo, dexes),
      );
      return {
        prices,
        venueUsed,
        ts: new Date().toISOString(),
      };
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

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
      const batches = chunk(missing, 10);
      for (const batch of batches) {
        await mapWithConcurrency(batch, 5, async (mint) => {
          const results = await jupiter.searchTokens(mint);
          const matched = results.find((token) => token.id === mint) ?? null;
          tokenCache.set(mint, matched);
          if (matched) {
            tokenCache.set(matched.id, matched);
          }
        });
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

  const pythBaseUrl = "https://hermes.pyth.network";

  const formatExpo = (value: bigint, expo: number): string => {
    if (expo >= 0) {
      return (value * 10n ** BigInt(expo)).toString();
    }
    const scale = 10n ** BigInt(-expo);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const integer = abs / scale;
    const fraction = abs % scale;
    let fractionStr = fraction.toString().padStart(-expo, "0");
    fractionStr = fractionStr.replace(/0+$/, "");
    const rendered = fractionStr ? `${integer}.${fractionStr}` : `${integer}`;
    return negative ? `-${rendered}` : rendered;
  };

  const resolvePythFeedId = async (symbol: string): Promise<string> => {
    const url = new URL("/v2/price_feeds", pythBaseUrl);
    url.searchParams.set("query", symbol);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Pyth price_feeds failed: ${response.status}`);
    }
    const feeds = (await response.json()) as Array<{
      id: string;
      attributes?: Record<string, string>;
    }>;
    const normalized = symbol.trim().toUpperCase();
    const normalizedNoSlash = normalized.replace("/", "");
    for (const feed of feeds) {
      const attrs = feed.attributes ?? {};
      const candidates: string[] = [];
      if (attrs.display_symbol) candidates.push(attrs.display_symbol);
      if (attrs.symbol) {
        candidates.push(attrs.symbol);
        const withoutPrefix = attrs.symbol.split(".").slice(1).join(".");
        if (withoutPrefix) candidates.push(withoutPrefix);
      }
      if (attrs.generic_symbol) candidates.push(attrs.generic_symbol);
      if (attrs.base && attrs.quote_currency) {
        candidates.push(`${attrs.base}/${attrs.quote_currency}`);
      }
      for (const candidate of candidates) {
        const candidateNorm = candidate.trim().toUpperCase();
        if (
          candidateNorm === normalized ||
          candidateNorm.replace("/", "") === normalizedNoSlash
        ) {
          return feed.id;
        }
      }
    }
    throw new Error("pyth-feed-not-found");
  };

  const fetchPythPrice = async (feedId: string) => {
    const url = new URL("/v2/updates/price/latest", pythBaseUrl);
    url.searchParams.append("ids[]", feedId);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Pyth price update failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      parsed?: Array<{
        id: string;
        price: {
          price: string | number;
          conf: string | number;
          expo: number;
          publish_time: number;
        };
      }>;
    };
    const parsed = payload.parsed?.[0];
    if (!parsed) {
      throw new Error("pyth-price-not-found");
    }
    return parsed;
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
    name: "market.jupiter_route_map",
    description: "List Jupiter route summaries for a given pair.",
    schema: {
      name: "market.jupiter_route_map",
      description: "List Jupiter route summaries for a given pair.",
      parameters: {
        type: "object",
        properties: {
          inputMint: { type: "string" },
          outputMint: { type: "string" },
          amount: { type: "string" },
          slippageBps: { type: "integer" },
        },
        required: ["inputMint", "outputMint", "amount"],
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
        slippageBps?: number;
      },
    ) => {
      const quote = await jupiter.quote({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amount: input.amount,
        slippageBps: input.slippageBps ?? defaultSlippageBps,
      });
      const labels = quote.quoteResponse.routePlan.map(
        (step) => step.swapInfo.label ?? "route",
      );
      return {
        routes: [
          {
            label: labels.join(" -> "),
            outAmount: quote.quoteResponse.outAmount,
            priceImpactPct: String(quote.quoteResponse.priceImpactPct ?? 0),
          },
        ],
      };
    },
  });

  registry.register({
    name: "market.pyth_price",
    description: "Fetch latest Pyth price for a symbol or feed ID.",
    schema: {
      name: "market.pyth_price",
      description: "Fetch latest Pyth price for a symbol or feed ID.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          feedId: { type: "string" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: { symbol?: string; feedId?: string },
    ) => {
      const feedId =
        input.feedId?.trim() ||
        (input.symbol ? await resolvePythFeedId(input.symbol) : "");
      if (!feedId) {
        throw new Error("symbol-or-feedId-required");
      }
      const parsed = await fetchPythPrice(feedId);
      const expo = parsed.price.expo ?? 0;
      const price = formatExpo(BigInt(parsed.price.price), expo);
      const confidence = formatExpo(BigInt(parsed.price.conf), expo);
      return {
        price,
        confidence,
        publishTime: new Date(parsed.price.publish_time * 1000).toISOString(),
      };
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
    name: "market.token_metadata",
    description: "Fetch token metadata (name, symbol, decimals, logo).",
    schema: {
      name: "market.token_metadata",
      description: "Fetch token metadata (name, symbol, decimals, logo).",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
        },
        required: ["mint"],
        additionalProperties: false,
      },
    },
    requires: { config: ["jupiter.apiKey"] },
    execute: async (_ctx: ToolContext, input: { mint: string }) => {
      const mint = input.mint.trim();
      if (!mint) {
        throw new Error("mint-required");
      }
      const tokenInfoMap = await getTokenInfoMap([mint]);
      const token = tokenInfoMap.get(mint);
      if (!token) {
        throw new Error("token-not-found");
      }
      return {
        name: token.name ?? "",
        symbol: token.symbol ?? "",
        decimals: token.decimals,
        logoUrl: token.icon ?? null,
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

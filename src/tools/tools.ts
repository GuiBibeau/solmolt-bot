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
  const birdeyeBaseUrl = "https://public-api.birdeye.so";
  const candleIntervals: Record<string, { type: string; seconds: number }> = {
    "1m": { type: "1m", seconds: 60 },
    "5m": { type: "5m", seconds: 300 },
    "15m": { type: "15m", seconds: 900 },
    "30m": { type: "30m", seconds: 1800 },
    "1h": { type: "1H", seconds: 3600 },
    "4h": { type: "4H", seconds: 14_400 },
    "1d": { type: "1D", seconds: 86_400 },
  };
  const raydiumBaseUrl = "https://api.raydium.io";
  const switchboardBaseUrl = "https://ondemand.switchboard.xyz";
  let raydiumPairsCache: {
    ts: number;
    data: Array<Record<string, unknown>>;
  } | null = null;

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

  const parseScaled = (value: string, decimals: number): bigint | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const negative = trimmed.startsWith("-");
    const normalized = negative ? trimmed.slice(1) : trimmed;
    const [intPart, fracPartRaw] = normalized.split(".");
    if (!intPart || !/^\d+$/.test(intPart)) return null;
    if (fracPartRaw && !/^\d+$/.test(fracPartRaw)) return null;
    const fracPart = (fracPartRaw ?? "").slice(0, decimals);
    const padded = fracPart.padEnd(decimals, "0");
    const scale = 10n ** BigInt(decimals);
    const integer = BigInt(intPart) * scale;
    const fraction = padded ? BigInt(padded) : 0n;
    const result = integer + fraction;
    return negative ? -result : result;
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

  const valueFromAmount = (
    amountRaw: bigint,
    decimals: number,
    priceScaled: bigint,
  ): bigint => {
    const scale = 10n ** BigInt(decimals);
    return (amountRaw * priceScaled) / scale;
  };

  const fetchCandles = async (input: {
    inputMint: string;
    outputMint: string;
    interval: string;
    limit: number;
  }): Promise<
    Array<{
      t: number;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
    }>
  > => {
    const intervalKey = input.interval.trim().toLowerCase();
    const interval = candleIntervals[intervalKey];
    if (!interval) {
      throw new Error("unsupported-interval");
    }
    const limit = Math.max(1, Math.min(input.limit, 1000));
    const timeTo = Math.floor(Date.now() / 1000);
    const timeFrom = timeTo - interval.seconds * limit;
    const url = new URL("/defi/ohlcv/base_quote", birdeyeBaseUrl);
    url.searchParams.set("base_address", input.inputMint);
    url.searchParams.set("quote_address", input.outputMint);
    url.searchParams.set("type", interval.type);
    url.searchParams.set("time_from", timeFrom.toString());
    url.searchParams.set("time_to", timeTo.toString());

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": process.env.BIRDEYE_API_KEY ?? "",
        "x-chain": "solana",
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Birdeye ohlcv failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: { items?: Array<Record<string, unknown>> } | Array<unknown>;
      items?: Array<Record<string, unknown>>;
    };
    const rawItems = Array.isArray(payload.data)
      ? payload.data
      : (payload.data?.items ?? payload.items ?? []);
    const items = (rawItems as Array<Record<string, unknown>>).map((item) => ({
      t: Number(item.unixTime ?? item.t ?? item.time ?? item.timestamp ?? 0),
      o: String(item.o ?? ""),
      h: String(item.h ?? ""),
      l: String(item.l ?? ""),
      c: String(item.c ?? ""),
      v: String(item.v ?? ""),
    }));
    return items.filter((item) => item.t > 0 && item.o !== "");
  };

  const fetchRaydiumPairs = async (): Promise<
    Array<Record<string, unknown>>
  > => {
    const now = Date.now();
    if (raydiumPairsCache && now - raydiumPairsCache.ts < 60_000) {
      return raydiumPairsCache.data;
    }
    const url = new URL("/v2/main/pairs", raydiumBaseUrl);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Raydium pairs failed: ${response.status}`);
    }
    const data = (await response.json()) as Array<Record<string, unknown>>;
    raydiumPairsCache = { ts: now, data };
    return data;
  };

  const toNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const num =
      typeof value === "number"
        ? value
        : Number(typeof value === "string" ? value : "");
    return Number.isFinite(num) ? num : null;
  };

  const fetchSwitchboardFeed = async (feedId: string) => {
    const url = new URL(`/solana/mainnet/feed/${feedId}`, switchboardBaseUrl);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Switchboard feed failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
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
    name: "market.candles",
    description: "Fetch OHLCV candles for a pair.",
    schema: {
      name: "market.candles",
      description: "Fetch OHLCV candles for a pair.",
      parameters: {
        type: "object",
        properties: {
          inputMint: { type: "string" },
          outputMint: { type: "string" },
          interval: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["inputMint", "outputMint", "interval"],
        additionalProperties: false,
      },
    },
    requires: { env: ["BIRDEYE_API_KEY"] },
    execute: async (
      _ctx: ToolContext,
      input: {
        inputMint: string;
        outputMint: string;
        interval: string;
        limit?: number;
      },
    ) => {
      const candles = await fetchCandles({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        interval: input.interval,
        limit: input.limit ?? 200,
      });
      return { candles };
    },
  });

  registry.register({
    name: "market.raydium_pool_stats",
    description: "Fetch Raydium pool stats (TVL, 24h volume, fee tier).",
    schema: {
      name: "market.raydium_pool_stats",
      description: "Fetch Raydium pool stats (TVL, 24h volume, fee tier).",
      parameters: {
        type: "object",
        properties: {
          poolId: { type: "string" },
        },
        required: ["poolId"],
        additionalProperties: false,
      },
    },
    execute: async (_ctx: ToolContext, input: { poolId: string }) => {
      const poolId = input.poolId.trim();
      if (!poolId) {
        throw new Error("pool-id-required");
      }
      const pairs = await fetchRaydiumPairs();
      const pool = pairs.find(
        (item) =>
          item.ammId === poolId ||
          item.lpMint === poolId ||
          item.market === poolId ||
          item.name === poolId,
      );
      if (!pool) {
        throw new Error("raydium-pool-not-found");
      }
      const tvlUsd = toNumber(pool.liquidity);
      const volume24hUsd = toNumber(pool.volume24hQuote ?? pool.volume24h);
      const fee24hUsd = toNumber(pool.fee24hQuote ?? pool.fee24h);
      let feeTierBps = 0;
      if (volume24hUsd && fee24hUsd) {
        feeTierBps = Math.round((fee24hUsd / volume24hUsd) * 10_000);
      }
      return {
        tvlUsd: String(tvlUsd ?? 0),
        volume24hUsd: String(volume24hUsd ?? 0),
        feeTierBps,
        ts: new Date().toISOString(),
      };
    },
  });

  registry.register({
    name: "market.switchboard_price",
    description: "Fetch latest Switchboard price feed data.",
    schema: {
      name: "market.switchboard_price",
      description: "Fetch latest Switchboard price feed data.",
      parameters: {
        type: "object",
        properties: {
          feedId: { type: "string" },
        },
        required: ["feedId"],
        additionalProperties: false,
      },
    },
    execute: async (_ctx: ToolContext, input: { feedId: string }) => {
      const feedId = input.feedId.trim();
      if (!feedId) {
        throw new Error("feed-id-required");
      }
      const payload = await fetchSwitchboardFeed(feedId);
      const result =
        payload.result && typeof payload.result === "object"
          ? (payload.result as Record<string, unknown>)
          : null;
      const rawPrice =
        payload.price ??
        result?.value ??
        result?.result ??
        payload.result ??
        payload.exchange_rate ??
        null;
      const rawStddev =
        payload.stddev ??
        payload.stdDev ??
        payload.std_deviation ??
        result?.std_dev ??
        result?.stdDev ??
        result?.stddev ??
        null;
      const rawTs =
        payload.timestamp ??
        payload.ts ??
        payload.time ??
        result?.timestamp ??
        result?.ts ??
        result?.time ??
        null;

      const price = rawPrice !== null ? String(rawPrice) : "";
      const stddev = rawStddev !== null ? String(rawStddev) : "0";
      let ts = "";
      if (typeof rawTs === "number" || typeof rawTs === "string") {
        const numeric = Number(rawTs);
        if (Number.isFinite(numeric)) {
          const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
          ts = new Date(ms).toISOString();
        }
      }

      return {
        price,
        stddev,
        ts,
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
    name: "risk.max_position_check",
    description: "Enforce max position size per mint.",
    schema: {
      name: "risk.max_position_check",
      description: "Enforce max position size per mint.",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
          currentBalance: { type: "string" },
          proposedDelta: { type: "string" },
          maxPosition: { type: "string" },
        },
        required: ["mint", "currentBalance", "proposedDelta", "maxPosition"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: {
        mint: string;
        currentBalance: string;
        proposedDelta: string;
        maxPosition: string;
      },
    ) => {
      const reasons: string[] = [];
      let current: bigint;
      let delta: bigint;
      let max: bigint;
      try {
        current = BigInt(input.currentBalance);
        delta = BigInt(input.proposedDelta);
        max = BigInt(input.maxPosition);
      } catch {
        throw new Error("invalid-numeric-input");
      }
      const next = current + delta;
      if (next < 0n) {
        reasons.push("insufficient-balance");
      }
      if (delta > 0n && next > max) {
        reasons.push("max-position-exceeded");
      }
      return {
        allow: reasons.length === 0,
        reasons,
      };
    },
  });

  registry.register({
    name: "risk.daily_pnl_snapshot",
    description:
      "Compute a daily PnL snapshot from trade journal and balances.",
    schema: {
      name: "risk.daily_pnl_snapshot",
      description:
        "Compute a daily PnL snapshot from trade journal and balances.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["date"],
        additionalProperties: false,
      },
    },
    requires: { config: ["rpc.endpoint", "jupiter.apiKey"] },
    execute: async (ctx: ToolContext, input: { date: string }) => {
      const entries = await ctx.tradeJournal.read(input.date);
      const deltaByMint = new Map<string, bigint>();
      let tradeFlowValueScaled = 0n;
      for (const entry of entries) {
        if (
          entry.type !== "swap" ||
          entry.status !== "confirmed" ||
          !entry.inputMint ||
          !entry.outputMint ||
          !entry.inAmount ||
          !entry.outAmount
        ) {
          continue;
        }
        if (entry.inValueSol && entry.outValueSol) {
          try {
            const inValue = parseScaled(
              String(entry.inValueSol),
              priceDecimals,
            );
            const outValue = parseScaled(
              String(entry.outValueSol),
              priceDecimals,
            );
            if (inValue !== null && outValue !== null) {
              tradeFlowValueScaled += outValue - inValue;
              continue;
            }
          } catch {
            // fall back to price-based valuation
          }
        }
        const inputMint = String(entry.inputMint);
        const outputMint = String(entry.outputMint);
        let inAmount: bigint;
        let outAmount: bigint;
        try {
          inAmount = BigInt(String(entry.inAmount));
          outAmount = BigInt(String(entry.outAmount));
        } catch {
          continue;
        }
        deltaByMint.set(
          inputMint,
          (deltaByMint.get(inputMint) ?? 0n) - inAmount,
        );
        deltaByMint.set(
          outputMint,
          (deltaByMint.get(outputMint) ?? 0n) + outAmount,
        );
      }

      const solLamports = await ctx.solana.getSolBalanceLamports();
      const balances = await ctx.solana.getSplBalances();

      const mintDecimals = new Map<string, number>();
      mintDecimals.set(solMint, solDecimals);
      for (const token of balances) {
        mintDecimals.set(token.mint, token.decimals);
      }

      const priceMints = new Set<string>([solMint]);
      for (const token of balances) priceMints.add(token.mint);
      for (const mint of deltaByMint.keys()) priceMints.add(mint);

      const tokenInfoMap = await getTokenInfoMap(
        Array.from(priceMints).filter((mint) => mint !== solMint),
      );
      for (const [mint, info] of tokenInfoMap.entries()) {
        if (!mintDecimals.has(mint) && info) {
          mintDecimals.set(mint, info.decimals);
        }
      }

      const priceSnapshots = await mapWithConcurrency(
        Array.from(priceMints),
        4,
        async (mint) =>
          computePriceSnapshot(mint, tokenInfoMap.get(mint) ?? null),
      );

      const priceScaledMap = new Map<string, bigint | null>();
      for (const snapshot of priceSnapshots) {
        if (snapshot.mint === solMint) {
          priceScaledMap.set(snapshot.mint, 10n ** BigInt(priceDecimals));
          continue;
        }
        const value = snapshot.mid ?? snapshot.bid ?? snapshot.ask ?? undefined;
        if (!value) {
          priceScaledMap.set(snapshot.mint, null);
          continue;
        }
        priceScaledMap.set(snapshot.mint, parseScaled(value, priceDecimals));
      }

      let portfolioValueScaled = valueFromAmount(
        BigInt(solLamports),
        solDecimals,
        10n ** BigInt(priceDecimals),
      );
      for (const token of balances) {
        const priceScaled = priceScaledMap.get(token.mint);
        if (!priceScaled) continue;
        portfolioValueScaled += valueFromAmount(
          BigInt(token.amountRaw),
          token.decimals,
          priceScaled,
        );
      }

      for (const [mint, delta] of deltaByMint.entries()) {
        const decimals = mintDecimals.get(mint);
        const priceScaled = priceScaledMap.get(mint);
        if (decimals === undefined || !priceScaled) continue;
        tradeFlowValueScaled += valueFromAmount(delta, decimals, priceScaled);
      }

      const realizedPnl = formatScaled(tradeFlowValueScaled, priceDecimals);
      const net = formatScaled(portfolioValueScaled, priceDecimals);
      const unrealizedPnl = formatScaled(
        portfolioValueScaled - tradeFlowValueScaled,
        priceDecimals,
      );

      return {
        realizedPnl,
        unrealizedPnl,
        net,
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
      const tokenInfoMap = await getTokenInfoMap(
        [input.quoteResponse.inputMint, input.quoteResponse.outputMint].filter(
          (mint) => mint !== solMint,
        ),
      );
      const inputInfo = tokenInfoMap.get(input.quoteResponse.inputMint) ?? null;
      const outputInfo =
        tokenInfoMap.get(input.quoteResponse.outputMint) ?? null;

      const inputSnapshot = await computePriceSnapshot(
        input.quoteResponse.inputMint,
        inputInfo,
      );
      const outputSnapshot = await computePriceSnapshot(
        input.quoteResponse.outputMint,
        outputInfo,
      );

      const inputPrice =
        inputSnapshot.mid ?? inputSnapshot.bid ?? inputSnapshot.ask;
      const outputPrice =
        outputSnapshot.mid ?? outputSnapshot.bid ?? outputSnapshot.ask;

      let inputValueSol: string | null = null;
      let outputValueSol: string | null = null;

      try {
        const inputAmount = BigInt(input.quoteResponse.inAmount ?? "0");
        const outputAmount = BigInt(input.quoteResponse.outAmount ?? "0");
        const inputDecimals =
          input.quoteResponse.inputMint === solMint
            ? solDecimals
            : inputInfo?.decimals;
        const outputDecimals =
          input.quoteResponse.outputMint === solMint
            ? solDecimals
            : outputInfo?.decimals;
        const inputPriceScaled =
          input.quoteResponse.inputMint === solMint
            ? 10n ** BigInt(priceDecimals)
            : inputPrice
              ? parseScaled(inputPrice, priceDecimals)
              : null;
        const outputPriceScaled =
          input.quoteResponse.outputMint === solMint
            ? 10n ** BigInt(priceDecimals)
            : outputPrice
              ? parseScaled(outputPrice, priceDecimals)
              : null;
        if (inputDecimals !== undefined && inputPriceScaled) {
          inputValueSol = formatScaled(
            valueFromAmount(inputAmount, inputDecimals, inputPriceScaled),
            priceDecimals,
          );
        }
        if (outputDecimals !== undefined && outputPriceScaled) {
          outputValueSol = formatScaled(
            valueFromAmount(outputAmount, outputDecimals, outputPriceScaled),
            priceDecimals,
          );
        }
      } catch {
        inputValueSol = null;
        outputValueSol = null;
      }
      await ctx.tradeJournal.append({
        type: "swap",
        signature: result.signature,
        status: result.err ? "error" : "confirmed",
        lastValidBlockHeight: swap.lastValidBlockHeight,
        inputMint: input.quoteResponse.inputMint,
        outputMint: input.quoteResponse.outputMint,
        inAmount: input.quoteResponse.inAmount,
        outAmount: input.quoteResponse.outAmount,
        inValueSol: inputValueSol,
        outValueSol: outputValueSol,
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

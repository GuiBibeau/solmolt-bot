import type { JupiterClient, TokenInfo } from "../jupiter/client.js";

type BirdeyeCandleItem = {
  unixTime?: number | string;
  t?: number | string;
  time?: number | string;
  timestamp?: number | string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
};

type BirdeyeOhlcvResponse = {
  data?: { items?: BirdeyeCandleItem[] } | BirdeyeCandleItem[];
  items?: BirdeyeCandleItem[];
};

export type RaydiumPair = {
  ammId?: string;
  lpMint?: string;
  market?: string;
  name?: string;
  liquidity?: number | string;
  volume24hQuote?: number | string;
  volume24h?: number | string;
  fee24hQuote?: number | string;
  fee24h?: number | string;
  baseMint?: string;
  quoteMint?: string;
};

export type KalshiMarket = {
  ticker?: string;
  id?: string;
  market_ticker?: string;
  symbol?: string;
  title?: string;
  event_title?: string;
  close_time?: number | string;
  close_ts?: number | string;
  expiration_time?: number | string;
  settlement_ts?: number | string;
};

export type KalshiMarketsResponse = {
  markets?: KalshiMarket[];
};

export type KalshiOrderbookLevel = [number, number];

export type KalshiOrderbook = {
  yes?: KalshiOrderbookLevel[];
  no?: KalshiOrderbookLevel[];
};

export type KalshiOrderbookResponse = {
  orderbook?: KalshiOrderbook;
  yes?: KalshiOrderbookLevel[];
  no?: KalshiOrderbookLevel[];
};

export type SwitchboardResult = {
  value?: unknown;
  result?: unknown;
  std_dev?: unknown;
  stdDev?: unknown;
  stddev?: unknown;
  timestamp?: unknown;
  ts?: unknown;
  time?: unknown;
};

export type SwitchboardFeedResponse = {
  result?: SwitchboardResult | unknown;
  price?: unknown;
  exchange_rate?: unknown;
  stddev?: unknown;
  stdDev?: unknown;
  std_deviation?: unknown;
  timestamp?: unknown;
  ts?: unknown;
  time?: unknown;
};

export type ToolDeps = {
  jupiter: JupiterClient;
  solMint: string;
  solDecimals: number;
  priceDecimals: number;
  defaultSlippageBps: number;
  defaultSolNotional: bigint;
  getTokenInfoMap: (mints: string[]) => Promise<Map<string, TokenInfo | null>>;
  resolveVenueDexes: (
    venueInput?: string,
  ) => Promise<{ venueUsed: string; dexes?: string[] }>;
  formatScaled: (value: bigint, decimals: number) => string;
  parseScaled: (value: string, decimals: number) => bigint | null;
  valueFromAmount: (
    amountRaw: bigint,
    decimals: number,
    priceScaled: bigint,
  ) => bigint;
  mapWithConcurrency: <T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ) => Promise<R[]>;
  fetchCandles: (input: {
    inputMint: string;
    outputMint: string;
    interval: string;
    limit: number;
  }) => Promise<
    Array<{
      t: number;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
    }>
  >;
  fetchRaydiumPairs: () => Promise<RaydiumPair[]>;
  toNumber: (value: string | number | null | undefined) => number | null;
  toIsoTimestamp: (value: string | number | null | undefined) => string;
  fetchKalshiMarkets: (
    params: Record<string, string>,
  ) => Promise<KalshiMarketsResponse>;
  fetchKalshiOrderbook: (
    ticker: string,
    depth?: number,
  ) => Promise<KalshiOrderbookResponse>;
  fetchSwitchboardFeed: (feedId: string) => Promise<SwitchboardFeedResponse>;
  computePriceSnapshot: (
    mint: string,
    tokenInfo: TokenInfo | null,
    dexes?: string[],
  ) => Promise<{
    mint: string;
    bid: string | null;
    ask: string | null;
    mid: string | null;
  }>;
  formatExpo: (value: bigint, expo: number) => string;
  resolvePythFeedId: (symbol: string) => Promise<string>;
  fetchPythPrice: (feedId: string) => Promise<{
    id: string;
    price: {
      price: string | number;
      conf: string | number;
      expo: number;
      publish_time: number;
    };
  }>;
};

export function createToolDeps(jupiter: JupiterClient): ToolDeps {
  const tokenCache = new Map<string, TokenInfo | null>();
  let dexLabelCache: string[] | null = null;
  const solMint = "So11111111111111111111111111111111111111112";
  const solDecimals = 9;
  const priceDecimals = 9;
  const defaultSlippageBps = 50;
  const defaultSolNotional = 1_000_000_000n;
  const birdeyeBaseUrl = "https://public-api.birdeye.so";
  const kalshiBaseUrl = "https://api.elections.kalshi.com/trade-api/v2";
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
    data: RaydiumPair[];
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

    const payload = (await response.json()) as BirdeyeOhlcvResponse;
    const rawItems = Array.isArray(payload.data)
      ? payload.data
      : (payload.data?.items ?? payload.items ?? []);
    const items = rawItems.map((item) => ({
      t: Number(item.unixTime ?? item.t ?? item.time ?? item.timestamp ?? 0),
      o: String(item.o ?? ""),
      h: String(item.h ?? ""),
      l: String(item.l ?? ""),
      c: String(item.c ?? ""),
      v: String(item.v ?? ""),
    }));
    return items.filter((item) => item.t > 0 && item.o !== "");
  };

  const fetchRaydiumPairs = async (): Promise<RaydiumPair[]> => {
    const now = Date.now();
    if (raydiumPairsCache && now - raydiumPairsCache.ts < 60_000) {
      return raydiumPairsCache.data;
    }
    const url = new URL("/v2/main/pairs", raydiumBaseUrl);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Raydium pairs failed: ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error("Raydium pairs invalid payload");
    }
    const data = payload as RaydiumPair[];
    raydiumPairsCache = { ts: now, data };
    return data;
  };

  const toNumber = (
    value: string | number | null | undefined,
  ): number | null => {
    if (value === null || value === undefined) return null;
    const num =
      typeof value === "number"
        ? value
        : Number(typeof value === "string" ? value : "");
    return Number.isFinite(num) ? num : null;
  };

  const toIsoTimestamp = (
    value: string | number | null | undefined,
  ): string => {
    if (typeof value !== "number" && typeof value !== "string") return "";
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "";
    const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    return new Date(ms).toISOString();
  };

  const fetchKalshiMarkets = async (
    params: Record<string, string>,
  ): Promise<KalshiMarketsResponse> => {
    const url = new URL("markets", `${kalshiBaseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Kalshi markets failed: ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      throw new Error("Kalshi markets invalid payload");
    }
    return payload as KalshiMarketsResponse;
  };

  const fetchKalshiOrderbook = async (
    ticker: string,
    depth = 1,
  ): Promise<KalshiOrderbookResponse> => {
    const url = new URL(
      `markets/${encodeURIComponent(ticker)}/orderbook`,
      `${kalshiBaseUrl}/`,
    );
    url.searchParams.set("depth", depth.toString());
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Kalshi orderbook failed: ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      throw new Error("Kalshi orderbook invalid payload");
    }
    return payload as KalshiOrderbookResponse;
  };

  const fetchSwitchboardFeed = async (
    feedId: string,
  ): Promise<SwitchboardFeedResponse> => {
    const url = new URL(`/solana/mainnet/feed/${feedId}`, switchboardBaseUrl);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Switchboard feed failed: ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      throw new Error("Switchboard feed invalid payload");
    }
    return payload as SwitchboardFeedResponse;
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

  return {
    jupiter,
    solMint,
    solDecimals,
    priceDecimals,
    defaultSlippageBps,
    defaultSolNotional,
    getTokenInfoMap,
    resolveVenueDexes,
    formatScaled,
    parseScaled,
    valueFromAmount,
    mapWithConcurrency,
    fetchCandles,
    fetchRaydiumPairs,
    toNumber,
    toIsoTimestamp,
    fetchKalshiMarkets,
    fetchKalshiOrderbook,
    fetchSwitchboardFeed,
    computePriceSnapshot,
    formatExpo,
    resolvePythFeedId,
    fetchPythPrice,
  };
}

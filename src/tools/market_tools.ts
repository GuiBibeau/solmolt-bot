import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Client as PhoenixClient } from "@ellipsis-labs/phoenix-sdk";
import {
  Market as OpenBookMarket,
  OpenBookV2Client,
} from "@openbook-dex/openbook-v2";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { ToolContext, ToolRegistry } from "./registry.js";
import type {
  KalshiOrderbook,
  KalshiOrderbookLevel,
  SwitchboardResult,
  ToolDeps,
} from "./tool_deps.js";

export function registerMarketTools(
  registry: ToolRegistry,
  deps: ToolDeps,
): void {
  const {
    jupiter,
    solMint,
    defaultSlippageBps,
    fetchCandles,
    fetchKalshiMarkets,
    fetchKalshiOrderbook,
    fetchRaydiumPairs,
    fetchOrcaWhirlpools,
    fetchSwitchboardFeed,
    resolvePythFeedId,
    fetchPythPrice,
    formatExpo,
    toIsoTimestamp,
    toNumber,
    getTokenInfoMap,
    mapWithConcurrency,
    computePriceSnapshot,
    resolveVenueDexes,
  } = deps;

  const buildConnection = (ctx: ToolContext): Connection =>
    new Connection(ctx.config.rpc.endpoint, "confirmed");

  const toStringOrEmpty = (value: number | null | undefined): string =>
    value === null || value === undefined ? "" : String(value);

  const fetchPhoenixTopOfBook = async (
    connection: Connection,
    market: string,
  ): Promise<{
    bid: number | null;
    ask: number | null;
    bidSize: number | null;
    askSize: number | null;
  }> => {
    const marketKey = new PublicKey(market);
    const client = await PhoenixClient.createWithoutConfig(connection, [
      marketKey,
    ]);
    const ladder = client.getUiLadder(marketKey.toString(), 1);
    const bid = ladder.bids[0];
    const ask = ladder.asks[0];
    return {
      bid: bid?.price ?? null,
      ask: ask?.price ?? null,
      bidSize: bid?.quantity ?? null,
      askSize: ask?.quantity ?? null,
    };
  };

  const fetchOpenBookTopOfBook = async (
    connection: Connection,
    market: string,
  ): Promise<{
    bid: number | null;
    ask: number | null;
    bidSize: number | null;
    askSize: number | null;
  }> => {
    const wallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    const client = new OpenBookV2Client(provider);
    const marketKey = new PublicKey(market);
    const marketAccount = await OpenBookMarket.load(client, marketKey);
    await marketAccount.loadOrderBook();
    const bestBid = marketAccount.bids?.best();
    const bestAsk = marketAccount.asks?.best();
    return {
      bid: bestBid?.price ?? null,
      ask: bestAsk?.price ?? null,
      bidSize: bestBid?.size ?? null,
      askSize: bestAsk?.size ?? null,
    };
  };

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
    name: "market.prediction_markets_list",
    description: "List active prediction markets for a venue.",
    schema: {
      name: "market.prediction_markets_list",
      description: "List active prediction markets for a venue.",
      parameters: {
        type: "object",
        properties: {
          venue: { type: "string" },
        },
        required: ["venue"],
        additionalProperties: false,
      },
    },
    execute: async (_ctx: ToolContext, input: { venue: string }) => {
      const venue = input.venue.trim().toLowerCase();
      if (venue !== "kalshi") {
        throw new Error("unsupported-venue");
      }
      const payload = await fetchKalshiMarkets({
        limit: "50",
        status: "open",
      });
      const markets = payload.markets ?? [];
      return {
        markets: markets.map((market) => ({
          id: String(
            market.ticker ??
              market.id ??
              market.market_ticker ??
              market.symbol ??
              "",
          ),
          title: String(market.title ?? market.event_title ?? ""),
          endTime: toIsoTimestamp(
            market.close_time ??
              market.close_ts ??
              market.expiration_time ??
              market.settlement_ts ??
              "",
          ),
        })),
      };
    },
  });

  registry.register({
    name: "market.prediction_market_quote",
    description: "Fetch quote/odds snapshot for a prediction market.",
    schema: {
      name: "market.prediction_market_quote",
      description: "Fetch quote/odds snapshot for a prediction market.",
      parameters: {
        type: "object",
        properties: {
          venue: { type: "string" },
          marketId: { type: "string" },
        },
        required: ["venue", "marketId"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: { venue: string; marketId: string },
    ) => {
      const venue = input.venue.trim().toLowerCase();
      if (venue !== "kalshi") {
        throw new Error("unsupported-venue");
      }
      const ticker = input.marketId.trim();
      if (!ticker) {
        throw new Error("market-id-required");
      }
      const payload = await fetchKalshiOrderbook(ticker, 1);
      const orderbook: KalshiOrderbook = payload.orderbook ?? payload;
      const yesLevels: KalshiOrderbookLevel[] = orderbook.yes ?? [];
      const noLevels: KalshiOrderbookLevel[] = orderbook.no ?? [];
      const yesPrice = yesLevels[0]?.[0];
      const noPrice = noLevels[0]?.[0];
      const liquidity = (yesLevels[0]?.[1] ?? 0) + (noLevels[0]?.[1] ?? 0);
      return {
        yesPrice: yesPrice !== undefined ? String(yesPrice) : "",
        noPrice: noPrice !== undefined ? String(noPrice) : "",
        liquidity: String(liquidity),
        ts: new Date().toISOString(),
      };
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
    name: "market.orca_pool_stats",
    description: "Fetch Orca pool stats (TVL, 24h volume, fee tier).",
    schema: {
      name: "market.orca_pool_stats",
      description: "Fetch Orca pool stats (TVL, 24h volume, fee tier).",
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
      const pools = await fetchOrcaWhirlpools();
      const pool = pools.find((item) => item.address === poolId);
      if (!pool) {
        throw new Error("orca-pool-not-found");
      }
      const tvlUsd = toNumber(pool.tvl);
      const volume24hUsd = toNumber(pool.volume?.day);
      const feeRate = toNumber(pool.lpFeeRate);
      const feeTierBps = feeRate ? Math.round(feeRate * 10_000) : 0;
      return {
        tvlUsd: String(tvlUsd ?? 0),
        volume24hUsd: String(volume24hUsd ?? 0),
        feeTierBps,
        ts: new Date().toISOString(),
      };
    },
  });

  registry.register({
    name: "market.orderbook_snapshot",
    description: "Fetch top-of-book snapshot for a Phoenix/OpenBook market.",
    schema: {
      name: "market.orderbook_snapshot",
      description: "Fetch top-of-book snapshot for a Phoenix/OpenBook market.",
      parameters: {
        type: "object",
        properties: {
          venue: { type: "string" },
          market: { type: "string" },
        },
        required: ["venue", "market"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { venue: string; market: string },
    ) => {
      const venue = input.venue.trim().toLowerCase();
      const market = input.market.trim();
      if (!venue) {
        throw new Error("venue-required");
      }
      if (!market) {
        throw new Error("market-required");
      }
      const connection = buildConnection(ctx);
      let snapshot: {
        bid: number | null;
        ask: number | null;
        bidSize: number | null;
        askSize: number | null;
      };
      if (venue === "phoenix") {
        snapshot = await fetchPhoenixTopOfBook(connection, market);
      } else if (venue === "openbook") {
        snapshot = await fetchOpenBookTopOfBook(connection, market);
      } else {
        throw new Error("unsupported-venue");
      }
      return {
        bid: toStringOrEmpty(snapshot.bid),
        ask: toStringOrEmpty(snapshot.ask),
        bidSize: toStringOrEmpty(snapshot.bidSize),
        askSize: toStringOrEmpty(snapshot.askSize),
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
          ? (payload.result as SwitchboardResult)
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
    name: "market.liquidity_by_mint",
    description: "Aggregate liquidity across top pools for a mint.",
    schema: {
      name: "market.liquidity_by_mint",
      description: "Aggregate liquidity across top pools for a mint.",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
        },
        required: ["mint"],
        additionalProperties: false,
      },
    },
    execute: async (_ctx: ToolContext, input: { mint: string }) => {
      const mint = input.mint.trim();
      if (!mint) {
        throw new Error("mint-required");
      }
      const pairs = await fetchRaydiumPairs();
      const matching = pairs.filter(
        (item) => item.baseMint === mint || item.quoteMint === mint,
      );
      const pools = matching
        .map((item) => {
          const tvl = toNumber(item.liquidity);
          return {
            venue: "raydium",
            poolId: String(item.ammId ?? item.lpMint ?? ""),
            tvlUsd: String(tvl ?? 0),
            tvlValue: tvl ?? 0,
          };
        })
        .filter((pool) => pool.poolId)
        .sort((a, b) => b.tvlValue - a.tvlValue);

      const topPools = pools.slice(0, 10).map(({ tvlValue, ...rest }) => rest);
      const totalTvl = pools
        .slice(0, 10)
        .reduce((sum, pool) => sum + pool.tvlValue, 0);

      return {
        totalTvlUsd: String(totalTvl),
        pools: topPools,
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
}

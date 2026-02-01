import { expect, test } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import type { RalphConfig } from "../../src/config/config.js";
import { SessionJournal, TradeJournal } from "../../src/journal/index.js";
import { JupiterClient } from "../../src/jupiter/client.js";
import { createSolanaAdapter } from "../../src/solana/index.js";
import { loadSecretKey } from "../../src/solana/keys.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerDefaultTools } from "../../src/tools/tools.js";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "1";
const runSwapSim = process.env.RUN_SWAP_SIM === "1";
const requestAirdrop = process.env.AIRDROP === "1";

const integrationTest = runIntegration ? test : test.skip;
const swapTest = runIntegration && runSwapSim ? test : test.skip;

function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("429");
}

function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("401") ||
    message.toLowerCase().includes("unauthorized") ||
    message.toLowerCase().includes("invalid api key")
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function buildConfig(): RalphConfig {
  return {
    rpc: {
      endpoint: requireEnv("RPC_ENDPOINT"),
    },
    wallet: {
      privateKey: process.env.WALLET_PRIVATE_KEY,
      keyfilePath: process.env.WALLET_KEYFILE,
    },
    jupiter: {
      apiKey: requireEnv("JUPITER_API_KEY"),
      baseUrl: process.env.JUPITER_BASE_URL || "https://api.jup.ag",
    },
    solana: {
      sdkMode: "web3",
    },
    llm: {
      provider: "openai_chat",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "test",
      model: "glm-4.7",
    },
    autopilot: {
      enabled: false,
      intervalMs: 15000,
    },
    gateway: {
      bind: "127.0.0.1",
      port: 8787,
      authToken: "test",
    },
    tools: {
      skillsDir: "skills",
    },
    openclaw: {},
    notify: {},
    policy: {
      killSwitch: false,
      allowedMints: [],
      maxTradeAmountLamports: "0",
      maxSlippageBps: 50,
      maxPriceImpactPct: 5,
      cooldownSeconds: 0,
    },
  };
}

function setup() {
  const config = buildConfig();
  const solana = createSolanaAdapter(config);
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    config.jupiter.baseUrl,
    config.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config,
    solana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  return { registry, ctx, jupiter, config };
}

integrationTest("wallet.get_balances (integration)", async () => {
  const { registry, ctx } = setup();
  let result:
    | {
        solLamports: string;
        tokens: Array<{ mint: string }>;
      }
    | undefined;
  try {
    result = (await registry.invoke("wallet.get_balances", ctx, {})) as {
      solLamports: string;
      tokens: Array<{ mint: string }>;
    };
  } catch (err) {
    if (isAuthError(err)) {
      return;
    }
    throw err;
  }
  expect(typeof result.solLamports).toBe("string");
  expect(Array.isArray(result.tokens)).toBe(true);
});

integrationTest("market.jupiter_quote (integration)", async () => {
  const { registry, ctx } = setup();
  const inputMint =
    process.env.QUOTE_INPUT_MINT ||
    "So11111111111111111111111111111111111111112";
  const outputMint =
    process.env.QUOTE_OUTPUT_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const amount = process.env.QUOTE_AMOUNT || "1000000";
  const slippageBps = Number(process.env.QUOTE_SLIPPAGE_BPS || "50");

  const result = (await registry.invoke("market.jupiter_quote", ctx, {
    inputMint,
    outputMint,
    amount,
    slippageBps,
  })) as { summary: { inAmount: string; outAmount: string } };

  expect(result.summary.inAmount).toBeTruthy();
  expect(result.summary.outAmount).toBeTruthy();
});

integrationTest("market.jupiter_route_map (integration)", async () => {
  const { registry, ctx } = setup();
  const inputMint =
    process.env.ROUTE_INPUT_MINT ||
    "So11111111111111111111111111111111111111112";
  const outputMint =
    process.env.ROUTE_OUTPUT_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const amount = process.env.ROUTE_AMOUNT || "1000000";

  const result = (await registry.invoke("market.jupiter_route_map", ctx, {
    inputMint,
    outputMint,
    amount,
  })) as { routes: Array<{ label: string; outAmount: string }> };

  expect(result.routes.length).toBeGreaterThan(0);
  expect(result.routes[0].label).toBeTruthy();
  expect(result.routes[0].outAmount).toBeTruthy();
});

integrationTest("market.pyth_price (integration)", async () => {
  const { registry, ctx } = setup();
  const symbol = process.env.PYTH_SYMBOL || "SOL/USD";

  const result = (await registry.invoke("market.pyth_price", ctx, {
    symbol,
  })) as { price: string; confidence: string; publishTime: string };

  expect(result.price).toBeTruthy();
  expect(result.confidence).toBeTruthy();
  expect(result.publishTime).toBeTruthy();
});

integrationTest("market.candles (integration)", async () => {
  if (!process.env.BIRDEYE_API_KEY) {
    return;
  }
  const { registry, ctx } = setup();
  const inputMint =
    process.env.CANDLES_INPUT_MINT ||
    "So11111111111111111111111111111111111111112";
  const outputMint =
    process.env.CANDLES_OUTPUT_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const result = (await registry.invoke("market.candles", ctx, {
    inputMint,
    outputMint,
    interval: process.env.CANDLES_INTERVAL || "1m",
    limit: Number(process.env.CANDLES_LIMIT || "5"),
  })) as { candles: Array<{ t: number; o: string; c: string }> };

  expect(result.candles.length).toBeGreaterThan(0);
  expect(result.candles[0].t).toBeTruthy();
  expect(result.candles[0].o).toBeTruthy();
  expect(result.candles[0].c).toBeTruthy();
});

integrationTest("market.prediction_markets_list (integration)", async () => {
  if (!process.env.KALSHI_MARKETS_TEST) {
    return;
  }
  const { registry, ctx } = setup();

  const result = (await registry.invoke("market.prediction_markets_list", ctx, {
    venue: "kalshi",
  })) as { markets: Array<{ id: string; title: string }> };

  expect(Array.isArray(result.markets)).toBe(true);
});

integrationTest("market.prediction_market_quote (integration)", async () => {
  if (!process.env.KALSHI_MARKET_ID) {
    return;
  }
  const { registry, ctx } = setup();
  const marketId = process.env.KALSHI_MARKET_ID;

  const result = (await registry.invoke("market.prediction_market_quote", ctx, {
    venue: "kalshi",
    marketId,
  })) as { yesPrice: string; noPrice: string; liquidity: string; ts: string };

  expect(result.yesPrice).toBeTruthy();
  expect(result.noPrice).toBeTruthy();
  expect(result.ts).toBeTruthy();
});

integrationTest("market.raydium_pool_stats (integration)", async () => {
  if (!process.env.RAYDIUM_POOL_ID) {
    return;
  }
  const { registry, ctx } = setup();
  const poolId =
    process.env.RAYDIUM_POOL_ID ||
    "2EXiumdi14E9b8Fy62QcA5Uh6WdHS2b38wtSxp72Mibj";

  const result = (await registry.invoke("market.raydium_pool_stats", ctx, {
    poolId,
  })) as { tvlUsd: string; volume24hUsd: string; feeTierBps: number };

  expect(result.tvlUsd).toBeTruthy();
  expect(result.volume24hUsd).toBeTruthy();
  expect(Number.isFinite(result.feeTierBps)).toBe(true);
});

integrationTest("market.switchboard_price (integration)", async () => {
  if (!process.env.SWITCHBOARD_FEED_ID) {
    return;
  }
  const { registry, ctx } = setup();
  const feedId = process.env.SWITCHBOARD_FEED_ID;

  const result = (await registry.invoke("market.switchboard_price", ctx, {
    feedId,
  })) as { price: string; stddev: string; ts: string };

  expect(result.price).toBeTruthy();
  expect(result.stddev).toBeTruthy();
  expect(result.ts).toBeTruthy();
});

integrationTest("market.liquidity_by_mint (integration)", async () => {
  if (!process.env.LIQUIDITY_MINT) {
    return;
  }
  const { registry, ctx } = setup();
  const mint =
    process.env.LIQUIDITY_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const result = (await registry.invoke("market.liquidity_by_mint", ctx, {
    mint,
  })) as {
    totalTvlUsd: string;
    pools: Array<{ venue: string; poolId: string; tvlUsd: string }>;
  };

  expect(result.totalTvlUsd).toBeTruthy();
  expect(Array.isArray(result.pools)).toBe(true);
});

integrationTest("risk.daily_pnl_snapshot (integration)", async () => {
  const { registry, ctx } = setup();
  const date = new Date().toISOString().slice(0, 10);

  let result:
    | { realizedPnl: string; unrealizedPnl: string; net: string }
    | undefined;
  try {
    result = (await registry.invoke("risk.daily_pnl_snapshot", ctx, {
      date,
    })) as { realizedPnl: string; unrealizedPnl: string; net: string };
  } catch (err) {
    if (isAuthError(err)) {
      return;
    }
    throw err;
  }

  expect(result.realizedPnl).toBeTruthy();
  expect(result.unrealizedPnl).toBeTruthy();
  expect(result.net).toBeTruthy();
});

integrationTest("market.get_prices (integration)", async () => {
  const { registry, ctx } = setup();
  const priceMint =
    process.env.PRICE_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  let result:
    | {
        prices: Array<{ mint: string; bid: string | null; ask: string | null }>;
      }
    | undefined;
  try {
    result = (await registry.invoke("market.get_prices", ctx, {
      mints: [priceMint],
      venue: "best",
    })) as {
      prices: Array<{ mint: string; bid: string | null; ask: string | null }>;
    };
  } catch (err) {
    if (isRateLimitError(err)) {
      return;
    }
    throw err;
  }

  expect(result.prices.length).toBe(1);
  expect(result.prices[0].mint).toBe(priceMint);
});

integrationTest("market.token_metadata (integration)", async () => {
  const { registry, ctx } = setup();
  const mint =
    process.env.METADATA_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  let result: { symbol: string; decimals: number } | undefined;
  try {
    result = (await registry.invoke("market.token_metadata", ctx, {
      mint,
    })) as { symbol: string; decimals: number };
  } catch (err) {
    if (isRateLimitError(err)) {
      return;
    }
    throw err;
  }

  expect(result.symbol).toBeTruthy();
  expect(Number.isFinite(result.decimals)).toBe(true);
});

swapTest("swap simulation (build + sign + simulate)", async () => {
  const { registry, ctx, jupiter, config } = setup();
  if (!config.wallet.privateKey && !config.wallet.keyfilePath) {
    throw new Error(
      "WALLET_PRIVATE_KEY or WALLET_KEYFILE required for swap simulation",
    );
  }

  if (!ctx.solana.simulateRawTx) {
    throw new Error("simulateRawTx not supported by adapter");
  }

  if (requestAirdrop) {
    const secretKey = loadSecretKey(
      config.wallet.privateKey,
      config.wallet.keyfilePath,
    );
    const keypair = Keypair.fromSecretKey(secretKey);
    const conn = new Connection(config.rpc.endpoint, "confirmed");
    const sig = await conn.requestAirdrop(keypair.publicKey, 2_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }

  const inputMint =
    process.env.SWAP_INPUT_MINT ||
    "So11111111111111111111111111111111111111112";
  const outputMint =
    process.env.SWAP_OUTPUT_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const amount = process.env.SWAP_AMOUNT || "1000000";
  const slippageBps = Number(process.env.SWAP_SLIPPAGE_BPS || "50");

  const quote = (await registry.invoke("market.jupiter_quote", ctx, {
    inputMint,
    outputMint,
    amount,
    slippageBps,
  })) as { quoteResponse: Record<string, unknown> };

  const swap = await jupiter.swap({
    quoteResponse: quote.quoteResponse,
    userPublicKey: ctx.solana.getPublicKey(),
  });

  const rawTx = Buffer.from(swap.swapTransaction, "base64");
  const signed = await ctx.solana.signRawTransaction(rawTx);
  const simulation = (await ctx.solana.simulateRawTx(signed)) as
    | { err?: unknown; logs?: string[] | null }
    | undefined;

  if (simulation?.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.err)}`);
  }
  expect(simulation).toBeTruthy();
});

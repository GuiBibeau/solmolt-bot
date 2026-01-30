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
  const result = (await registry.invoke("wallet.get_balances", ctx, {})) as {
    solLamports: string;
    tokens: Array<{ mint: string }>;
  };
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

integrationTest("market.get_prices (integration)", async () => {
  const { registry, ctx } = setup();
  const priceMint =
    process.env.PRICE_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const result = (await registry.invoke("market.get_prices", ctx, {
    mints: [priceMint],
    venue: "best",
  })) as {
    prices: Array<{ mint: string; bid: string | null; ask: string | null }>;
  };

  expect(result.prices.length).toBe(1);
  expect(result.prices[0].mint).toBe(priceMint);
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

import { expect, test } from "bun:test";
import type { RalphConfig } from "../../src/config/config.js";
import { SessionJournal, TradeJournal } from "../../src/journal/index.js";
import { JupiterClient } from "../../src/jupiter/client.js";
import type { SolanaAdapter } from "../../src/solana/adapter.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerDefaultTools } from "../../src/tools/tools.js";

const stubConfig: RalphConfig = {
  rpc: { endpoint: "http://localhost:8899" },
  wallet: {},
  jupiter: { apiKey: "test", baseUrl: "https://api.jup.ag" },
  solana: { sdkMode: "web3" },
  llm: {
    provider: "openai_chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKey: "test",
    model: "glm-4.7",
  },
  autopilot: { enabled: false, intervalMs: 15000 },
  gateway: { bind: "127.0.0.1", port: 8787, authToken: "test" },
  tools: { skillsDir: "skills" },
  notify: {},
  policy: {
    killSwitch: false,
    allowedMints: [],
    maxTradeAmountLamports: "0",
    maxSlippageBps: 50,
    maxPriceImpactPct: 1,
    cooldownSeconds: 30,
  },
};

const stubSolana: SolanaAdapter = {
  getPublicKey: () => "11111111111111111111111111111111",
  getSolBalanceLamports: async () => "0",
  getSplBalances: async () => [],
  getLatestBlockhash: async () => ({
    blockhash: "111",
    lastValidBlockHeight: 0,
  }),
  signRawTransaction: async (tx) => tx,
  sendAndConfirmRawTx: async () => ({ signature: "sig" }),
};

test("invalid quote args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.jupiter_quote", ctx, {
      inputMint: "",
      outputMint: "",
      amount: "abc",
      slippageBps: -1,
    }),
  ).rejects.toThrow(/validation/i);
});

test("invalid market.jupiter_route_map args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.jupiter_route_map", ctx, {
      inputMint: "",
      outputMint: "",
      amount: "abc",
    }),
  ).rejects.toThrow(/validation/i);
});

test("invalid market.pyth_price args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(registry.invoke("market.pyth_price", ctx, {})).rejects.toThrow(
    /validation/i,
  );
});

test("invalid risk.max_position_check args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("risk.max_position_check", ctx, {
      mint: "",
      currentBalance: "abc",
      proposedDelta: "1",
      maxPosition: "10",
    }),
  ).rejects.toThrow(/validation/i);
});

test("invalid risk.daily_pnl_snapshot args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("risk.daily_pnl_snapshot", ctx, { date: "bad" }),
  ).rejects.toThrow(/validation/i);
});

test("invalid market.candles args are rejected before execution", async () => {
  process.env.BIRDEYE_API_KEY = "test";
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.candles", ctx, {
      inputMint: "",
      outputMint: "",
      interval: "",
      limit: -1,
    }),
  ).rejects.toThrow(/validation/i);
});

test("invalid market.raydium_pool_stats args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.raydium_pool_stats", ctx, { poolId: "" }),
  ).rejects.toThrow(/validation/i);
});

test("invalid market.switchboard_price args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.switchboard_price", ctx, { feedId: "" }),
  ).rejects.toThrow(/validation/i);
});

test("invalid market.get_prices args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.get_prices", ctx, { mints: [] }),
  ).rejects.toThrow(/validation/i);
});

test("risk.max_position_check enforces limits", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  const allow = (await registry.invoke("risk.max_position_check", ctx, {
    mint: "So11111111111111111111111111111111111111112",
    currentBalance: "5",
    proposedDelta: "2",
    maxPosition: "10",
  })) as { allow: boolean; reasons: string[] };
  expect(allow.allow).toBe(true);
  expect(allow.reasons.length).toBe(0);

  const deny = (await registry.invoke("risk.max_position_check", ctx, {
    mint: "So11111111111111111111111111111111111111112",
    currentBalance: "5",
    proposedDelta: "10",
    maxPosition: "10",
  })) as { allow: boolean; reasons: string[] };
  expect(deny.allow).toBe(false);
  expect(deny.reasons).toContain("max-position-exceeded");

  const reduce = (await registry.invoke("risk.max_position_check", ctx, {
    mint: "So11111111111111111111111111111111111111112",
    currentBalance: "100",
    proposedDelta: "-10",
    maxPosition: "50",
  })) as { allow: boolean; reasons: string[] };
  expect(reduce.allow).toBe(true);
  expect(reduce.reasons.length).toBe(0);
});

test("invalid market.token_metadata args are rejected before execution", async () => {
  const registry = new ToolRegistry();
  const jupiter = new JupiterClient(
    stubConfig.jupiter.baseUrl,
    stubConfig.jupiter.apiKey,
  );
  registerDefaultTools(registry, jupiter);

  const ctx = {
    config: stubConfig,
    solana: stubSolana,
    sessionJournal: new SessionJournal("test", ".tmp/sessions"),
    tradeJournal: new TradeJournal(".tmp/trades"),
  };

  await expect(
    registry.invoke("market.token_metadata", ctx, { mint: "" }),
  ).rejects.toThrow(/validation/i);
});

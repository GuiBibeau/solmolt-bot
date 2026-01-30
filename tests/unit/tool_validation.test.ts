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

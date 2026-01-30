import { expect, test } from "bun:test";
import { evaluateTrade } from "../../src/policy/index.js";

const basePolicy = {
  killSwitch: false,
  allowedMints: [],
  maxTradeAmountLamports: "0",
  maxSlippageBps: 50,
  maxPriceImpactPct: 1,
  cooldownSeconds: 30,
};

const baseQuote = {
  inAmount: "100",
  outAmount: "90",
  priceImpactPct: 0.1,
  routeLabels: ["test"],
};

const baseBalances = {
  solLamports: "1000",
  tokens: [],
};

test("kill switch blocks trade", () => {
  const result = evaluateTrade(
    { ...basePolicy, killSwitch: true },
    baseQuote,
    baseBalances,
  );
  expect(result.allow).toBe(false);
  expect(result.reasons).toContain("kill-switch-enabled");
});

test("price impact block", () => {
  const result = evaluateTrade(
    { ...basePolicy, maxPriceImpactPct: 0.01 },
    baseQuote,
    baseBalances,
  );
  expect(result.allow).toBe(false);
  expect(result.reasons).toContain("price-impact-too-high");
});

test("mint allowlist enforced", () => {
  const balances = {
    solLamports: "1000",
    tokens: [{ mint: "MINT1", amountRaw: "1", decimals: 6, uiAmount: 1 }],
  };
  const result = evaluateTrade(
    { ...basePolicy, allowedMints: ["OTHER"] },
    baseQuote,
    balances,
  );
  expect(result.allow).toBe(false);
  expect(result.reasons).toContain("mint-not-allowed");
});

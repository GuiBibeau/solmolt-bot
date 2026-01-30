import type {
  BalancesSnapshot,
  PolicySnapshot,
  QuoteSummary,
} from "../tools/types.js";

export type RiskResult = {
  allow: boolean;
  reasons: string[];
  adjustments?: { slippageBps?: number; maxAmount?: string };
};

export function evaluateTrade(
  policy: PolicySnapshot,
  quoteSummary: QuoteSummary,
  balances: BalancesSnapshot,
): RiskResult {
  const reasons: string[] = [];
  if (policy.killSwitch) {
    reasons.push("kill-switch-enabled");
  }

  if (quoteSummary.priceImpactPct > policy.maxPriceImpactPct) {
    reasons.push("price-impact-too-high");
  }

  if (policy.allowedMints.length > 0) {
    const allow = new Set(policy.allowedMints);
    const tokens = balances.tokens.map((token) => token.mint);
    for (const mint of tokens) {
      if (!allow.has(mint)) {
        reasons.push("mint-not-allowed");
        break;
      }
    }
  }

  if (policy.maxSlippageBps <= 0) {
    reasons.push("slippage-bps-invalid");
  }

  const allowTrade = reasons.length === 0;
  const adjustments = allowTrade
    ? { slippageBps: policy.maxSlippageBps }
    : undefined;

  return { allow: allowTrade, reasons, adjustments };
}

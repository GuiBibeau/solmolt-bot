import type { JupiterQuoteResponse } from "./jupiter";
import type { LoopPolicy } from "./types";

export type NormalizedPolicy = {
  killSwitch: boolean;
  allowedMints: string[];
  maxTradeAmountAtomic: string; // "0" means unlimited
  maxPriceImpactPct: number;
  slippageBps: number;
  dryRun: boolean;
  skipPreflight: boolean;
  commitment: "processed" | "confirmed" | "finalized";
  minSolReserveLamports: string;
};

export function normalizePolicy(
  policy: LoopPolicy | undefined,
): NormalizedPolicy {
  const allowedMints = Array.isArray(policy?.allowedMints)
    ? policy?.allowedMints.filter((m): m is string => typeof m === "string")
    : [];

  const maxPriceImpactPctRaw = policy?.maxPriceImpactPct;
  const maxPriceImpactPct =
    typeof maxPriceImpactPctRaw === "number" &&
    Number.isFinite(maxPriceImpactPctRaw)
      ? maxPriceImpactPctRaw
      : 0.02;

  const slippageBpsRaw = policy?.slippageBps;
  const slippageBps =
    typeof slippageBpsRaw === "number" && Number.isFinite(slippageBpsRaw)
      ? Math.max(0, Math.floor(slippageBpsRaw))
      : 50;

  const commitmentRaw = policy?.commitment;
  const commitment =
    commitmentRaw === "processed" ||
    commitmentRaw === "confirmed" ||
    commitmentRaw === "finalized"
      ? commitmentRaw
      : "confirmed";

  return {
    killSwitch: Boolean(policy?.killSwitch),
    allowedMints,
    maxTradeAmountAtomic:
      typeof policy?.maxTradeAmountAtomic === "string"
        ? policy.maxTradeAmountAtomic
        : "0",
    maxPriceImpactPct,
    slippageBps,
    dryRun: Boolean(policy?.dryRun),
    skipPreflight: Boolean(policy?.skipPreflight),
    commitment,
    minSolReserveLamports:
      typeof policy?.minSolReserveLamports === "string"
        ? policy.minSolReserveLamports
        : "50000000",
  };
}

export function enforcePolicy(
  policy: NormalizedPolicy,
  quoteResponse: JupiterQuoteResponse,
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
  if (policy.maxTradeAmountAtomic !== "0" && inAmount) {
    if (BigInt(inAmount) > BigInt(policy.maxTradeAmountAtomic)) {
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

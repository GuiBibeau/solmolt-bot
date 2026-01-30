export type QuoteSummary = {
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routeLabels: string[];
};

export type BalancesSnapshot = {
  solLamports: string;
  tokens: { mint: string; amountRaw: string; decimals: number; uiAmount: number | null }[];
};

export type PolicySnapshot = {
  killSwitch: boolean;
  allowedMints: string[];
  maxTradeAmountLamports: string;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  cooldownSeconds: number;
  dailySpendCapLamports?: string;
};

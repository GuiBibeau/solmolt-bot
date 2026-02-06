export type LoopConfig = {
  enabled: boolean;
  policy?: LoopPolicy;
  strategy?: StrategyConfig;
  updatedAt?: string;
};

export type LoopPolicy = {
  killSwitch?: boolean;
  allowedMints?: string[];
  // "0" means unlimited.
  maxTradeAmountAtomic?: string;
  maxPriceImpactPct?: number;
  slippageBps?: number;
  dryRun?: boolean;
  skipPreflight?: boolean;
  commitment?: "processed" | "confirmed" | "finalized";
  // Keep some SOL to pay fees / rent; expressed in lamports.
  minSolReserveLamports?: string;
};

export type DcaStrategy = {
  type: "dca";
  inputMint: string;
  outputMint: string;
  // Atomic units of the input mint (e.g. lamports for SOL, micro for USDC).
  amount: string;
  // Minimum time between executions.
  everyMinutes?: number;
};

export type RebalanceStrategy = {
  type: "rebalance";
  // For now, designed primarily for SOL/USDC but works for any pair that has Jupiter routes.
  baseMint: string;
  quoteMint: string;
  targetBasePct: number; // 0..1
  thresholdPct?: number; // 0..1
  // Caps expressed in atomic units of the respective input mint.
  maxSellBaseAmount?: string;
  maxBuyQuoteAmount?: string;
};

export type StrategyConfig = { type: "noop" } | DcaStrategy | RebalanceStrategy;

export type LoopState = {
  dca?: {
    lastAt?: string;
  };
};

export type Env = {
  WAITLIST_DB: D1Database;
  CONFIG_KV: KVNamespace;
  // Optional while R2 is not enabled on the account; logs will fall back to console only.
  LOGS_BUCKET?: R2Bucket;
  ADMIN_TOKEN?: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  PRIVY_WALLET_ID?: string;
  // Used for local/mainnet dry-runs so you can test quoting + policy without Privy.
  // Must be a valid base58 Solana pubkey string.
  DRYRUN_WALLET_ADDRESS?: string;
  RPC_ENDPOINT?: string;
  JUPITER_BASE_URL?: string;
  JUPITER_API_KEY?: string;
  TENANT_ID?: string;
  LOOP_ENABLED_DEFAULT?: string;
  ALLOWED_ORIGINS?: string;
};

export type LoopConfig = {
  enabled: boolean;
  policy?: Record<string, unknown>;
  updatedAt?: string;
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
  LOOP_ENABLED_DEFAULT?: string;
  ALLOWED_ORIGINS?: string;
};

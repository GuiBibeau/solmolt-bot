export type TokenBalance = {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number | null;
};

export type ConfirmParams = {
  commitment?: "processed" | "confirmed" | "finalized";
  timeoutMs?: number;
  pollIntervalMs?: number;
};

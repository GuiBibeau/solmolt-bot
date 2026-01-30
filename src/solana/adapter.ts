import type { ConfirmParams, TokenBalance } from './types.js';

export type SendResult = {
  signature: string;
  slot?: number;
  err?: unknown;
};

export interface SolanaAdapter {
  getPublicKey(): string;
  getSolBalanceLamports(): Promise<string>;
  getSplBalances(mints?: string[]): Promise<TokenBalance[]>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  signRawTransaction(serializedTx: Uint8Array): Promise<Uint8Array>;
  sendAndConfirmRawTx(serializedTx: Uint8Array, confirm?: ConfirmParams): Promise<SendResult>;
  simulateRawTx?(serializedTx: Uint8Array): Promise<unknown>;
}

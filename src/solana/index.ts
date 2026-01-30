import type { SolmoltConfig } from '../config/config.js';
import type { SolanaAdapter } from './adapter.js';
import { Web3Adapter } from './web3_adapter.js';

export function createSolanaAdapter(config: SolmoltConfig): SolanaAdapter {
  const { endpoint } = config.rpc;
  const { privateKey, keyfilePath } = config.wallet;
  return new Web3Adapter(endpoint, privateKey, keyfilePath);
}

export type { SolanaAdapter } from './adapter.js';
export type { TokenBalance, ConfirmParams } from './types.js';

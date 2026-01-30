import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { sleep } from "../util/time.js";
import type { SendResult, SolanaAdapter } from "./adapter.js";
import { loadSecretKey } from "./keys.js";
import type { ConfirmParams, TokenBalance } from "./types.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export class Web3Adapter implements SolanaAdapter {
  private readonly connection: Connection;
  private readonly keypair: Keypair;

  constructor(rpcEndpoint: string, privateKey?: string, keyfilePath?: string) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
    const secretKey = loadSecretKey(privateKey, keyfilePath);
    this.keypair = Keypair.fromSecretKey(secretKey);
  }

  getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  async getSolBalanceLamports(): Promise<string> {
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports.toString();
  }

  async getSplBalances(mints?: string[]): Promise<TokenBalance[]> {
    const response = await this.connection.getParsedTokenAccountsByOwner(
      this.keypair.publicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      },
    );
    const tokens = response.value.map((account) => {
      const info = account.account.data.parsed.info as {
        mint: string;
        tokenAmount: {
          amount: string;
          decimals: number;
          uiAmount: number | null;
        };
      };
      return {
        mint: info.mint,
        amountRaw: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
        uiAmount: info.tokenAmount.uiAmount,
      } satisfies TokenBalance;
    });

    if (!mints || mints.length === 0) return tokens;
    const allow = new Set(mints);
    return tokens.filter((token) => allow.has(token.mint));
  }

  async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    return {
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  }

  async signRawTransaction(serializedTx: Uint8Array): Promise<Uint8Array> {
    const tx = VersionedTransaction.deserialize(serializedTx);
    tx.sign([this.keypair]);
    return tx.serialize();
  }

  async sendAndConfirmRawTx(
    serializedTx: Uint8Array,
    confirm: ConfirmParams = {},
  ): Promise<SendResult> {
    const signature = await this.connection.sendRawTransaction(serializedTx, {
      skipPreflight: false,
    });
    const commitment = confirm.commitment ?? "confirmed";
    const timeoutMs = confirm.timeoutMs ?? 60_000;
    const pollIntervalMs = confirm.pollIntervalMs ?? 1_000;
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const status = await this.connection.getSignatureStatuses([signature]);
      const info = status.value[0];
      if (info?.err) {
        return { signature, slot: info.slot, err: info.err };
      }
      if (info?.confirmationStatus) {
        if (commitment === "processed") {
          return { signature, slot: info.slot };
        }
        if (
          commitment === "confirmed" &&
          (info.confirmationStatus === "confirmed" ||
            info.confirmationStatus === "finalized")
        ) {
          return { signature, slot: info.slot };
        }
        if (
          commitment === "finalized" &&
          info.confirmationStatus === "finalized"
        ) {
          return { signature, slot: info.slot };
        }
      }
      await sleep(pollIntervalMs);
    }

    return { signature, err: "confirmation-timeout" };
  }

  async simulateRawTx(serializedTx: Uint8Array): Promise<unknown> {
    const tx = VersionedTransaction.deserialize(serializedTx);
    const result = await this.connection.simulateTransaction(tx);
    return result.value;
  }
}

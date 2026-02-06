import type { Env } from "./types";

type RpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type RpcResponse<T> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: RpcError;
};

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class SolanaRpc {
  constructor(private readonly endpoint: string) {}

  static fromEnv(env: Env): SolanaRpc {
    const endpoint = env.RPC_ENDPOINT;
    if (!endpoint) throw new Error("rpc-endpoint-missing");
    return new SolanaRpc(endpoint);
  }

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`rpc-http-error: ${response.status} ${text}`);
    }
    const payload = (await response.json()) as RpcResponse<T>;
    if (payload.error) {
      throw new Error(
        `rpc-error: ${payload.error.code ?? "?"} ${payload.error.message ?? safeJsonString(payload.error)}`,
      );
    }
    if (!("result" in payload)) {
      throw new Error("rpc-missing-result");
    }
    return payload.result as T;
  }

  async getBalanceLamports(pubkey: string): Promise<bigint> {
    const result = await this.request<{ value: number }>("getBalance", [
      pubkey,
    ]);
    return BigInt(result.value ?? 0);
  }

  async getTokenBalanceAtomic(owner: string, mint: string): Promise<bigint> {
    const result = await this.request<{
      value: Array<{
        account?: {
          data?: {
            parsed?: {
              info?: {
                tokenAmount?: { amount?: string };
              };
            };
          };
        };
      }>;
    }>("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed" },
    ]);

    let total = 0n;
    for (const item of result.value ?? []) {
      const amount = item.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amount === "string") {
        try {
          total += BigInt(amount);
        } catch {
          // ignore malformed rows
        }
      }
    }
    return total;
  }

  async sendTransactionBase64(
    signedBase64Tx: string,
    opts?: {
      skipPreflight?: boolean;
      preflightCommitment?: "processed" | "confirmed" | "finalized";
      maxRetries?: number;
    },
  ): Promise<string> {
    const config: Record<string, unknown> = { encoding: "base64" };
    if (opts?.skipPreflight !== undefined)
      config.skipPreflight = opts.skipPreflight;
    if (opts?.preflightCommitment)
      config.preflightCommitment = opts.preflightCommitment;
    if (opts?.maxRetries !== undefined) config.maxRetries = opts.maxRetries;
    return await this.request<string>("sendTransaction", [
      signedBase64Tx,
      config,
    ]);
  }

  async getSignatureStatus(signature: string): Promise<{
    confirmationStatus?: string;
    err?: unknown;
  } | null> {
    const result = await this.request<{
      value: Array<{
        confirmationStatus?: string;
        err?: unknown;
      } | null>;
    }>("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    return result.value?.[0] || null;
  }

  async confirmSignature(
    signature: string,
    opts?: {
      commitment?: "processed" | "confirmed" | "finalized";
      timeoutMs?: number;
      pollMs?: number;
    },
  ): Promise<{ ok: boolean; status?: string; err?: unknown }> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const pollMs = opts?.pollMs ?? 1_000;
    const want = opts?.commitment ?? "confirmed";
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const status = await this.getSignatureStatus(signature);
      if (status) {
        const confirmationStatus = status.confirmationStatus ?? "unknown";
        if (status.err) {
          return { ok: false, status: confirmationStatus, err: status.err };
        }
        if (
          confirmationStatus === want ||
          (want === "confirmed" && confirmationStatus === "finalized") ||
          (want === "processed" &&
            (confirmationStatus === "confirmed" ||
              confirmationStatus === "finalized"))
        ) {
          return { ok: true, status: confirmationStatus };
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    return { ok: false, status: "timeout" };
  }
}

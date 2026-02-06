import type { Env } from "./types";

type PrivyWalletResponse = {
  address?: string;
  [k: string]: unknown;
};

type SignTransactionResponse = {
  data?: {
    signed_transaction?: string;
  };
  [k: string]: unknown;
};

let cachedWalletAddress: string | null = null;
let cachedWalletId: string | null = null;

function base64EncodeUtf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function requirePrivy(env: Env): {
  appId: string;
  appSecret: string;
  walletId: string;
  apiBaseUrl: string;
} {
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  const walletId = env.PRIVY_WALLET_ID;
  if (!appId || !appSecret || !walletId) {
    throw new Error("privy-config-missing");
  }
  const apiBaseUrl = "https://api.privy.io/v1";
  return { appId, appSecret, walletId, apiBaseUrl };
}

function privyHeaders(env: Env): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const { appId, appSecret, apiBaseUrl } = requirePrivy(env);
  const auth = base64EncodeUtf8(`${appId}:${appSecret}`);
  return {
    baseUrl: apiBaseUrl,
    headers: {
      Authorization: `Basic ${auth}`,
      "privy-app-id": appId,
    },
  };
}

export async function getPrivyWalletAddress(env: Env): Promise<string> {
  const { walletId } = requirePrivy(env);
  if (cachedWalletAddress && cachedWalletId === walletId) {
    return cachedWalletAddress;
  }

  const { baseUrl, headers } = privyHeaders(env);
  const url = `${baseUrl}/wallets/${walletId}`;
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`privy-wallet-fetch-failed: ${response.status} ${text}`);
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("privy-wallet-invalid-response");
  }
  const wallet = payload as PrivyWalletResponse;
  if (typeof wallet.address !== "string" || !wallet.address.trim()) {
    throw new Error("privy-wallet-missing-address");
  }
  cachedWalletAddress = wallet.address;
  cachedWalletId = walletId;
  return wallet.address;
}

export async function signTransactionWithPrivy(
  env: Env,
  base64WireTransaction: string,
): Promise<string> {
  const { walletId } = requirePrivy(env);
  const { baseUrl, headers } = privyHeaders(env);

  const url = `${baseUrl}/wallets/${walletId}/rpc`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      method: "signTransaction",
      params: {
        encoding: "base64",
        transaction: base64WireTransaction,
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`privy-sign-failed: ${response.status} ${text}`);
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("privy-sign-invalid-response");
  }
  const parsed = payload as SignTransactionResponse;
  const signed = parsed.data?.signed_transaction;
  if (typeof signed !== "string" || !signed) {
    throw new Error("privy-sign-missing-signed-transaction");
  }
  return signed;
}

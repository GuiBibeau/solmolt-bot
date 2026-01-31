import { isRecord } from "../util/types.js";

export type OpenClawGatewayClientOpts = {
  baseUrl: string;
  token: string;
  sessionKey?: string;
  messageChannel?: string;
  accountId?: string;
};

type OpenClawGatewayError = {
  type?: string;
  message?: string;
};

type OpenClawGatewayResponse = {
  ok?: boolean;
  result?: unknown;
  error?: OpenClawGatewayError;
};

export async function openClawInvokeTool(
  cfg: OpenClawGatewayClientOpts,
  tool: string,
  args: Record<string, unknown>,
  action?: string,
): Promise<unknown> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/tools/invoke`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.token}`,
  };
  if (cfg.messageChannel) {
    headers["x-openclaw-message-channel"] = cfg.messageChannel;
  }
  if (cfg.accountId) {
    headers["x-openclaw-account-id"] = cfg.accountId;
  }

  const body = {
    tool,
    args,
    ...(action ? { action } : {}),
    ...(cfg.sessionKey ? { sessionKey: cfg.sessionKey } : {}),
    dryRun: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 404) {
    throw new Error(`openclaw tool not available: ${tool}`);
  }
  if (res.status === 401) {
    throw new Error("openclaw unauthorized");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openclaw request failed: ${res.status} ${body}`);
  }

  const payload = (await res.json()) as unknown;
  if (!isRecord(payload)) {
    throw new Error("openclaw invalid response");
  }
  const response = payload as OpenClawGatewayResponse;
  if (!response.ok) {
    const message = response.error?.message ?? "unknown";
    const type = response.error?.type ?? "error";
    throw new Error(`openclaw tool error: ${type}: ${message}`);
  }
  return response.result;
}

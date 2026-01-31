import type { RalphConfig } from "../config/config.js";
import { info, warn } from "../util/logger.js";
import { isRecord } from "../util/types.js";

export async function runDoctor(config: RalphConfig): Promise<void> {
  const results: { check: string; ok: boolean; detail?: string }[] = [];

  results.push({ check: "config.loaded", ok: true });

  const rpcOk = await checkRpc(config.rpc.endpoint);
  results.push({ check: "rpc.health", ok: rpcOk.ok, detail: rpcOk.detail });

  if (!config.wallet.privateKey && !config.wallet.keyfilePath) {
    results.push({
      check: "wallet.present",
      ok: false,
      detail: "missing privateKey or keyfilePath",
    });
  } else {
    results.push({ check: "wallet.present", ok: true });
  }

  const missing = ["gateway.authToken", "jupiter.apiKey", "llm.apiKey"].filter(
    (k) => !getConfigValue(config, k),
  );
  if (missing.length > 0) {
    results.push({
      check: "secrets.present",
      ok: false,
      detail: `missing ${missing.join(", ")}`,
    });
  } else {
    results.push({ check: "secrets.present", ok: true });
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    info("doctor.ok", { checks: results.length });
  } else {
    warn("doctor.issues", { failed: failed.length, issues: failed });
  }

  for (const result of results) {
    const status = result.ok ? "OK" : "FAIL";
    const detail = result.detail ? ` - ${result.detail}` : "";
    console.log(`${status} ${result.check}${detail}`);
  }
}

async function checkRpc(
  endpoint: string,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, detail: `http ${res.status}` };
    }
    const data = await res.json();
    if (data.error) {
      return { ok: false, detail: data.error.message || "rpc error" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

function getConfigValue(config: RalphConfig, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

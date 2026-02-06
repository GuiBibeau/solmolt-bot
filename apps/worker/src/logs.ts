import type { Env } from "./types";

export async function appendLog(env: Env, key: string, line: string) {
  if (!env.LOGS_BUCKET) {
    // R2 not configured/enabled yet; still allow the Worker to run.
    return;
  }
  const existing = await env.LOGS_BUCKET.get(key);
  const prefix = existing ? await existing.text() : "";
  const body = prefix ? `${prefix}\n${line}` : line;
  await env.LOGS_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function writeJsonl(env: Env, key: string, lines: string[]) {
  if (!env.LOGS_BUCKET) return;
  const body = lines.join("\n");
  await env.LOGS_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

export function makeLogKey(tenantId: string, runId: string, date = new Date()) {
  const iso = date.toISOString().slice(0, 10);
  return `logs/${tenantId}/${iso}/${runId}.jsonl`;
}

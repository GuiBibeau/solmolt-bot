import type { Env } from "./types";

type LockRecord = {
  runId: string;
  expiresAt: string;
};

function lockKey(tenantId: string): string {
  return `loop:lock:${tenantId}`;
}

export async function acquireLoopLock(
  env: Env,
  tenantId: string,
  runId: string,
  ttlSeconds = 120,
): Promise<boolean> {
  // KV enforces a minimum TTL of 60 seconds (Miniflare is strict here too).
  ttlSeconds = Math.max(60, Math.floor(ttlSeconds));
  const key = lockKey(tenantId);
  const existing = await env.CONFIG_KV.get(key, "json");
  if (existing && typeof existing === "object") {
    const record = existing as Partial<LockRecord>;
    if (typeof record.expiresAt === "string") {
      const expiresAtMs = Date.parse(record.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        return false;
      }
    }
  }

  const next: LockRecord = {
    runId,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
  await env.CONFIG_KV.put(key, JSON.stringify(next), {
    expirationTtl: ttlSeconds,
  });
  return true;
}

export async function releaseLoopLock(
  env: Env,
  tenantId: string,
  runId: string,
): Promise<void> {
  const key = lockKey(tenantId);
  const existing = await env.CONFIG_KV.get(key, "json");
  if (existing && typeof existing === "object") {
    const record = existing as Partial<LockRecord>;
    if (record.runId === runId) {
      await env.CONFIG_KV.delete(key);
    }
  }
}

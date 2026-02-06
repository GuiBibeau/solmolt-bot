import type { Env, LoopState } from "./types";

function stateKey(tenantId: string): string {
  return `loop:state:${tenantId}`;
}

export async function getLoopState(
  env: Env,
  tenantId: string,
): Promise<LoopState> {
  const stored = await env.CONFIG_KV.get(stateKey(tenantId), "json");
  if (stored && typeof stored === "object") {
    return stored as LoopState;
  }
  return {};
}

export async function updateLoopState(
  env: Env,
  tenantId: string,
  update: (current: LoopState) => LoopState,
): Promise<LoopState> {
  const current = await getLoopState(env, tenantId);
  const next = update(current);
  await env.CONFIG_KV.put(stateKey(tenantId), JSON.stringify(next));
  return next;
}

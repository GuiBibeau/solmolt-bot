import type { Env } from "./types";

export type TradeIndexRow = {
  tenantId: string;
  runId: string;
  venue: string;
  market: string;
  side: string;
  size?: string | null;
  price?: string | null;
  status: string;
  logKey?: string | null;
  signature?: string | null;
};

export async function insertTradeIndex(
  env: Env,
  row: TradeIndexRow,
): Promise<void> {
  // signature column exists starting from migration 0003_trade_signature.sql
  await env.WAITLIST_DB.prepare(
    "INSERT INTO trade_index (tenant_id, run_id, venue, market, side, size, price, status, log_key, signature) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      row.tenantId,
      row.runId,
      row.venue,
      row.market,
      row.side,
      row.size ?? null,
      row.price ?? null,
      row.status,
      row.logKey ?? null,
      row.signature ?? null,
    )
    .run();
}

export async function listTrades(env: Env, tenantId: string, limit = 50) {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await env.WAITLIST_DB.prepare(
    "SELECT id, tenant_id, run_id, venue, market, side, size, price, status, log_key, signature, created_at FROM trade_index WHERE tenant_id = ?1 ORDER BY id DESC LIMIT ?2",
  )
    .bind(tenantId, capped)
    .all();
  return result.results ?? [];
}

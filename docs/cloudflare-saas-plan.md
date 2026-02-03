# Cloudflare SaaS Plan (Agentic Edge Fund)

## Storage strategy

**Lightweight now, scalable later:**
- **KV**: loop config + runtime flags + per-tenant settings.
- **D1**: waitlist + tenants + trade index metadata.
- **R2**: append-only logs (JSONL), decision traces, run history.

### Rationale
- KV is fast but eventually consistent — best for config.
- D1 gives queryable metadata without heavy ops.
- R2 keeps logs cheap and durable; D1 stores pointers for search.

## Key custody model

Support both:
1) **Raw keys (current)** for local CLI and dev
2) **Solana Keychain (Privy)** for SaaS/hosted deployments

Integrate via `@solana/keychain-privy`.

## Loop execution

- Cloudflare **cron** triggers every minute.
- `apps/worker/src/loop.ts` is the entry point for porting the bot loop.
- Config controlled via `/api/loop/start|stop` and `/api/config`.
- `ralph.config.yaml` is deprecated; configuration lives in KV.

## Multi-tenant SaaS

**Phase 1** (now): single-tenant worker + config via KV.
**Phase 2**: Workers for Platforms + per-tenant namespaces.

## Next steps

- Port trading loop into Workers runtime.
- Add D1 schema for tenants + trade_index integration.
- Implement keychain signer adapter.

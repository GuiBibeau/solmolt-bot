# Ralph Edge Worker

Cloudflare Worker providing:
- waitlist API (`POST /api/waitlist`)
- loop control (`POST /api/loop/start`, `POST /api/loop/stop`)
- cron-triggered loop ticks (stubbed for porting)

## Setup

```bash
wrangler d1 create ralph_waitlist
wrangler kv:namespace create CONFIG_KV
wrangler r2 bucket create ralph-logs
wrangler d1 migrations apply ralph_waitlist
wrangler secret put ADMIN_TOKEN
wrangler secret put PRIVY_APP_ID
wrangler secret put PRIVY_APP_SECRET
wrangler secret put PRIVY_WALLET_ID
wrangler dev
```

Replace the `REPLACE_WITH_*` placeholders in `wrangler.toml` with the IDs
output by Wrangler (KV namespace IDs and D1 database IDs).

## Notes
- Cron runs every minute by default. The loop only runs if enabled in KV.
- The trading loop implementation is stubbed in `src/loop.ts` and is the entry
  point for porting the core bot logic to the Workers runtime.
- Logs are written to R2 (`ralph-logs`) as JSONL.
- Privy keychain credentials are read from secrets (see `PRIVY_*` above).

## API

- `POST /api/waitlist` (form or JSON) → `{ ok: true }`
- `GET /api/loop/status`
- `POST /api/loop/start` (requires `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /api/loop/stop` (requires `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /api/config` (requires admin; accepts `{ policy: {...} }`)

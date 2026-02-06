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

## Local Quickstart (Fast Loop Testing)

This uses `wrangler dev --local` with a persisted local state directory so you
can iterate on the loop quickly without touching real Cloudflare resources.

```bash
cd apps/worker
npm install

# Create the local D1 DB and apply migrations into the persisted state dir.
npm run db:migrate:local

# Enable the loop in local KV (cron + /__scheduled will no-op if disabled).
npm run loop:enable:local

# Start the local dev server (includes --test-scheduled).
npm run dev:local
```

In another terminal you can force a scheduled tick:

```bash
cd apps/worker
npm run loop:tick:local
```

Or open `http://127.0.0.1:8888/__scheduled` in a browser to trigger the
scheduled event handler.
By default this local dev script binds to port `8888` to avoid clashing with
the local Ralph gateway (which commonly uses `8787`).
Note: Wrangler local mode uses the preview KV namespace by default, so the
`loop:*:local` scripts write to the preview namespace to match.

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

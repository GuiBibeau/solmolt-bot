# Ralph Edge Worker

Cloudflare Worker providing:
- waitlist API (`POST /api/waitlist`)
- loop control (`POST /api/loop/start`, `POST /api/loop/stop`)
- cron-triggered loop ticks (Jupiter swaps signed by Privy)

## Setup

```bash
wrangler d1 create ralph_waitlist
wrangler kv:namespace create CONFIG_KV
wrangler r2 bucket create ralph-logs
wrangler d1 migrations apply ralph_waitlist
wrangler secret put ADMIN_TOKEN
wrangler secret put RPC_ENDPOINT
wrangler secret put JUPITER_BASE_URL
wrangler secret put JUPITER_API_KEY

# Only required for live trading (non-dry-run):
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

# Create a `.dev.vars` with at least:
# RPC_ENDPOINT=https://api.mainnet-beta.solana.com
# ADMIN_TOKEN=local-dev
# TENANT_ID=local
#
# For dry-run loop testing (no Privy required):
# DRYRUN_WALLET_ADDRESS=11111111111111111111111111111111
#
# Optional: Jupiter API settings.
# The worker defaults to the Jupiter lite host, which is intended for free/testing.
# For heavier production use, set JUPITER_BASE_URL to the pro host and provide JUPITER_API_KEY.
# JUPITER_BASE_URL=https://lite-api.jup.ag
# JUPITER_API_KEY=...
#
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
- The loop runs strategies defined in KV config (`loop:config`) and executes
  spot swaps via Jupiter.
- Logs are written to R2 (`ralph-logs`) as JSONL.
- Privy keychain credentials are read from secrets (see `PRIVY_*` above).

## API

- `POST /api/waitlist` (form or JSON) → `{ ok: true }`
- `GET /api/loop/status`
- `POST /api/loop/start` (requires `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /api/loop/stop` (requires `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /api/loop/tick` (requires admin; triggers a tick immediately)
- `GET /api/trades?limit=50` (requires admin; last executed trades)
- `POST /api/config` (requires admin; accepts `{ policy: {...}, strategy: {...} }`)

### Example Strategy Config (DCA)

`POST /api/config` body:

```json
{
  "policy": {
    "dryRun": true,
    "slippageBps": 50,
    "maxPriceImpactPct": 0.05,
    "maxTradeAmountAtomic": "0",
    "minSolReserveLamports": "50000000"
  },
  "strategy": {
    "type": "dca",
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "10000000",
    "everyMinutes": 60
  }
}
```

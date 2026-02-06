# Serious Trader Ralph (MVP)

A customizable, long‑running Solana trading bot you can deploy. It ships with a WebSocket gateway, CLI operator, tool registry, and hot‑wallet custody. This repo is **web3‑only** right now.

Active development: expect rapid iteration, feature growth, and occasional breaking changes.

## Requirements

- **Bun** (repo package manager)
- **Wrangler CLI** (Cloudflare Workers)
- Node 18+ (for local tooling)

## Quick start (monorepo dev: portal + edge worker)

This starts both the Next.js portal and the Cloudflare worker locally.

```bash
bun install
bun run dev
```

- Portal: `http://localhost:3000`
- Edge worker: `http://127.0.0.1:8888/api/health`

If you only want the local CLI/gateway, run:

```bash
bun run dev:cli
```

## Quick start (Cloudflare worker, local)

```bash
cd apps/worker
npm install

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

Replace the `REPLACE_WITH_*` placeholders in `apps/worker/wrangler.toml` with
the IDs output by Wrangler (KV namespace IDs and D1 database IDs).

## Control the loop (local or deployed)

```bash
curl -X POST http://127.0.0.1:8787/api/loop/start \\
  -H \"Authorization: Bearer $ADMIN_TOKEN\"

curl -X POST http://127.0.0.1:8787/api/loop/stop \\
  -H \"Authorization: Bearer $ADMIN_TOKEN\"

curl -X POST http://127.0.0.1:8787/api/config \\
  -H \"Authorization: Bearer $ADMIN_TOKEN\" \\
  -H \"Content-Type: application/json\" \\
  -d '{\"policy\":{\"maxSlippageBps\":50}}'
```

## Paths & entrypoints

- CLI entry: `src/bin/ralph.ts`
- Gateway server: `src/gateway/server.ts`
- Tools registry: `src/tools/registry.ts`
- Tools list: `src/tools/tools.ts`
- Skills folder (auto‑loaded): `skills/`
- Web3 adapter: `src/solana/web3_adapter.ts`
- Landing page (Next.js): `apps/portal`
- Cloudflare edge worker: `apps/worker`

Legacy CLI/gateway config is deprecated and not supported for the SaaS path.

## Config notes (Worker)

- All runtime config is stored in **KV** and controlled via `/api/config`.
- Secrets (Privy, admin token) are managed via Wrangler.

## Portal dev

```bash
cd apps/portal
bun install
bun dev
```

## Monorepo layout

- `apps/portal`: Next.js landing page (brutalist UI, waitlist form).
- `apps/worker`: Cloudflare Worker for waitlist + loop control + cron tick.
- Root (`src/`): local CLI + gateway for full-featured bot DX.

## Cloudflare edge services (portal + worker)

The edge worker provides the waitlist API and control endpoints (start/stop loop,
config). The portal posts to `/api/waitlist`.

### Worker setup (wrangler)

```bash
cd apps/worker

# 1) create D1 database
wrangler d1 create ralph_waitlist

# 2) create KV namespace for config
wrangler kv:namespace create CONFIG_KV

# 3) create R2 bucket for logs
wrangler r2 bucket create ralph-logs

# 4) apply migrations
wrangler d1 migrations apply ralph_waitlist

# 5) set admin token (for loop control APIs)
wrangler secret put ADMIN_TOKEN

# 6) dev
wrangler dev
```

### Portal dev

```bash
cd apps/portal
bun install
bun dev
```

## Integration tests (Surfpool/devnet friendly)

These are **skipped by default**. They hit RPC and Jupiter, but do **not** send swaps unless you explicitly opt in.

```bash
export RUN_INTEGRATION_TESTS=1
export RPC_ENDPOINT="http://127.0.0.1:8899"   # surfpool / local validator
export JUPITER_API_KEY="..."
export WALLET_PRIVATE_KEY="..."               # or WALLET_KEYFILE="/path/to/id.json"

bun test
```

Optional swap simulation (build + sign + simulate only, no send):

```bash
export RUN_SWAP_SIM=1
export AIRDROP=1   # request local airdrop for the wallet
bun test
```

## Security reminders

- Use Privy or approved custody for production keys.
- Lock down admin tokens.
- Keep minimal funds in hot wallets.

---

If you want a built‑in UI or sub‑agents like Molt, open an issue or ask and I’ll wire it in.

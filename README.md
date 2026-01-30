# SolMolt Core (MVP)

A minimal Moltbot‑style Solana trading core with a WebSocket gateway, CLI operator, tool registry, and hot‑wallet custody. This repo is **web3‑only** right now.

## Requirements

- **Bun** (recommended runner/bundler)
- Node 18+ if you want to run the built output

## Quick start (DX‑optimized)

```bash
# 1) install deps
bun install

# 2) create your config
cp solmolt.config.example.yaml solmolt.config.yaml

# 3) edit solmolt.config.yaml
# - set wallet.privateKey (or keyfilePath)
# - set jupiter.apiKey
# - set llm.baseUrl / llm.apiKey / llm.model
# - set gateway.authToken

# 4) start the gateway
bun run gateway

# 5) in another terminal, check status
bun run status
```

## Common commands

```bash
bun run gateway                  # start gateway (WS server)
bun run status                   # check gateway status
bun run autopilot:start          # enable autopilot tick loop
bun run autopilot:stop           # disable autopilot tick loop
bun run tool wallet.get_balances # invoke a tool
```

## Paths & entrypoints

- CLI entry: `src/bin/solmolt.ts`
- Gateway server: `src/gateway/server.ts`
- Tools registry: `src/tools/registry.ts`
- Tools list: `src/tools/tools.ts`
- Web3 adapter: `src/solana/web3_adapter.ts`
- Config file (default): `solmolt.config.yaml`

You can override the config path with:

```bash
SOLMOLT_CONFIG=/path/to/solmolt.config.yaml bun run gateway
```

## Config notes

- `llm.provider` currently supports OpenAI‑compatible **chat** or **responses** (we’re using `openai_chat` with DeepInfra).
- `jupiter.apiKey` is required for `https://api.jup.ag`.
- `wallet.privateKey` accepts base58, `base64:...`, `hex:...`, or JSON array string.

## Build

```bash
bun run build
bun run start
```

## Security reminders

- **Do not commit** `solmolt.config.yaml`. It’s in `.gitignore`.
- Keep the gateway bound to `127.0.0.1` and access it via SSH tunnel.
- Keep minimal funds in the hot wallet.

---

If you want a built‑in UI or sub‑agents like Molt, open an issue or ask and I’ll wire it in.

# Serious Trader Ralph (MVP)

A customizable, long‑running Solana trading bot you can deploy. It ships with a WebSocket gateway, CLI operator, tool registry, and hot‑wallet custody. This repo is **web3‑only** right now.

Active development: expect rapid iteration, feature growth, and occasional breaking changes.

## Requirements

- **Bun** (recommended runner/bundler)
- Node 18+ if you want to run the built output

## Quick start (DX‑optimized)

```bash
# 1) install deps
bun install

# 2) create your config
cp ralph.config.example.yaml ralph.config.yaml

# 3) edit ralph.config.yaml
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
bun run gateway:stop             # stop gateway via WS
bun run gateway:restart          # restart gateway (requests shutdown)
bun run status                   # check gateway status
bun run autopilot:start          # enable autopilot tick loop
bun run autopilot:stop           # disable autopilot tick loop
bun run tool wallet.get_balances # invoke a tool
bun run agent:message -m "focus on SOL/USDC" -t  # send a message + trigger tick
bun run doctor                   # config/RPC health checks
bun run update                   # git pull + bun install
```

## Paths & entrypoints

- CLI entry: `src/bin/ralph.ts`
- Gateway server: `src/gateway/server.ts`
- Tools registry: `src/tools/registry.ts`
- Tools list: `src/tools/tools.ts`
- Skills folder (auto‑loaded): `skills/`
- Web3 adapter: `src/solana/web3_adapter.ts`
- Config file (default): `ralph.config.yaml`

You can override the config path with:

```bash
RALPH_CONFIG=/path/to/ralph.config.yaml bun run gateway
```

## Config notes

- `llm.provider` is **openai_chat** for now (OpenAI‑compatible chat; we’re using DeepInfra).
- `jupiter.apiKey` is required for `https://api.jup.ag`.
- `wallet.privateKey` accepts base58, `base64:...`, `hex:...`, or JSON array string.
- `tools.skillsDir` points to the folder for auto‑loaded skill modules.

### Autopilot plan (optional)

The agent is LLM‑driven and will decide which tools to call. You can optionally give it a fixed plan as a hint:

```yaml
autopilot:
  enabled: true
  intervalMs: 15000
  plan:
    inputMint: "So11111111111111111111111111111111111111112" # SOL
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" # USDC
    amount: "1000000" # 0.001 SOL in lamports
    slippageBps: 50
```

## Build

```bash
bun run build
bun run start
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

- **Do not commit** `ralph.config.yaml`. It’s in `.gitignore`.
- Keep the gateway bound to `127.0.0.1` and access it via SSH tunnel.
- Keep minimal funds in the hot wallet.

---

If you want a built‑in UI or sub‑agents like Molt, open an issue or ask and I’ll wire it in.

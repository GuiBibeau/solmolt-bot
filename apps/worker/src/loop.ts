import { getLoopConfig } from "./config";
import { JupiterClient } from "./jupiter";
import { acquireLoopLock, releaseLoopLock } from "./lock";
import { makeLogKey, writeJsonl } from "./logs";
import { enforcePolicy, normalizePolicy } from "./policy";
import { getPrivyWalletAddress, signTransactionWithPrivy } from "./privy";
import { SolanaRpc } from "./solana_rpc";
import { getLoopState, updateLoopState } from "./state";
import { swapWithRetry } from "./swap";
import { insertTradeIndex } from "./trade_index";
import type {
  DcaStrategy,
  Env,
  RebalanceStrategy,
  StrategyConfig,
} from "./types";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9n;

export async function runAutopilotTick(
  env: Env,
  ctx: ExecutionContext,
  reason: "cron" | "manual" = "cron",
) {
  const runId = crypto.randomUUID();
  const tenantId = env.TENANT_ID ?? "default";
  const logKey = makeLogKey(tenantId, runId);
  const lines: string[] = [];

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      tenantId,
      runId,
      reason,
      ...(meta ?? {}),
    });
    lines.push(line);
    console.log(line);
  };

  const flush = async () => {
    try {
      await writeJsonl(env, logKey, lines);
    } catch (err) {
      // Logging should never take the worker down.
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          message: "failed to flush R2 logs",
          tenantId,
          runId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const locked = await acquireLoopLock(env, tenantId, runId);
  if (!locked) {
    log("warn", "tick skipped (lock held)");
    await flush();
    return;
  }

  try {
    const config = await getLoopConfig(env);
    if (!config.enabled) {
      log("info", "loop disabled");
      return;
    }

    const policy = normalizePolicy(config.policy);
    if (policy.killSwitch) {
      log("warn", "kill switch enabled");
      return;
    }

    const strategy = normalizeStrategy(config.strategy);
    if (!strategy || strategy.type === "noop") {
      log("info", "no strategy configured");
      return;
    }

    const rpc = SolanaRpc.fromEnv(env);
    const jupiter = new JupiterClient(
      // Jupiter introduced a gateway with new hostnames. The lite host is intended
      // for free/testing (no API key), while the pro host requires an API key.
      // See: https://dev.jup.ag/updates
      env.JUPITER_BASE_URL ?? "https://lite-api.jup.ag",
      env.JUPITER_API_KEY,
    );
    const wallet = await resolveWalletAddress(env, policy);

    log("info", "tick start", {
      strategy: strategy.type,
      dryRun: policy.dryRun,
    });

    if (strategy.type === "dca") {
      await runDca({
        env,
        ctx,
        tenantId,
        runId,
        logKey,
        log,
        rpc,
        jupiter,
        wallet,
        policy,
        strategy,
      });
      return;
    }

    if (strategy.type === "rebalance") {
      await runRebalance({
        env,
        ctx,
        tenantId,
        runId,
        logKey,
        log,
        rpc,
        jupiter,
        wallet,
        policy,
        strategy,
      });
      return;
    }

    log("warn", "unsupported strategy type", {
      type: (strategy as StrategyConfig).type,
    });
  } catch (err) {
    log("error", "tick failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await releaseLoopLock(env, tenantId, runId);
    await flush();
    ctx.waitUntil(Promise.resolve());
  }
}

function normalizeStrategy(strategy: unknown): StrategyConfig | null {
  if (!strategy || typeof strategy !== "object") return null;
  const type = (strategy as { type?: unknown }).type;
  if (type === "dca" || type === "rebalance" || type === "noop") {
    return strategy as StrategyConfig;
  }
  return null;
}

async function resolveWalletAddress(
  env: Env,
  policy: ReturnType<typeof normalizePolicy>,
): Promise<string> {
  // For dry-runs we don't want to require Privy; we just need *some* address to query balances.
  if (policy.dryRun) {
    return (
      env.DRYRUN_WALLET_ADDRESS ??
      // System program address; fine for balance queries, never used for signing.
      "11111111111111111111111111111111"
    );
  }
  return await getPrivyWalletAddress(env);
}

async function runDca(input: {
  env: Env;
  ctx: ExecutionContext;
  tenantId: string;
  runId: string;
  logKey: string;
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  rpc: SolanaRpc;
  jupiter: JupiterClient;
  wallet: string;
  policy: ReturnType<typeof normalizePolicy>;
  strategy: DcaStrategy;
}) {
  const {
    env,
    tenantId,
    runId,
    logKey,
    log,
    rpc,
    jupiter,
    wallet,
    policy,
    strategy,
  } = input;
  const everyMinutes = Math.max(1, Math.floor(strategy.everyMinutes ?? 60));

  const state = await getLoopState(env, tenantId);
  const lastAt = state.dca?.lastAt ? Date.parse(state.dca.lastAt) : NaN;
  const now = Date.now();
  if (Number.isFinite(lastAt) && now - lastAt < everyMinutes * 60_000) {
    log("info", "dca not due yet", { everyMinutes, lastAt: state.dca?.lastAt });
    return;
  }

  const solBalanceLamports = await rpc.getBalanceLamports(wallet);
  const reserveLamports = BigInt(policy.minSolReserveLamports);

  if (strategy.inputMint === SOL_MINT) {
    const needed = BigInt(strategy.amount) + reserveLamports;
    if (solBalanceLamports < needed) {
      log("warn", "insufficient SOL for DCA (after reserve)", {
        solBalanceLamports: solBalanceLamports.toString(),
        reserveLamports: reserveLamports.toString(),
        amount: strategy.amount,
      });
      if (!policy.dryRun) return;
    }
  } else {
    if (solBalanceLamports < reserveLamports) {
      log("warn", "insufficient SOL for fees (reserve)", {
        solBalanceLamports: solBalanceLamports.toString(),
        reserveLamports: reserveLamports.toString(),
      });
      if (!policy.dryRun) return;
    }
  }

  const quote = await jupiter.quote({
    inputMint: strategy.inputMint,
    outputMint: strategy.outputMint,
    amount: strategy.amount,
    slippageBps: policy.slippageBps,
    swapMode: "ExactIn",
  });
  enforcePolicy(policy, quote);

  log("info", "jupiter quote", {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct ?? 0,
  });

  if (policy.dryRun) {
    await insertTradeIndex(env, {
      tenantId,
      runId,
      venue: "jupiter",
      market: `${quote.inputMint}->${quote.outputMint}`,
      side: "swap",
      size: quote.inAmount,
      price: quote.outAmount,
      status: "dry_run",
      logKey,
      signature: null,
    });
    await updateLoopState(env, tenantId, (current) => ({
      ...current,
      dca: { ...(current.dca ?? {}), lastAt: new Date().toISOString() },
    }));
    log("info", "dry run complete");
    return;
  }

  const {
    swap,
    quoteResponse: usedQuote,
    refreshed,
  } = await swapWithRetry(jupiter, quote, wallet, policy);
  if (refreshed) {
    log("warn", "quote refreshed due to swap 422", {
      inAmount: usedQuote.inAmount,
      outAmount: usedQuote.outAmount,
      priceImpactPct: usedQuote.priceImpactPct ?? 0,
    });
  }

  const signedBase64 = await signTransactionWithPrivy(
    env,
    swap.swapTransaction,
  );
  const signature = await rpc.sendTransactionBase64(signedBase64, {
    skipPreflight: policy.skipPreflight,
    preflightCommitment: policy.commitment,
  });

  log("info", "tx submitted", {
    signature,
    lastValidBlockHeight: swap.lastValidBlockHeight,
  });

  const confirmation = await rpc.confirmSignature(signature, {
    commitment: policy.commitment,
  });
  const status = confirmation.ok
    ? (confirmation.status ?? "confirmed")
    : "error";
  log(confirmation.ok ? "info" : "warn", "tx confirmation", {
    signature,
    status,
    err: confirmation.err ?? null,
  });

  await insertTradeIndex(env, {
    tenantId,
    runId,
    venue: "jupiter",
    market: `${usedQuote.inputMint}->${usedQuote.outputMint}`,
    side: "swap",
    size: usedQuote.inAmount,
    price: usedQuote.outAmount,
    status,
    logKey,
    signature,
  });

  await updateLoopState(env, tenantId, (current) => ({
    ...current,
    dca: { ...(current.dca ?? {}), lastAt: new Date().toISOString() },
  }));
}

async function runRebalance(input: {
  env: Env;
  ctx: ExecutionContext;
  tenantId: string;
  runId: string;
  logKey: string;
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  rpc: SolanaRpc;
  jupiter: JupiterClient;
  wallet: string;
  policy: ReturnType<typeof normalizePolicy>;
  strategy: RebalanceStrategy;
}) {
  const {
    env,
    tenantId,
    runId,
    logKey,
    log,
    rpc,
    jupiter,
    wallet,
    policy,
    strategy,
  } = input;

  if (strategy.baseMint !== SOL_MINT) {
    throw new Error("rebalance-only-sol-base-supported");
  }

  const targetBps = Math.max(
    0,
    Math.min(10_000, Math.round(strategy.targetBasePct * 10_000)),
  );
  const thresholdBps = Math.max(
    0,
    Math.min(10_000, Math.round((strategy.thresholdPct ?? 0.01) * 10_000)),
  );

  const solBalanceLamports = await rpc.getBalanceLamports(wallet);
  const quoteBalanceAtomic = await rpc.getTokenBalanceAtomic(
    wallet,
    strategy.quoteMint,
  );

  // Price oracle via Jupiter: 1 SOL -> quoteMint.
  const oneSolLamports = (10n ** SOL_DECIMALS).toString();
  const priceQuote = await jupiter.quote({
    inputMint: SOL_MINT,
    outputMint: strategy.quoteMint,
    amount: oneSolLamports,
    slippageBps: Math.max(1, policy.slippageBps),
    swapMode: "ExactIn",
  });
  enforcePolicy(policy, priceQuote);

  const quotePerSolAtomic = BigInt(priceQuote.outAmount || "0");
  if (quotePerSolAtomic <= 0n) {
    log("warn", "rebalance: no price route");
    return;
  }

  const solValueQuoteAtomic =
    (solBalanceLamports * quotePerSolAtomic) / 10n ** SOL_DECIMALS;
  const totalQuoteAtomic = solValueQuoteAtomic + quoteBalanceAtomic;
  if (totalQuoteAtomic <= 0n) {
    log("info", "rebalance: empty portfolio");
    return;
  }

  const currentBaseBps = Number(
    (solValueQuoteAtomic * 10_000n) / totalQuoteAtomic,
  );
  const deltaBps = currentBaseBps - targetBps;

  log("info", "rebalance snapshot", {
    quotePerSolAtomic: quotePerSolAtomic.toString(),
    solBalanceLamports: solBalanceLamports.toString(),
    quoteBalanceAtomic: quoteBalanceAtomic.toString(),
    solValueQuoteAtomic: solValueQuoteAtomic.toString(),
    totalQuoteAtomic: totalQuoteAtomic.toString(),
    currentBasePct: currentBaseBps / 100,
    targetBasePct: targetBps / 100,
    thresholdPct: thresholdBps / 100,
  });

  if (Math.abs(deltaBps) <= thresholdBps) {
    log("info", "rebalance within threshold, no trade");
    return;
  }

  const desiredSolValueQuoteAtomic =
    (totalQuoteAtomic * BigInt(targetBps)) / 10_000n;

  if (solValueQuoteAtomic > desiredSolValueQuoteAtomic) {
    // Sell SOL -> quoteMint.
    const excessQuoteAtomic = solValueQuoteAtomic - desiredSolValueQuoteAtomic;
    let sellLamports =
      (excessQuoteAtomic * 10n ** SOL_DECIMALS) / quotePerSolAtomic;
    const maxSell = strategy.maxSellBaseAmount
      ? BigInt(strategy.maxSellBaseAmount)
      : sellLamports;
    if (sellLamports > maxSell) sellLamports = maxSell;

    const reserveLamports = BigInt(policy.minSolReserveLamports);
    if (sellLamports + reserveLamports > solBalanceLamports) {
      sellLamports =
        solBalanceLamports > reserveLamports
          ? solBalanceLamports - reserveLamports
          : 0n;
    }

    if (sellLamports <= 0n) {
      log("warn", "rebalance: computed sell amount is 0");
      return;
    }

    const quote = await jupiter.quote({
      inputMint: SOL_MINT,
      outputMint: strategy.quoteMint,
      amount: sellLamports.toString(),
      slippageBps: policy.slippageBps,
      swapMode: "ExactIn",
    });
    enforcePolicy(policy, quote);

    log("info", "rebalance sell quote", {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct ?? 0,
    });

    if (policy.dryRun) {
      await insertTradeIndex(env, {
        tenantId,
        runId,
        venue: "jupiter",
        market: `${quote.inputMint}->${quote.outputMint}`,
        side: "rebalance_sell",
        size: quote.inAmount,
        price: quote.outAmount,
        status: "dry_run",
        logKey,
        signature: null,
      });
      log("info", "dry run complete");
      return;
    }

    const {
      swap,
      quoteResponse: usedQuote,
      refreshed,
    } = await swapWithRetry(jupiter, quote, wallet, policy);
    if (refreshed) log("warn", "rebalance: quote refreshed due to swap 422");
    const signedBase64 = await signTransactionWithPrivy(
      env,
      swap.swapTransaction,
    );
    const signature = await rpc.sendTransactionBase64(signedBase64, {
      skipPreflight: policy.skipPreflight,
      preflightCommitment: policy.commitment,
    });
    const confirmation = await rpc.confirmSignature(signature, {
      commitment: policy.commitment,
    });
    const status = confirmation.ok
      ? (confirmation.status ?? "confirmed")
      : "error";
    log(confirmation.ok ? "info" : "warn", "rebalance sell confirmation", {
      signature,
      status,
      err: confirmation.err ?? null,
    });
    await insertTradeIndex(env, {
      tenantId,
      runId,
      venue: "jupiter",
      market: `${usedQuote.inputMint}->${usedQuote.outputMint}`,
      side: "rebalance_sell",
      size: usedQuote.inAmount,
      price: usedQuote.outAmount,
      status,
      logKey,
      signature,
    });
    return;
  }

  // Buy SOL using quoteMint.
  const deficitQuoteAtomic = desiredSolValueQuoteAtomic - solValueQuoteAtomic;
  let spendQuoteAtomic = deficitQuoteAtomic;
  const maxBuy = strategy.maxBuyQuoteAmount
    ? BigInt(strategy.maxBuyQuoteAmount)
    : spendQuoteAtomic;
  if (spendQuoteAtomic > maxBuy) spendQuoteAtomic = maxBuy;
  if (spendQuoteAtomic > quoteBalanceAtomic)
    spendQuoteAtomic = quoteBalanceAtomic;

  const reserveLamports = BigInt(policy.minSolReserveLamports);
  if (solBalanceLamports < reserveLamports) {
    log("warn", "rebalance: insufficient SOL for fees (reserve)", {
      solBalanceLamports: solBalanceLamports.toString(),
      reserveLamports: reserveLamports.toString(),
    });
    return;
  }

  if (spendQuoteAtomic <= 0n) {
    log("warn", "rebalance: computed buy amount is 0");
    return;
  }

  const quote = await jupiter.quote({
    inputMint: strategy.quoteMint,
    outputMint: SOL_MINT,
    amount: spendQuoteAtomic.toString(),
    slippageBps: policy.slippageBps,
    swapMode: "ExactIn",
  });
  enforcePolicy(policy, quote);
  log("info", "rebalance buy quote", {
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct ?? 0,
  });

  if (policy.dryRun) {
    await insertTradeIndex(env, {
      tenantId,
      runId,
      venue: "jupiter",
      market: `${quote.inputMint}->${quote.outputMint}`,
      side: "rebalance_buy",
      size: quote.inAmount,
      price: quote.outAmount,
      status: "dry_run",
      logKey,
      signature: null,
    });
    log("info", "dry run complete");
    return;
  }

  const {
    swap,
    quoteResponse: usedQuote,
    refreshed,
  } = await swapWithRetry(jupiter, quote, wallet, policy);
  if (refreshed) log("warn", "rebalance: quote refreshed due to swap 422");
  const signedBase64 = await signTransactionWithPrivy(
    env,
    swap.swapTransaction,
  );
  const signature = await rpc.sendTransactionBase64(signedBase64, {
    skipPreflight: policy.skipPreflight,
    preflightCommitment: policy.commitment,
  });
  const confirmation = await rpc.confirmSignature(signature, {
    commitment: policy.commitment,
  });
  const status = confirmation.ok
    ? (confirmation.status ?? "confirmed")
    : "error";
  log(confirmation.ok ? "info" : "warn", "rebalance buy confirmation", {
    signature,
    status,
    err: confirmation.err ?? null,
  });
  await insertTradeIndex(env, {
    tenantId,
    runId,
    venue: "jupiter",
    market: `${usedQuote.inputMint}->${usedQuote.outputMint}`,
    side: "rebalance_buy",
    size: usedQuote.inAmount,
    price: usedQuote.outAmount,
    status,
    logKey,
    signature,
  });
}

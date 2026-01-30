import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './registry.js';
import { evaluateTrade } from '../policy/index.js';
import type { BalancesSnapshot, PolicySnapshot, QuoteSummary } from './types.js';
import { JupiterClient } from '../jupiter/client.js';
import { info } from '../util/logger.js';

export function registerDefaultTools(registry: ToolRegistry, jupiter: JupiterClient): void {
  registry.register({
    name: 'wallet.get_balances',
    description: 'Return SOL + SPL balances for the agent wallet.',
    requires: { config: ['rpc.endpoint'] },
    execute: async (ctx: ToolContext, input: { mints?: string[] }) => {
      const solLamports = await ctx.solana.getSolBalanceLamports();
      const tokens = await ctx.solana.getSplBalances(input?.mints);
      return { solLamports, tokens };
    },
  });

  registry.register({
    name: 'market.jupiter_quote',
    description: 'Fetch a Jupiter swap quote.',
    requires: { config: ['jupiter.apiKey'] },
    execute: async (_ctx: ToolContext, input: { inputMint: string; outputMint: string; amount: string; slippageBps: number }) => {
      return jupiter.quote(input);
    },
  });

  registry.register({
    name: 'risk.check_trade',
    description: 'Deterministic allow/deny with policy constraints.',
    execute: async (_ctx: ToolContext, input: { quoteSummary: QuoteSummary; balancesSnapshot: BalancesSnapshot; policySnapshot: PolicySnapshot }) => {
      return evaluateTrade(input.policySnapshot, input.quoteSummary, input.balancesSnapshot);
    },
  });

  registry.register({
    name: 'trade.jupiter_swap',
    description: 'Build + sign + submit Jupiter swap transaction.',
    requires: { config: ['rpc.endpoint', 'jupiter.apiKey'] },
    execute: async (ctx: ToolContext, input: { quoteResponse: Record<string, unknown>; txOptions?: { commitment?: 'processed' | 'confirmed' | 'finalized' } }) => {
      const swap = await jupiter.swap({
        quoteResponse: input.quoteResponse,
        userPublicKey: ctx.solana.getPublicKey(),
      });
      const rawTx = Buffer.from(swap.swapTransaction, 'base64');
      const signed = await ctx.solana.signRawTransaction(rawTx);
      const result = await ctx.solana.sendAndConfirmRawTx(signed, {
        commitment: input.txOptions?.commitment ?? 'confirmed',
      });
      await ctx.tradeJournal.append({
        type: 'swap',
        signature: result.signature,
        status: result.err ? 'error' : 'confirmed',
        lastValidBlockHeight: swap.lastValidBlockHeight,
      });
      return {
        signature: result.signature,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        status: result.err ? 'error' : 'confirmed',
      };
    },
  });

  registry.register({
    name: 'system.autopilot_tick',
    description: 'Timer-driven autonomous iteration.',
    execute: async (ctx: ToolContext, input: { reason: 'timer' | 'operator' | 'recovery' }) => {
      info('autopilot tick', { reason: input.reason });
      return {
        actionsTaken: [],
        nextTickInMs: ctx.config.autopilot.intervalMs,
      };
    },
  });

  registry.register({
    name: 'notify.emit',
    description: 'Emit operator notifications to console or webhook.',
    execute: async (_ctx: ToolContext, input: { level: 'info' | 'warn' | 'error'; message: string; metadata?: Record<string, unknown> }) => {
      if (input.level === 'warn') {
        info(`WARN: ${input.message}`, input.metadata);
      } else if (input.level === 'error') {
        info(`ERROR: ${input.message}`, input.metadata);
      } else {
        info(input.message, input.metadata);
      }
      return { ok: true };
    },
  });
}

import { z } from "zod";
import { JupiterQuoteResponseSchema } from "../jupiter/schema.js";

const QuoteSchema = z.object({
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().nonnegative(),
});

const RouteMapSchema = z.object({
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().nonnegative().optional(),
});

const TradeSchema = z.object({
  quoteResponse: JupiterQuoteResponseSchema,
  txOptions: z
    .object({
      commitment: z.enum(["processed", "confirmed", "finalized"]).optional(),
    })
    .optional(),
});

const BalancesSchema = z.object({
  mints: z.array(z.string()).optional(),
});

const RiskSchema = z.object({
  quoteSummary: z.object({
    inAmount: z.string(),
    outAmount: z.string(),
    priceImpactPct: z.number(),
    routeLabels: z.array(z.string()),
  }),
  balancesSnapshot: z.object({
    solLamports: z.string(),
    tokens: z.array(
      z.object({
        mint: z.string(),
        amountRaw: z.string(),
        decimals: z.number().int(),
        uiAmount: z.number().nullable(),
      }),
    ),
  }),
  policySnapshot: z.object({
    killSwitch: z.boolean(),
    allowedMints: z.array(z.string()),
    maxTradeAmountLamports: z.string(),
    maxSlippageBps: z.number().int(),
    maxPriceImpactPct: z.number(),
    cooldownSeconds: z.number().int(),
    dailySpendCapLamports: z.string().optional().nullable(),
  }),
});

const MaxPositionSchema = z.object({
  mint: z.string().min(1),
  currentBalance: z.string().regex(/^-?\d+$/),
  proposedDelta: z.string().regex(/^-?\d+$/),
  maxPosition: z.string().regex(/^-?\d+$/),
});

const DailyPnlSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const NotifySchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

const TickSchema = z.object({
  reason: z.enum(["timer", "operator", "recovery"]),
});

const AgentMessageSchema = z.object({
  content: z.string().min(1),
  triggerTick: z.boolean().optional(),
  sessionKey: z.string().optional(),
});

const SessionsListSchema = z.object({});

const SessionsHistorySchema = z.object({
  sessionKey: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

const SessionsSendSchema = z.object({
  sessionKey: z.string().min(1),
  content: z.string().min(1),
  agentId: z.string().optional(),
  triggerRun: z.boolean().optional(),
});

const SessionsSpawnSchema = z.object({
  task: z.string().min(1),
  label: z.string().optional(),
  agentId: z.string().optional(),
});

const RunsStatusSchema = z.object({
  runId: z.string().min(1),
});

const RunsWaitSchema = z.object({
  runId: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

const PricesSchema = z.object({
  mints: z.array(z.string().min(1)).min(1),
  venue: z.string().optional(),
});

const TokenMetadataSchema = z.object({
  mint: z.string().min(1),
});

const PythPriceSchema = z
  .object({
    symbol: z.string().min(1).optional(),
    feedId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.symbol || data.feedId), {
    message: "symbol-or-feedId-required",
  });

const CandlesSchema = z.object({
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  interval: z.string().min(1),
  limit: z.number().int().positive().max(1000).optional(),
});

const PredictionMarketsListSchema = z.object({
  venue: z.string().min(1),
});

const PredictionMarketQuoteSchema = z.object({
  venue: z.string().min(1),
  marketId: z.string().min(1),
});

const RaydiumPoolSchema = z.object({
  poolId: z.string().min(1),
});

const OrcaPoolSchema = z.object({
  poolId: z.string().min(1),
});

const SwitchboardPriceSchema = z.object({
  feedId: z.string().min(1),
});

const LiquidityByMintSchema = z.object({
  mint: z.string().min(1),
});

const OpenClawInvokeSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  action: z.string().optional(),
});

export const TOOL_VALIDATORS: Record<string, z.ZodTypeAny> = {
  "wallet.get_balances": BalancesSchema,
  "market.jupiter_quote": QuoteSchema,
  "market.jupiter_route_map": RouteMapSchema,
  "market.get_prices": PricesSchema,
  "market.token_metadata": TokenMetadataSchema,
  "market.pyth_price": PythPriceSchema,
  "market.candles": CandlesSchema,
  "market.prediction_markets_list": PredictionMarketsListSchema,
  "market.prediction_market_quote": PredictionMarketQuoteSchema,
  "market.raydium_pool_stats": RaydiumPoolSchema,
  "market.orca_pool_stats": OrcaPoolSchema,
  "market.switchboard_price": SwitchboardPriceSchema,
  "market.liquidity_by_mint": LiquidityByMintSchema,
  "openclaw.invoke": OpenClawInvokeSchema,
  "risk.max_position_check": MaxPositionSchema,
  "risk.daily_pnl_snapshot": DailyPnlSchema,
  "risk.check_trade": RiskSchema,
  "trade.jupiter_swap": TradeSchema,
  "notify.emit": NotifySchema,
  "system.autopilot_tick": TickSchema,
  "agent.message": AgentMessageSchema,
  "sessions.list": SessionsListSchema,
  "sessions.history": SessionsHistorySchema,
  "sessions.send": SessionsSendSchema,
  "sessions.spawn": SessionsSpawnSchema,
  "runs.status": RunsStatusSchema,
  "runs.wait": RunsWaitSchema,
};

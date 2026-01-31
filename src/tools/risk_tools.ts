import { evaluateTrade } from "../policy/index.js";
import type { ToolContext, ToolRegistry } from "./registry.js";
import type { ToolDeps } from "./tool_deps.js";
import type {
  BalancesSnapshot,
  PolicySnapshot,
  QuoteSummary,
} from "./types.js";

export function registerRiskTools(
  registry: ToolRegistry,
  deps: ToolDeps,
): void {
  const {
    solMint,
    solDecimals,
    priceDecimals,
    getTokenInfoMap,
    computePriceSnapshot,
    mapWithConcurrency,
    parseScaled,
    formatScaled,
    valueFromAmount,
  } = deps;

  registry.register({
    name: "risk.max_position_check",
    description: "Enforce max position size per mint.",
    schema: {
      name: "risk.max_position_check",
      description: "Enforce max position size per mint.",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
          currentBalance: { type: "string" },
          proposedDelta: { type: "string" },
          maxPosition: { type: "string" },
        },
        required: ["mint", "currentBalance", "proposedDelta", "maxPosition"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: {
        mint: string;
        currentBalance: string;
        proposedDelta: string;
        maxPosition: string;
      },
    ) => {
      const reasons: string[] = [];
      let current: bigint;
      let delta: bigint;
      let max: bigint;
      try {
        current = BigInt(input.currentBalance);
        delta = BigInt(input.proposedDelta);
        max = BigInt(input.maxPosition);
      } catch {
        throw new Error("invalid-numeric-input");
      }
      const next = current + delta;
      if (next < 0n) {
        reasons.push("insufficient-balance");
      }
      if (delta > 0n && next > max) {
        reasons.push("max-position-exceeded");
      }
      return {
        allow: reasons.length === 0,
        reasons,
      };
    },
  });

  registry.register({
    name: "risk.daily_pnl_snapshot",
    description:
      "Compute a daily PnL snapshot from trade journal and balances.",
    schema: {
      name: "risk.daily_pnl_snapshot",
      description:
        "Compute a daily PnL snapshot from trade journal and balances.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["date"],
        additionalProperties: false,
      },
    },
    requires: { config: ["rpc.endpoint", "jupiter.apiKey"] },
    execute: async (ctx: ToolContext, input: { date: string }) => {
      const entries = await ctx.tradeJournal.read(input.date);
      const deltaByMint = new Map<string, bigint>();
      let tradeFlowValueScaled = 0n;
      for (const entry of entries) {
        if (
          entry.type !== "swap" ||
          entry.status !== "confirmed" ||
          !entry.inputMint ||
          !entry.outputMint ||
          !entry.inAmount ||
          !entry.outAmount
        ) {
          continue;
        }
        if (entry.inValueSol && entry.outValueSol) {
          try {
            const inValue = parseScaled(
              String(entry.inValueSol),
              priceDecimals,
            );
            const outValue = parseScaled(
              String(entry.outValueSol),
              priceDecimals,
            );
            if (inValue !== null && outValue !== null) {
              tradeFlowValueScaled += outValue - inValue;
              continue;
            }
          } catch {
            // fall back to price-based valuation
          }
        }
        const inputMint = String(entry.inputMint);
        const outputMint = String(entry.outputMint);
        let inAmount: bigint;
        let outAmount: bigint;
        try {
          inAmount = BigInt(String(entry.inAmount));
          outAmount = BigInt(String(entry.outAmount));
        } catch {
          continue;
        }
        deltaByMint.set(
          inputMint,
          (deltaByMint.get(inputMint) ?? 0n) - inAmount,
        );
        deltaByMint.set(
          outputMint,
          (deltaByMint.get(outputMint) ?? 0n) + outAmount,
        );
      }

      const solLamports = await ctx.solana.getSolBalanceLamports();
      const balances = await ctx.solana.getSplBalances();

      const mintDecimals = new Map<string, number>();
      mintDecimals.set(solMint, solDecimals);
      for (const token of balances) {
        mintDecimals.set(token.mint, token.decimals);
      }

      const priceMints = new Set<string>([solMint]);
      for (const token of balances) priceMints.add(token.mint);
      for (const mint of deltaByMint.keys()) priceMints.add(mint);

      const tokenInfoMap = await getTokenInfoMap(
        Array.from(priceMints).filter((mint) => mint !== solMint),
      );
      for (const [mint, info] of tokenInfoMap.entries()) {
        if (!mintDecimals.has(mint) && info) {
          mintDecimals.set(mint, info.decimals);
        }
      }

      const priceSnapshots = await mapWithConcurrency(
        Array.from(priceMints),
        4,
        async (mint) =>
          computePriceSnapshot(mint, tokenInfoMap.get(mint) ?? null),
      );

      const priceScaledMap = new Map<string, bigint | null>();
      for (const snapshot of priceSnapshots) {
        if (snapshot.mint === solMint) {
          priceScaledMap.set(snapshot.mint, 10n ** BigInt(priceDecimals));
          continue;
        }
        const value = snapshot.mid ?? snapshot.bid ?? snapshot.ask ?? undefined;
        if (!value) {
          priceScaledMap.set(snapshot.mint, null);
          continue;
        }
        priceScaledMap.set(snapshot.mint, parseScaled(value, priceDecimals));
      }

      let portfolioValueScaled = valueFromAmount(
        BigInt(solLamports),
        solDecimals,
        10n ** BigInt(priceDecimals),
      );
      for (const token of balances) {
        const priceScaled = priceScaledMap.get(token.mint);
        if (!priceScaled) continue;
        portfolioValueScaled += valueFromAmount(
          BigInt(token.amountRaw),
          token.decimals,
          priceScaled,
        );
      }

      for (const [mint, delta] of deltaByMint.entries()) {
        const decimals = mintDecimals.get(mint);
        const priceScaled = priceScaledMap.get(mint);
        if (decimals === undefined || !priceScaled) continue;
        tradeFlowValueScaled += valueFromAmount(delta, decimals, priceScaled);
      }

      const realizedPnl = formatScaled(tradeFlowValueScaled, priceDecimals);
      const net = formatScaled(portfolioValueScaled, priceDecimals);
      const unrealizedPnl = formatScaled(
        portfolioValueScaled - tradeFlowValueScaled,
        priceDecimals,
      );

      return {
        realizedPnl,
        unrealizedPnl,
        net,
      };
    },
  });

  registry.register({
    name: "risk.check_trade",
    description: "Deterministic allow/deny with policy constraints.",
    schema: {
      name: "risk.check_trade",
      description: "Deterministic allow/deny with policy constraints.",
      parameters: {
        type: "object",
        properties: {
          quoteSummary: {
            type: "object",
            properties: {
              inAmount: { type: "string" },
              outAmount: { type: "string" },
              priceImpactPct: { type: "number" },
              routeLabels: { type: "array", items: { type: "string" } },
            },
            required: [
              "inAmount",
              "outAmount",
              "priceImpactPct",
              "routeLabels",
            ],
            additionalProperties: true,
          },
          balancesSnapshot: {
            type: "object",
            properties: {
              solLamports: { type: "string" },
              tokens: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    mint: { type: "string" },
                    amountRaw: { type: "string" },
                    decimals: { type: "integer" },
                    uiAmount: { type: ["number", "null"] },
                  },
                  required: ["mint", "amountRaw", "decimals", "uiAmount"],
                  additionalProperties: false,
                },
              },
            },
            required: ["solLamports", "tokens"],
            additionalProperties: false,
          },
          policySnapshot: {
            type: "object",
            properties: {
              killSwitch: { type: "boolean" },
              allowedMints: { type: "array", items: { type: "string" } },
              maxTradeAmountLamports: { type: "string" },
              maxSlippageBps: { type: "integer" },
              maxPriceImpactPct: { type: "number" },
              cooldownSeconds: { type: "integer" },
              dailySpendCapLamports: { type: ["string", "null"] },
            },
            required: [
              "killSwitch",
              "allowedMints",
              "maxTradeAmountLamports",
              "maxSlippageBps",
              "maxPriceImpactPct",
              "cooldownSeconds",
            ],
            additionalProperties: true,
          },
        },
        required: ["quoteSummary", "balancesSnapshot", "policySnapshot"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: {
        quoteSummary: QuoteSummary;
        balancesSnapshot: BalancesSnapshot;
        policySnapshot: PolicySnapshot;
      },
    ) => {
      return evaluateTrade(
        input.policySnapshot,
        input.quoteSummary,
        input.balancesSnapshot,
      );
    },
  });
}

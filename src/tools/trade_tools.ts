import type { JupiterQuoteResponse } from "../jupiter/schema.js";
import type { ToolContext, ToolRegistry } from "./registry.js";
import type { ToolDeps } from "./tool_deps.js";
import type { PolicySnapshot } from "./types.js";

export function registerTradeTools(
  registry: ToolRegistry,
  deps: ToolDeps,
): void {
  const {
    jupiter,
    solMint,
    solDecimals,
    priceDecimals,
    getTokenInfoMap,
    computePriceSnapshot,
    parseScaled,
    formatScaled,
    valueFromAmount,
  } = deps;

  registry.register({
    name: "trade.jupiter_swap",
    description: "Build + sign + submit Jupiter swap transaction.",
    schema: {
      name: "trade.jupiter_swap",
      description: "Build + sign + submit Jupiter swap transaction.",
      parameters: {
        type: "object",
        properties: {
          quoteResponse: { type: "object" },
          txOptions: {
            type: "object",
            properties: {
              commitment: {
                type: "string",
                enum: ["processed", "confirmed", "finalized"],
              },
            },
            required: [],
            additionalProperties: false,
          },
        },
        required: ["quoteResponse"],
        additionalProperties: false,
      },
    },
    requires: { config: ["rpc.endpoint", "jupiter.apiKey"] },
    execute: async (
      ctx: ToolContext,
      input: {
        quoteResponse: JupiterQuoteResponse;
        txOptions?: { commitment?: "processed" | "confirmed" | "finalized" };
      },
    ) => {
      enforcePolicy(ctx.config.policy, input.quoteResponse);
      const { swap, quoteResponse: usedQuote } = await swapWithRetry(
        ctx,
        input.quoteResponse,
        jupiter,
        (request) => jupiter.swap(request),
      );
      const rawTx = Buffer.from(swap.swapTransaction, "base64");
      const signed = await ctx.solana.signRawTransaction(rawTx);
      const result = await ctx.solana.sendAndConfirmRawTx(signed, {
        commitment: input.txOptions?.commitment ?? "confirmed",
      });
      const tokenInfoMap = await getTokenInfoMap(
        [usedQuote.inputMint, usedQuote.outputMint].filter(
          (mint) => mint !== solMint,
        ),
      );
      const inputInfo = tokenInfoMap.get(usedQuote.inputMint) ?? null;
      const outputInfo = tokenInfoMap.get(usedQuote.outputMint) ?? null;

      const inputSnapshot = await computePriceSnapshot(
        usedQuote.inputMint,
        inputInfo,
      );
      const outputSnapshot = await computePriceSnapshot(
        usedQuote.outputMint,
        outputInfo,
      );

      const inputPrice =
        inputSnapshot.mid ?? inputSnapshot.bid ?? inputSnapshot.ask;
      const outputPrice =
        outputSnapshot.mid ?? outputSnapshot.bid ?? outputSnapshot.ask;

      let inputValueSol: string | null = null;
      let outputValueSol: string | null = null;

      try {
        const inputAmount = BigInt(usedQuote.inAmount ?? "0");
        const outputAmount = BigInt(usedQuote.outAmount ?? "0");
        const inputDecimals =
          usedQuote.inputMint === solMint ? solDecimals : inputInfo?.decimals;
        const outputDecimals =
          usedQuote.outputMint === solMint ? solDecimals : outputInfo?.decimals;
        const inputPriceScaled =
          usedQuote.inputMint === solMint
            ? 10n ** BigInt(priceDecimals)
            : inputPrice
              ? parseScaled(inputPrice, priceDecimals)
              : null;
        const outputPriceScaled =
          usedQuote.outputMint === solMint
            ? 10n ** BigInt(priceDecimals)
            : outputPrice
              ? parseScaled(outputPrice, priceDecimals)
              : null;
        if (inputDecimals !== undefined && inputPriceScaled) {
          inputValueSol = formatScaled(
            valueFromAmount(inputAmount, inputDecimals, inputPriceScaled),
            priceDecimals,
          );
        }
        if (outputDecimals !== undefined && outputPriceScaled) {
          outputValueSol = formatScaled(
            valueFromAmount(outputAmount, outputDecimals, outputPriceScaled),
            priceDecimals,
          );
        }
      } catch {
        inputValueSol = null;
        outputValueSol = null;
      }
      await ctx.tradeJournal.append({
        type: "swap",
        signature: result.signature,
        status: result.err ? "error" : "confirmed",
        lastValidBlockHeight: swap.lastValidBlockHeight,
        inputMint: usedQuote.inputMint,
        outputMint: usedQuote.outputMint,
        inAmount: usedQuote.inAmount,
        outAmount: usedQuote.outAmount,
        inValueSol: inputValueSol,
        outValueSol: outputValueSol,
      });
      return {
        signature: result.signature,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        status: result.err ? "error" : "confirmed",
      };
    },
  });
}

async function swapWithRetry(
  ctx: ToolContext,
  quoteResponse: JupiterQuoteResponse,
  jupiter: ToolDeps["jupiter"],
  swap: (input: {
    quoteResponse: JupiterQuoteResponse;
    userPublicKey: string;
  }) => Promise<{
    swapTransaction: string;
    lastValidBlockHeight: number;
  }>,
): Promise<{
  swap: { swapTransaction: string; lastValidBlockHeight: number };
  quoteResponse: JupiterQuoteResponse;
}> {
  try {
    return {
      swap: await swap({
        quoteResponse,
        userPublicKey: ctx.solana.getPublicKey(),
      }),
      quoteResponse,
    };
  } catch (err) {
    if (!isSwap422(err)) throw err;
    const refreshed = await reQuote(jupiter, quoteResponse);
    enforcePolicy(ctx.config.policy, refreshed);
    return {
      swap: await swap({
        quoteResponse: refreshed,
        userPublicKey: ctx.solana.getPublicKey(),
      }),
      quoteResponse: refreshed,
    };
  }
}

function isSwap422(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(" 422") || message.includes("status 422");
}

async function reQuote(
  jupiter: ToolDeps["jupiter"],
  quoteResponse: JupiterQuoteResponse,
): Promise<JupiterQuoteResponse> {
  const swapModeRaw = quoteResponse.swapMode;
  const swapMode =
    swapModeRaw === "ExactIn" || swapModeRaw === "ExactOut"
      ? swapModeRaw
      : "ExactIn";
  const amount =
    swapMode === "ExactOut"
      ? (quoteResponse.outAmount ?? quoteResponse.inAmount)
      : (quoteResponse.inAmount ?? quoteResponse.outAmount);
  if (!amount) {
    throw new Error("quote-refresh-failed: missing amount");
  }
  const slippageBps =
    typeof quoteResponse.slippageBps === "number"
      ? quoteResponse.slippageBps
      : Number(quoteResponse.slippageBps ?? 0);
  const refreshed = await jupiter.quote({
    inputMint: quoteResponse.inputMint,
    outputMint: quoteResponse.outputMint,
    amount,
    slippageBps,
    swapMode,
  });
  return refreshed.quoteResponse;
}

function enforcePolicy(
  policy: PolicySnapshot,
  quoteResponse: JupiterQuoteResponse,
): void {
  if (policy.killSwitch) {
    throw new Error("kill-switch-enabled");
  }
  const inputMint = quoteResponse.inputMint;
  const outputMint = quoteResponse.outputMint;
  if (policy.allowedMints.length > 0) {
    if (
      (inputMint && !policy.allowedMints.includes(inputMint)) ||
      (outputMint && !policy.allowedMints.includes(outputMint))
    ) {
      throw new Error("mint-not-allowed");
    }
  }
  const inAmount = quoteResponse.inAmount;
  if (policy.maxTradeAmountLamports !== "0" && inAmount) {
    if (BigInt(inAmount) > BigInt(policy.maxTradeAmountLamports)) {
      throw new Error("trade-amount-exceeds-cap");
    }
  }
  const priceImpactPctRaw = quoteResponse.priceImpactPct;
  const priceImpactPct =
    typeof priceImpactPctRaw === "string"
      ? Number(priceImpactPctRaw)
      : (priceImpactPctRaw ?? 0);
  if (priceImpactPct > policy.maxPriceImpactPct) {
    throw new Error("price-impact-too-high");
  }
}

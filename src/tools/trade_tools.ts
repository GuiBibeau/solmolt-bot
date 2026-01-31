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
      const swap = await jupiter.swap({
        quoteResponse: input.quoteResponse,
        userPublicKey: ctx.solana.getPublicKey(),
      });
      const rawTx = Buffer.from(swap.swapTransaction, "base64");
      const signed = await ctx.solana.signRawTransaction(rawTx);
      const result = await ctx.solana.sendAndConfirmRawTx(signed, {
        commitment: input.txOptions?.commitment ?? "confirmed",
      });
      const tokenInfoMap = await getTokenInfoMap(
        [input.quoteResponse.inputMint, input.quoteResponse.outputMint].filter(
          (mint) => mint !== solMint,
        ),
      );
      const inputInfo = tokenInfoMap.get(input.quoteResponse.inputMint) ?? null;
      const outputInfo =
        tokenInfoMap.get(input.quoteResponse.outputMint) ?? null;

      const inputSnapshot = await computePriceSnapshot(
        input.quoteResponse.inputMint,
        inputInfo,
      );
      const outputSnapshot = await computePriceSnapshot(
        input.quoteResponse.outputMint,
        outputInfo,
      );

      const inputPrice =
        inputSnapshot.mid ?? inputSnapshot.bid ?? inputSnapshot.ask;
      const outputPrice =
        outputSnapshot.mid ?? outputSnapshot.bid ?? outputSnapshot.ask;

      let inputValueSol: string | null = null;
      let outputValueSol: string | null = null;

      try {
        const inputAmount = BigInt(input.quoteResponse.inAmount ?? "0");
        const outputAmount = BigInt(input.quoteResponse.outAmount ?? "0");
        const inputDecimals =
          input.quoteResponse.inputMint === solMint
            ? solDecimals
            : inputInfo?.decimals;
        const outputDecimals =
          input.quoteResponse.outputMint === solMint
            ? solDecimals
            : outputInfo?.decimals;
        const inputPriceScaled =
          input.quoteResponse.inputMint === solMint
            ? 10n ** BigInt(priceDecimals)
            : inputPrice
              ? parseScaled(inputPrice, priceDecimals)
              : null;
        const outputPriceScaled =
          input.quoteResponse.outputMint === solMint
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
        inputMint: input.quoteResponse.inputMint,
        outputMint: input.quoteResponse.outputMint,
        inAmount: input.quoteResponse.inAmount,
        outAmount: input.quoteResponse.outAmount,
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

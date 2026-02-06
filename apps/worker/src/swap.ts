import type {
  JupiterClient,
  JupiterQuoteResponse,
  JupiterSwapResponse,
} from "./jupiter";
import type { NormalizedPolicy } from "./policy";
import { enforcePolicy } from "./policy";

export async function swapWithRetry(
  jupiter: JupiterClient,
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
  policy: NormalizedPolicy,
): Promise<{
  swap: JupiterSwapResponse;
  quoteResponse: JupiterQuoteResponse;
  refreshed: boolean;
}> {
  try {
    return {
      swap: await jupiter.swap({ quoteResponse, userPublicKey }),
      quoteResponse,
      refreshed: false,
    };
  } catch (err) {
    if (!isSwap422(err)) throw err;
    const refreshedQuote = await reQuote(
      jupiter,
      quoteResponse,
      policy.slippageBps,
    );
    enforcePolicy(policy, refreshedQuote);
    return {
      swap: await jupiter.swap({
        quoteResponse: refreshedQuote,
        userPublicKey,
      }),
      quoteResponse: refreshedQuote,
      refreshed: true,
    };
  }
}

function isSwap422(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(" 422") || message.includes("status 422");
}

async function reQuote(
  jupiter: JupiterClient,
  quoteResponse: JupiterQuoteResponse,
  slippageBps: number,
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
  const refreshed = await jupiter.quote({
    inputMint: quoteResponse.inputMint,
    outputMint: quoteResponse.outputMint,
    amount,
    slippageBps,
    swapMode,
  });
  return refreshed;
}

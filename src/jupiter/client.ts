import type { QuoteSummary } from "../tools/types.js";
import type { JupiterQuoteResponse, JupiterSwapResponse } from "./schema.js";
import {
  JupiterQuoteResponseSchema,
  JupiterSwapResponseSchema,
} from "./schema.js";

export type QuoteRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
};

export type QuoteResponse = JupiterQuoteResponse;

export type SwapResponse = JupiterSwapResponse;

export type SwapRequest = {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
};

export class JupiterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async quote(
    request: QuoteRequest,
  ): Promise<{ quoteResponse: QuoteResponse; summary: QuoteSummary }> {
    const url = new URL("/swap/v1/quote", this.baseUrl);
    url.searchParams.set("inputMint", request.inputMint);
    url.searchParams.set("outputMint", request.outputMint);
    url.searchParams.set("amount", request.amount);
    url.searchParams.set("slippageBps", request.slippageBps.toString());

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${response.status}`);
    }

    const data = JupiterQuoteResponseSchema.parse(await response.json());
    const routeLabels = data.routePlan.map(
      (step) => step.swapInfo.label ?? "route",
    );
    const summary: QuoteSummary = {
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      priceImpactPct: Number(data.priceImpactPct ?? 0),
      routeLabels,
    };

    return { quoteResponse: data, summary };
  }

  async swap(request: SwapRequest): Promise<SwapResponse> {
    const url = new URL("/swap/v1/swap", this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        quoteResponse: request.quoteResponse,
        userPublicKey: request.userPublicKey,
        wrapAndUnwrapSol: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Jupiter swap failed: ${response.status}`);
    }

    const data = JupiterSwapResponseSchema.parse(await response.json());
    return data;
  }
}

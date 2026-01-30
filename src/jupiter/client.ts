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
  swapMode?: "ExactIn" | "ExactOut";
  dexes?: string[];
  excludeDexes?: string[];
  onlyDirectRoutes?: boolean;
  restrictIntermediateTokens?: boolean;
};

export type QuoteResponse = JupiterQuoteResponse;

export type SwapResponse = JupiterSwapResponse;

export type SwapRequest = {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
};

export type TokenInfo = {
  id: string;
  name?: string;
  symbol?: string;
  decimals: number;
  usdPrice?: number | null;
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
    if (request.swapMode) url.searchParams.set("swapMode", request.swapMode);
    if (request.dexes && request.dexes.length > 0) {
      url.searchParams.set("dexes", request.dexes.join(","));
    }
    if (request.excludeDexes && request.excludeDexes.length > 0) {
      url.searchParams.set("excludeDexes", request.excludeDexes.join(","));
    }
    if (request.onlyDirectRoutes !== undefined) {
      url.searchParams.set(
        "onlyDirectRoutes",
        request.onlyDirectRoutes ? "true" : "false",
      );
    }
    if (request.restrictIntermediateTokens !== undefined) {
      url.searchParams.set(
        "restrictIntermediateTokens",
        request.restrictIntermediateTokens ? "true" : "false",
      );
    }

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

  async programIdToLabel(): Promise<Record<string, string>> {
    const url = new URL("/swap/v1/program-id-to-label", this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Jupiter program-id-to-label failed: ${response.status}`);
    }

    return (await response.json()) as Record<string, string>;
  }

  async searchTokens(query: string): Promise<TokenInfo[]> {
    const url = new URL("/tokens/v2/search", this.baseUrl);
    url.searchParams.set("query", query);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Jupiter token search failed: ${response.status}`);
    }

    return (await response.json()) as TokenInfo[];
  }
}

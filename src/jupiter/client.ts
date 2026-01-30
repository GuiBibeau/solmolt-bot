import type { QuoteSummary } from '../tools/types.js';

export type QuoteRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
};

export type QuoteResponse = Record<string, unknown>;

export type SwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight: number;
};

export type SwapRequest = {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
};

export class JupiterClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async quote(request: QuoteRequest): Promise<{ quoteResponse: QuoteResponse; summary: QuoteSummary }> {
    const url = new URL('/swap/v1/quote', this.baseUrl);
    url.searchParams.set('inputMint', request.inputMint);
    url.searchParams.set('outputMint', request.outputMint);
    url.searchParams.set('amount', request.amount);
    url.searchParams.set('slippageBps', request.slippageBps.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${response.status}`);
    }

    const data = (await response.json()) as QuoteResponse;
    const summary: QuoteSummary = {
      inAmount: String(data['inAmount'] ?? ''),
      outAmount: String(data['outAmount'] ?? ''),
      priceImpactPct: Number(data['priceImpactPct'] ?? 0),
      routeLabels: Array.isArray(data['routePlan'])
        ? data['routePlan'].map((step: any) => step?.swapInfo?.label ?? 'route')
        : [],
    };

    return { quoteResponse: data, summary };
  }

  async swap(request: SwapRequest): Promise<SwapResponse> {
    const url = new URL('/swap/v1/swap', this.baseUrl);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
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

    const data = (await response.json()) as SwapResponse;
    return data;
  }
}

import { z } from "zod";

const RoutePlanSchema = z
  .object({
    swapInfo: z
      .object({
        label: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const JupiterQuoteResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
    priceImpactPct: z.union([z.string(), z.number()]).optional().default(0),
    routePlan: z.array(RoutePlanSchema).optional().default([]),
  })
  .passthrough();

export const JupiterSwapResponseSchema = z.object({
  swapTransaction: z.string(),
  lastValidBlockHeight: z.coerce.number(),
});

export type JupiterQuoteResponse = z.infer<typeof JupiterQuoteResponseSchema>;
export type JupiterSwapResponse = z.infer<typeof JupiterSwapResponseSchema>;

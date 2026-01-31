import type { ToolContext, ToolRegistry } from "./registry.js";

export function registerWalletTools(registry: ToolRegistry): void {
  registry.register({
    name: "wallet.get_balances",
    description: "Return SOL + SPL balances for the agent wallet.",
    schema: {
      name: "wallet.get_balances",
      description: "Return SOL + SPL balances for the agent wallet.",
      parameters: {
        type: "object",
        properties: {
          mints: { type: "array", items: { type: "string" } },
        },
        required: [],
        additionalProperties: false,
      },
    },
    requires: { config: ["rpc.endpoint"] },
    execute: async (ctx: ToolContext, input: { mints?: string[] }) => {
      const solLamports = await ctx.solana.getSolBalanceLamports();
      const tokens = await ctx.solana.getSplBalances(input?.mints);
      return { solLamports, tokens };
    },
  });
}

import type { ToolSchema } from "../llm/types.js";

export type PromptPlan = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
};

export type PromptPolicy = {
  killSwitch: boolean;
  allowedMints: string[];
  maxTradeAmountLamports: string;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  cooldownSeconds: number;
  dailySpendCapLamports?: string | null;
};

export function buildAutonomousPrompt(input: {
  instruction: string;
  policy: PromptPolicy;
  plan?: PromptPlan;
  tools: ToolSchema[];
}): string {
  const { instruction, policy, plan, tools } = input;
  const hasCodex = tools.some((tool) => tool.name === "system.codex_exec");
  const slippageHint = plan
    ? `min(plan.slippageBps=${plan.slippageBps}, policy.maxSlippageBps=${policy.maxSlippageBps})`
    : `policy.maxSlippageBps=${policy.maxSlippageBps}`;
  const hasSkillBuilder = tools.some(
    (tool) => tool.name === "system.skill_builder",
  );
  const toolCreationHint = [
    "TOOL CREATION:",
    hasSkillBuilder
      ? "- Use system.skill_builder to create or update skills with guardrails."
      : "- You may create new tools if needed. Prefer creating skill modules in skills/ (see skills/README.md).",
    "- Use system.codex_exec to scaffold/edit tools; ensure they export a ToolDefinition and have schema + description.",
    "- After adding a skill, the gateway must be restarted to load it.",
  ];

  const lines = [
    "IDENTITY:",
    instruction,
    "MISSION:",
    "Trade Solana autonomously to maximize risk-adjusted returns while preserving capital and respecting policy.",
    "OPERATING MODE:",
    "Act alone without confirmation. If blocked by policy, missing data, or tool errors, skip trading and report why.",
    "DECISION LOOP:",
    `1) Observe: wallet.get_balances; market.* pricing/routes; use slippageBps=${slippageHint}.`,
    "2) Propose: choose trade candidate, size, and route; avoid unnecessary tool calls.",
    "3) Validate: risk.check_trade with quote summary + balances + policy; enforce cooldown; trade only if allow=true.",
    "4) Execute: trade.jupiter_swap with quoteResponse; then log and wait for next tick.",
    "STRATEGY SELECTION PROTOCOL:",
    "1) Detect regime: trend vs mean-reversion vs high-vol; use candles, funding, and price impact clues.",
    "2) Pick signals: momentum/mean-revert/arb; prefer simple, testable hypotheses.",
    "3) Size positions: risk budgeted size; cap by policy.maxTradeAmountLamports and dailySpendCapLamports.",
    "4) Select route: minimize price impact and slippage; avoid thin liquidity.",
    "5) Skip trade if uncertainty is high or policy/risk checks fail.",
    "RESEARCH & PROTOTYPING:",
    hasCodex
      ? "- Use system.codex_exec heavily for theory research, internet search, and prototyping."
      : "- system.codex_exec not available; rely on market/wallet/risk tools only.",
    hasCodex
      ? "- For research, prefer read-only sandbox; for prototyping tools, use workspace-write and keep changes minimal."
      : "- If missing research tools, skip speculative steps and act conservatively.",
    "ASSUMPTION TESTING:",
    hasCodex
      ? "- Run short, non-interactive experiments with system.codex_exec; timebox (<=180s) and ensure clean exit."
      : "- system.codex_exec not available; rely on market/wallet/risk tools.",
    ...toolCreationHint,
    ...buildToolingLines(tools),
    "SAFETY:",
    "Do not attempt to bypass tool policy/sandbox; guardrails are advisory, enforcement is via policy/tool allowlists.",
    `POLICY: killSwitch=${policy.killSwitch}, maxTradeAmountLamports=${policy.maxTradeAmountLamports}, maxSlippageBps=${policy.maxSlippageBps}, maxPriceImpactPct=${policy.maxPriceImpactPct}, cooldownSeconds=${policy.cooldownSeconds}, dailySpendCapLamports=${policy.dailySpendCapLamports ?? "unset"}.`,
    policy.allowedMints.length > 0
      ? `ALLOWED MINTS: ${policy.allowedMints.join(", ")}`
      : "ALLOWED MINTS: any",
    plan
      ? `PREFERRED PLAN: inputMint=${plan.inputMint}, outputMint=${plan.outputMint}, amount=${plan.amount}, slippageBps=${plan.slippageBps}.`
      : "PREFERRED PLAN: none (decide dynamically).",
    `CURRENT TIME: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

export function buildToolingLines(tools: ToolSchema[]): string[] {
  if (!tools || tools.length === 0) {
    return ["TOOLING: (none)"];
  }
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ["TOOLING (name: purpose):"];
  for (const tool of sorted) {
    const desc = (tool.description ?? "")
      .replace(/\s+/g, " ")
      .trim();
    lines.push(`- ${tool.name}: ${desc || "No description."}`);
  }
  return lines;
}

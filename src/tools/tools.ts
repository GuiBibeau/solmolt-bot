import type { JupiterClient } from "../jupiter/client.js";
import { registerMarketTools } from "./market_tools.js";
import { registerOpenClawTools } from "./openclaw_tools.js";
import type { ToolRegistry } from "./registry.js";
import { registerRiskTools } from "./risk_tools.js";
import { registerRuntimeTools } from "./runtime_tools.js";
import { registerSystemTools } from "./system_tools.js";
import { createToolDeps } from "./tool_deps.js";
import { registerTradeTools } from "./trade_tools.js";
import { registerWalletTools } from "./wallet_tools.js";

export function registerDefaultTools(
  registry: ToolRegistry,
  jupiter: JupiterClient,
): void {
  const deps = createToolDeps(jupiter);
  registerWalletTools(registry);
  registerMarketTools(registry, deps);
  registerOpenClawTools(registry);
  registerRiskTools(registry, deps);
  registerTradeTools(registry, deps);
  registerSystemTools(registry);
  registerRuntimeTools(registry);
}

import { openClawInvokeTool } from "./openclaw_gateway.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

export function registerOpenClawTools(registry: ToolRegistry): void {
  registry.register({
    name: "openclaw.invoke",
    description: "Invoke a tool on an OpenClaw gateway.",
    schema: {
      name: "openclaw.invoke",
      description: "Invoke a tool on an OpenClaw gateway.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string" },
          args: { type: "object" },
          action: { type: "string" },
        },
        required: ["tool"],
        additionalProperties: false,
      },
    },
    requires: {
      config: ["openclaw.gateway.baseUrl", "openclaw.gateway.token"],
    },
    execute: async (
      ctx: ToolContext,
      input: { tool: string; args?: Record<string, unknown>; action?: string },
    ) => {
      const cfg = ctx.config.openclaw?.gateway;
      if (!cfg) {
        throw new Error("openclaw gateway not configured");
      }
      return openClawInvokeTool(
        {
          baseUrl: cfg.baseUrl,
          token: cfg.token,
          sessionKey: cfg.sessionKey,
          messageChannel: cfg.messageChannel,
          accountId: cfg.accountId,
        },
        input.tool,
        input.args ?? {},
        input.action,
      );
    },
  });
}

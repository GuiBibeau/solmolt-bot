import { info } from "../util/logger.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

export function registerSystemTools(registry: ToolRegistry): void {
  registry.register({
    name: "system.autopilot_tick",
    description: "Timer-driven autonomous iteration.",
    schema: {
      name: "system.autopilot_tick",
      description: "Timer-driven autonomous iteration.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", enum: ["timer", "operator", "recovery"] },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { reason: "timer" | "operator" | "recovery" },
    ) => {
      info("autopilot tick", { reason: input.reason });
      if (ctx.runtime) {
        return ctx.runtime.submitAutopilotTick(input.reason);
      }
      if (ctx.agent) {
        return ctx.agent.tick(input.reason);
      }
      return {
        actionsTaken: [],
        nextTickInMs: ctx.config.autopilot.intervalMs,
      };
    },
  });

  registry.register({
    name: "agent.message",
    description: "Inject an operator message into the agent loop.",
    schema: {
      name: "agent.message",
      description: "Inject an operator message into the agent loop.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          triggerTick: { type: "boolean" },
          sessionKey: { type: "string" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { content: string; triggerTick?: boolean; sessionKey?: string },
    ) => {
      if (ctx.runtime) {
        return ctx.runtime.submitMessage({
          sessionKey: input.sessionKey ?? "operator",
          content: input.content,
          triggerRun: input.triggerTick,
        });
      }
      if (!ctx.agentControl) {
        return { ok: false, error: "agent-control-missing" };
      }
      return ctx.agentControl.message({
        content: input.content,
        triggerTick: input.triggerTick,
      });
    },
  });

  registry.register({
    name: "notify.emit",
    description: "Emit operator notifications to console or webhook.",
    schema: {
      name: "notify.emit",
      description: "Emit operator notifications to console or webhook.",
      parameters: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["info", "warn", "error"] },
          message: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["level", "message"],
        additionalProperties: false,
      },
    },
    execute: async (
      _ctx: ToolContext,
      input: {
        level: "info" | "warn" | "error";
        message: string;
        metadata?: Record<string, unknown>;
      },
    ) => {
      if (input.level === "warn") {
        info(`WARN: ${input.message}`, input.metadata);
      } else if (input.level === "error") {
        info(`ERROR: ${input.message}`, input.metadata);
      } else {
        info(input.message, input.metadata);
      }
      return { ok: true };
    },
  });
}

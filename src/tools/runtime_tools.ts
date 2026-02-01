import type { ToolContext, ToolRegistry } from "./registry.js";

export function registerRuntimeTools(registry: ToolRegistry): void {
  registry.register({
    name: "sessions.list",
    description: "List known agent sessions.",
    schema: {
      name: "sessions.list",
      description: "List known agent sessions.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    execute: async (ctx: ToolContext) => {
      if (!ctx.runtime) return [];
      return ctx.runtime.listSessions();
    },
  });

  registry.register({
    name: "sessions.history",
    description: "Fetch session history entries.",
    schema: {
      name: "sessions.history",
      description: "Fetch session history entries.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string" },
          limit: { type: "number" },
        },
        required: ["sessionKey"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { sessionKey: string; limit?: number },
    ) => {
      if (!ctx.runtime) return [];
      return ctx.runtime.getSessionHistory(input.sessionKey, input.limit);
    },
  });

  registry.register({
    name: "sessions.send",
    description: "Send a message into a session.",
    schema: {
      name: "sessions.send",
      description: "Send a message into a session.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string" },
          content: { type: "string" },
          agentId: { type: "string" },
          triggerRun: { type: "boolean" },
        },
        required: ["sessionKey", "content"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: {
        sessionKey: string;
        content: string;
        agentId?: string;
        triggerRun?: boolean;
      },
    ) => {
      if (!ctx.runtime) {
        return { ok: false, error: "runtime-missing" };
      }
      return ctx.runtime.submitMessage({
        sessionKey: input.sessionKey,
        content: input.content,
        agentId: input.agentId,
        triggerRun: input.triggerRun,
      });
    },
  });

  registry.register({
    name: "sessions.spawn",
    description: "Spawn a subagent run in a new session.",
    schema: {
      name: "sessions.spawn",
      description: "Spawn a subagent run in a new session.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
          label: { type: "string" },
          agentId: { type: "string" },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { task: string; label?: string; agentId?: string },
    ) => {
      if (!ctx.runtime) {
        return { ok: false, error: "runtime-missing" };
      }
      if (ctx.agentMeta && !ctx.agentMeta.canSpawnSubagents) {
        return { ok: false, error: "subagent-spawn-forbidden" };
      }
      return ctx.runtime.spawnSubagent({
        task: input.task,
        label: input.label,
        agentId: input.agentId,
        parentRunId: ctx.agentMeta?.runId,
        parentSessionKey: ctx.agentMeta?.sessionKey,
      });
    },
  });

  registry.register({
    name: "runs.status",
    description: "Fetch run status by runId.",
    schema: {
      name: "runs.status",
      description: "Fetch run status by runId.",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
        additionalProperties: false,
      },
    },
    execute: async (ctx: ToolContext, input: { runId: string }) => {
      if (!ctx.runtime) return null;
      return ctx.runtime.getRun(input.runId);
    },
  });

  registry.register({
    name: "runs.wait",
    description: "Wait for a run to complete.",
    schema: {
      name: "runs.wait",
      description: "Wait for a run to complete.",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["runId"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { runId: string; timeoutMs?: number },
    ) => {
      if (!ctx.runtime) return null;
      return ctx.runtime.wait(input.runId, input.timeoutMs);
    },
  });
}

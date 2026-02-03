import { TaskStore } from "../runtime/task_store.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "canceled";

function getSessionKey(
  ctx: ToolContext,
  input?: { sessionKey?: string },
): string {
  const key = input?.sessionKey ?? ctx.agentMeta?.sessionKey;
  if (!key) {
    throw new Error("session-key-required");
  }
  return key;
}

function getStore(ctx: ToolContext): TaskStore {
  const dir = ctx.config.runtime.tasksDir ?? "tasks";
  return new TaskStore(dir);
}

export function registerTaskTools(registry: ToolRegistry): void {
  registry.register({
    name: "tasks.list",
    description: "List tasks for the current session.",
    schema: {
      name: "tasks.list",
      description: "List tasks for the current session.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    execute: async (ctx: ToolContext, input: { sessionKey?: string }) => {
      const sessionKey = getSessionKey(ctx, input);
      const store = getStore(ctx);
      return store.list(sessionKey);
    },
  });

  registry.register({
    name: "tasks.create",
    description: "Create a task for the current session.",
    schema: {
      name: "tasks.create",
      description: "Create a task for the current session.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          status: {
            type: "string",
            enum: ["open", "in_progress", "blocked", "done", "canceled"],
          },
          metadata: { type: "object" },
          sessionKey: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: {
        title: string;
        status?: TaskStatus;
        metadata?: Record<string, unknown>;
        sessionKey?: string;
      },
    ) => {
      const sessionKey = getSessionKey(ctx, input);
      const store = getStore(ctx);
      return store.create(sessionKey, {
        title: input.title,
        status: input.status ?? "open",
        metadata: input.metadata,
      });
    },
  });

  registry.register({
    name: "tasks.update",
    description: "Update a task (title/status/metadata).",
    schema: {
      name: "tasks.update",
      description: "Update a task (title/status/metadata).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          status: {
            type: "string",
            enum: ["open", "in_progress", "blocked", "done", "canceled"],
          },
          metadata: { type: "object" },
          sessionKey: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: {
        taskId: string;
        title?: string;
        status?: TaskStatus;
        metadata?: Record<string, unknown>;
        sessionKey?: string;
      },
    ) => {
      const sessionKey = getSessionKey(ctx, input);
      const store = getStore(ctx);
      return store.update(sessionKey, input.taskId, {
        title: input.title,
        status: input.status,
        metadata: input.metadata,
      });
    },
  });

  registry.register({
    name: "tasks.add_note",
    description: "Append a note to a task.",
    schema: {
      name: "tasks.add_note",
      description: "Append a note to a task.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          note: { type: "string" },
          sessionKey: { type: "string" },
        },
        required: ["taskId", "note"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { taskId: string; note: string; sessionKey?: string },
    ) => {
      const sessionKey = getSessionKey(ctx, input);
      const store = getStore(ctx);
      return store.addNote(sessionKey, input.taskId, input.note);
    },
  });

  registry.register({
    name: "tasks.complete",
    description: "Mark a task as done.",
    schema: {
      name: "tasks.complete",
      description: "Mark a task as done.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          sessionKey: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { taskId: string; sessionKey?: string },
    ) => {
      const sessionKey = getSessionKey(ctx, input);
      const store = getStore(ctx);
      return store.update(sessionKey, input.taskId, { status: "done" });
    },
  });

  registry.register({
    name: "tasks.cancel",
    description: "Cancel a task.",
    schema: {
      name: "tasks.cancel",
      description: "Cancel a task.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          sessionKey: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    execute: async (
      ctx: ToolContext,
      input: { taskId: string; sessionKey?: string },
    ) => {
      const sessionKey = getSessionKey(ctx, input);
      const store = getStore(ctx);
      return store.update(sessionKey, input.taskId, { status: "canceled" });
    },
  });
}

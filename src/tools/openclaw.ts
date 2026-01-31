import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolSchema } from "../llm/types.js";
import { randomId } from "../util/id.js";
import { error, info, warn } from "../util/logger.js";
import { isRecord } from "../util/types.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

export type OpenClawJsonSchema = Record<string, unknown>;

export type OpenClawContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; data?: string; mimeType?: string }
  | { type: "file"; path: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

export type OpenClawToolResult =
  | { content: OpenClawContentPart[]; [key: string]: unknown }
  | string
  | unknown;

export type OpenClawToolContext = {
  callId: string;
  toolContext: ToolContext;
  logger?: OpenClawLogger;
  runtime?: unknown;
};

export type OpenClawToolDef<P = Record<string, unknown>> = {
  name: string;
  description?: string;
  parameters: OpenClawJsonSchema;
  execute: (
    id: string,
    params: P,
    ctx?: OpenClawToolContext,
  ) => Promise<OpenClawToolResult>;
};

export type OpenClawRegisterOpts = {
  optional?: boolean;
};

export type OpenClawLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type OpenClawApiShim = {
  registerTool: (tool: OpenClawToolDef, opts?: OpenClawRegisterOpts) => void;
  logger?: OpenClawLogger;
  runtime?: unknown;
};

type OpenClawPluginFunction = (api: OpenClawApiShim) => void | Promise<void>;

type OpenClawPluginObject = {
  id?: string;
  name?: string;
  configSchema?: OpenClawJsonSchema;
  register: OpenClawPluginFunction;
};

type OpenClawPluginExport = OpenClawPluginFunction | OpenClawPluginObject;

const SUPPORTED_EXTS = new Set([".ts", ".js", ".mjs"]);

export function normalizeOpenClawResult(result: OpenClawToolResult): {
  content: OpenClawContentPart[];
} {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  if (isRecord(result) && Array.isArray(result.content)) {
    return result as { content: OpenClawContentPart[] };
  }
  if (result === undefined) {
    return { content: [{ type: "text", text: "" }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export function createOpenClawApiShim(
  registry: ToolRegistry,
  options: {
    logger?: OpenClawLogger;
    runtime?: unknown;
    namePrefix?: string;
    onRegister?: (name: string) => void;
  } = {},
): OpenClawApiShim {
  const logger: OpenClawLogger =
    options.logger ??
    ({
      info: (...args) => info("openclaw", { args }),
      warn: (...args) => warn("openclaw", { args }),
      error: (...args) => error("openclaw.error", { args }),
    } satisfies OpenClawLogger);

  return {
    logger,
    runtime: options.runtime,
    registerTool: (tool, opts) => {
      if (!tool || typeof tool.name !== "string") {
        throw new Error("openclaw tool missing name");
      }
      if (!isRecord(tool.parameters)) {
        throw new Error(`openclaw tool ${tool.name} missing parameters`);
      }
      const name = options.namePrefix
        ? `${options.namePrefix}${tool.name}`
        : tool.name;
      const description = tool.description ?? "";
      const schema: ToolSchema = {
        name,
        description,
        parameters: isObjectSchema(tool.parameters)
          ? tool.parameters
          : { type: "object", properties: {}, additionalProperties: true },
      };
      registry.register({
        name,
        description,
        schema,
        execute: async (ctx: ToolContext, input: Record<string, unknown>) => {
          const callId = randomId("openclaw");
          const result = await tool.execute(callId, input as never, {
            callId,
            toolContext: ctx,
            logger,
            runtime: options.runtime,
          });
          return normalizeOpenClawResult(result);
        },
      });
      options.onRegister?.(name);
      if (opts?.optional) {
        logger.info("openclaw optional tool registered", name);
      }
    },
  };
}

export async function loadOpenClawPluginIntoRegistry(
  registry: ToolRegistry,
  pluginModule: unknown,
  options: {
    pluginId?: string;
    logger?: OpenClawLogger;
    runtime?: unknown;
    namePrefix?: string;
  } = {},
): Promise<string[]> {
  const registered: string[] = [];
  const api = createOpenClawApiShim(registry, {
    ...options,
    onRegister: (name) => registered.push(name),
  });
  const plugin = resolveOpenClawPlugin(pluginModule);
  if (!plugin) {
    const id = options.pluginId ? ` (${options.pluginId})` : "";
    throw new Error(`Unsupported OpenClaw plugin export${id}`);
  }
  await pluginRegister(plugin, api);
  return registered;
}

export async function loadOpenClawPluginsFromDir(
  registry: ToolRegistry,
  dir?: string,
): Promise<void> {
  if (!dir) return;
  const resolved = path.resolve(dir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(resolved);
  } catch (err) {
    warn("openclaw plugins directory missing or unreadable", {
      dir: resolved,
      err: String(err),
    });
    return;
  }

  for (const entry of entries) {
    const ext = path.extname(entry);
    if (!SUPPORTED_EXTS.has(ext)) continue;
    const fullPath = path.join(resolved, entry);
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      const before = registry.list().length;
      await loadOpenClawPluginIntoRegistry(registry, mod, {
        pluginId: entry,
      });
      const after = registry.list().length;
      info("openclaw plugin loaded", {
        file: fullPath,
        tools: after - before,
      });
    } catch (err) {
      warn("failed to load openclaw plugin", {
        file: fullPath,
        err: String(err),
      });
    }
  }
}

function isObjectSchema(schema: OpenClawJsonSchema): boolean {
  const type = schema.type;
  return typeof type === "string" && type.toLowerCase() === "object";
}

function resolveOpenClawPlugin(
  moduleValue: unknown,
): OpenClawPluginExport | null {
  const candidate =
    isRecord(moduleValue) && "default" in moduleValue
      ? moduleValue.default
      : moduleValue;
  if (isOpenClawPluginFunction(candidate)) {
    return candidate;
  }
  if (isOpenClawPluginObject(candidate)) {
    return candidate;
  }
  return null;
}

function isOpenClawPluginObject(value: unknown): value is OpenClawPluginObject {
  return isRecord(value) && typeof value.register === "function";
}

function isOpenClawPluginFunction(
  value: unknown,
): value is OpenClawPluginFunction {
  return typeof value === "function";
}

async function pluginRegister(
  plugin: OpenClawPluginExport,
  api: OpenClawApiShim,
): Promise<void> {
  if (typeof plugin === "function") {
    await plugin(api);
    return;
  }
  await plugin.register(api);
}

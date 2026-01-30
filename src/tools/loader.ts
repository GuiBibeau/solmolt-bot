import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { info, warn } from "../util/logger.js";
import type { ToolDefinition, ToolRegistry } from "./registry.js";

export type SkillModule = {
  default?: ToolDefinition | (() => ToolDefinition);
  tool?: ToolDefinition | (() => ToolDefinition);
};

const SUPPORTED_EXTS = new Set([".ts", ".js", ".mjs"]);

export async function loadSkillsFromDir(
  registry: ToolRegistry,
  dir: string,
): Promise<void> {
  const resolved = path.resolve(dir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(resolved);
  } catch (err) {
    warn("skills directory missing or unreadable", {
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
      const mod = (await import(pathToFileURL(fullPath).href)) as SkillModule;
      const tool = resolveTool(mod);
      if (!tool) {
        warn("skill file has no tool export", { file: fullPath });
        continue;
      }
      registry.register(tool);
      info("skill loaded", { name: tool.name, file: fullPath });
    } catch (err) {
      warn("failed to load skill", { file: fullPath, err: String(err) });
    }
  }
}

function resolveTool(mod: SkillModule): ToolDefinition | null {
  const candidate = mod.default ?? mod.tool;
  if (!candidate) return null;
  if (typeof candidate === "function") {
    return candidate();
  }
  return candidate;
}

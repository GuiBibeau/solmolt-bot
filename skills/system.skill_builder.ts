import path from "node:path";
import fs from "node:fs/promises";
import type { ToolDefinition, ToolContext } from "../src/tools/registry.js";
import codexTool from "./system.codex_exec.ts";

type SkillBuilderInput = {
  fileName: string;
  spec?: string;
  source?: string;
  overwrite?: boolean;
  restartGateway?: boolean;
  restartTimeoutMs?: number;
  codexModel?: string;
  codexProfile?: string;
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  codexConfig?: string[];
  codexTimeoutMs?: number;
  codexMaxOutputChars?: number;
};

type SkillBuilderOutput = {
  ok: boolean;
  path: string;
  created: boolean;
  usedCodex: boolean;
  codexResult?: unknown;
  restartResult?: unknown;
  warnings?: string[];
};

const ALLOWED_EXTS = new Set([".ts", ".js", ".mjs"]);

function normalizeFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("file-name-missing");
  }
  const base = path.basename(trimmed);
  if (base !== trimmed) {
    throw new Error("file-name-invalid");
  }
  const ext = path.extname(base);
  if (!ext) {
    return `${base}.ts`;
  }
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error("file-extension-not-allowed");
  }
  return base;
}

function assertSafePath(skillsDir: string, fileName: string): string {
  const fullPath = path.resolve(skillsDir, fileName);
  if (!fullPath.startsWith(`${skillsDir}${path.sep}`)) {
    throw new Error("file-path-invalid");
  }
  return fullPath;
}

async function runCodex(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!codexTool || codexTool.name !== "system.codex_exec") {
    throw new Error("system-codex-exec-missing");
  }
  return codexTool.execute(ctx, input as never);
}

function buildCodexPrompt(spec: string, targetPath: string): string {
  return [
    "You are creating a Serious Trader Ralph skill tool.",
    `Write exactly one file at: ${targetPath}`,
    "Constraints:",
    "- Only create or overwrite that file.",
    "- Do not modify any other files.",
    "- Do not run tests.",
    "- Use ASCII only.",
    "- Export a ToolDefinition (export default tool or export const tool).",
    "- Include a schema with name/description/parameters; additionalProperties false.",
    "Specification:",
    spec.trim(),
  ].join("\n");
}

const tool: ToolDefinition<SkillBuilderInput, SkillBuilderOutput> = {
  name: "system.skill_builder",
  description:
    "Create or update a skill tool in skills/ with guardrails, optionally using system.codex_exec, and restart the gateway.",
  schema: {
    name: "system.skill_builder",
    description:
      "Create or update a skill tool in skills/ with guardrails, optionally using system.codex_exec, and restart the gateway.",
    parameters: {
      type: "object",
      properties: {
        fileName: { type: "string" },
        spec: { type: "string" },
        source: { type: "string" },
        overwrite: { type: "boolean" },
        restartGateway: { type: "boolean" },
        restartTimeoutMs: { type: "number" },
        codexModel: { type: "string" },
        codexProfile: { type: "string" },
        codexSandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
        },
        codexConfig: { type: "array", items: { type: "string" } },
        codexTimeoutMs: { type: "number" },
        codexMaxOutputChars: { type: "number" },
      },
      required: ["fileName"],
      additionalProperties: false,
    },
  },
  execute: async (ctx, input) => {
    const warnings: string[] = [];
    const fileName = normalizeFileName(input.fileName);
    const skillsDir = path.resolve(process.cwd(), "skills");
    const targetPath = assertSafePath(skillsDir, fileName);

    if (input.source && input.spec) {
      throw new Error("provide-source-or-spec-not-both");
    }
    if (!input.source && !input.spec) {
      throw new Error("provide-source-or-spec");
    }

    let usedCodex = false;
    let codexResult: unknown;

    try {
      await fs.mkdir(skillsDir, { recursive: true });
    } catch (err) {
      throw new Error(`skills-dir-unavailable: ${String(err)}`);
    }

    const exists = await fs
      .stat(targetPath)
      .then(() => true)
      .catch(() => false);
    if (exists && !input.overwrite) {
      throw new Error("skill-file-exists");
    }

    if (input.source) {
      await fs.writeFile(targetPath, `${input.source}\n`, "utf8");
    } else if (input.spec) {
      usedCodex = true;
      codexResult = await runCodex(ctx, {
        prompt: buildCodexPrompt(input.spec, targetPath),
        model: input.codexModel,
        profile: input.codexProfile,
        sandbox: input.codexSandbox ?? "workspace-write",
        fullAuto: true,
        json: true,
        config: input.codexConfig,
        cwd: process.cwd(),
        timeoutMs: input.codexTimeoutMs ?? 180_000,
        maxOutputChars: input.codexMaxOutputChars ?? 40_000,
        captureLastMessage: true,
      });
    }

    const created = await fs
      .stat(targetPath)
      .then(() => true)
      .catch(() => false);
    if (!created) {
      throw new Error("skill-file-missing-after-write");
    }

    const contents = await fs.readFile(targetPath, "utf8");
    if (
      !/export\\s+default\\s+/m.test(contents) &&
      !/export\\s+const\\s+tool/m.test(contents)
    ) {
      warnings.push("skill-export-missing");
    }
    if (!/schema\\s*:/m.test(contents)) {
      warnings.push("schema-missing");
    }

    let restartResult: unknown;
    if (input.restartGateway ?? true) {
      restartResult = await runCodex(ctx, {
        prompt: [
          "Run the following command exactly, then exit:",
          "bun run gateway:restart",
          "Do not modify files.",
        ].join("\n"),
        sandbox: "read-only",
        fullAuto: true,
        json: true,
        cwd: process.cwd(),
        timeoutMs: input.restartTimeoutMs ?? 60_000,
        maxOutputChars: 10_000,
        captureLastMessage: true,
      });
    }

    return {
      ok: true,
      path: targetPath,
      created,
      usedCodex,
      codexResult,
      restartResult,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};

export default tool;

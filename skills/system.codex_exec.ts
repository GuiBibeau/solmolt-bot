import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../src/tools/registry.js";

type CodexExecInput = {
  prompt: string;
  model?: string;
  profile?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  fullAuto?: boolean;
  bypassSandbox?: boolean;
  config?: string[];
  cwd?: string;
  timeoutMs?: number;
  json?: boolean;
  captureLastMessage?: boolean;
  maxOutputChars?: number;
};

type CodexExecOutput = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  lastMessage?: string | null;
};

const tool: ToolDefinition<CodexExecInput, CodexExecOutput> = {
  name: "system.codex_exec",
  description:
    "Run Codex CLI non-interactively for research, assumption testing, and prototyping (fully autonomous, exits cleanly).",
  schema: {
    name: "system.codex_exec",
    description:
      "Run Codex CLI non-interactively for research, assumption testing, and prototyping (fully autonomous, exits cleanly).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string" },
        profile: { type: "string" },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
        },
        fullAuto: { type: "boolean" },
        bypassSandbox: { type: "boolean" },
        config: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        json: { type: "boolean" },
        captureLastMessage: { type: "boolean" },
        maxOutputChars: { type: "number" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  execute: async (_ctx, input) => {
    const started = Date.now();
    const timeoutMs =
      typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? input.timeoutMs
        : 180_000;
    const maxOutputChars =
      typeof input.maxOutputChars === "number" && input.maxOutputChars > 0
        ? Math.floor(input.maxOutputChars)
        : 200_000;
    const cwd = input.cwd || process.cwd();
    const args: string[] = ["exec", "--color", "never", "--cd", cwd];

    if (input.model) {
      args.push("--model", input.model);
    }
    if (input.profile) {
      args.push("--profile", input.profile);
    }
    if (input.sandbox) {
      args.push("--sandbox", input.sandbox);
    }
    if (input.fullAuto ?? true) {
      args.push("--full-auto");
    }
    if (input.bypassSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (input.json ?? true) {
      args.push("--json");
    }
    if (Array.isArray(input.config)) {
      for (const entry of input.config) {
        if (entry && typeof entry === "string") {
          args.push("--config", entry);
        }
      }
    }

    let lastMessagePath: string | null = null;
    if (input.captureLastMessage ?? true) {
      const tmpDir = path.join(os.tmpdir(), "ralph-codex");
      await fs.mkdir(tmpDir, { recursive: true });
      lastMessagePath = path.join(
        tmpDir,
        `last-message-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      args.push("--output-last-message", lastMessagePath);
    }

    args.push(input.prompt);

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const child = spawn("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const trimBuffer = (
      current: string,
      chunk: string,
      truncatedFlag: boolean,
    ): { text: string; truncated: boolean } => {
      let next = current + chunk;
      if (next.length <= maxOutputChars) {
        return { text: next, truncated: truncatedFlag };
      }
      next = next.slice(next.length - maxOutputChars);
      return { text: next, truncated: true };
    };

    child.stdout?.on("data", (data) => {
      const result = trimBuffer(stdout, data.toString(), stdoutTruncated);
      stdout = result.text;
      stdoutTruncated = result.truncated;
    });

    child.stderr?.on("data", (data) => {
      const result = trimBuffer(stderr, data.toString(), stderrTruncated);
      stderr = result.text;
      stderrTruncated = result.truncated;
    });

    const exit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        stderr = stderr || String(err);
        resolve({ code: 1, signal: null });
      });
    });

    let lastMessage: string | null | undefined;
    if (lastMessagePath) {
      try {
        lastMessage = await fs.readFile(lastMessagePath, "utf8");
      } catch {
        lastMessage = null;
      } finally {
        try {
          await fs.unlink(lastMessagePath);
        } catch {
          // ignore cleanup failures
        }
      }
    }

    return {
      ok: !timedOut && exit.code === 0,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      durationMs: Date.now() - started,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      lastMessage,
    };
  },
};

export default tool;

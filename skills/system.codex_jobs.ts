import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../src/tools/registry.js";
import { randomId } from "../src/util/id.js";

type CodexJobInput = {
  action: "start" | "status" | "cancel";
  prompt?: string;
  jobId?: string;
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
  includeOutput?: boolean;
  includeLastMessage?: boolean;
};

type CodexJobStatus = "running" | "completed" | "failed" | "timed_out";

type CodexJobRecord = {
  id: string;
  pid: number;
  startedAt: string;
  completedAt?: string;
  status: CodexJobStatus;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  lastMessagePath?: string | null;
  child: ReturnType<typeof spawn>;
};

const jobs = new Map<string, CodexJobRecord>();

const ensureJobDir = async (): Promise<string> => {
  const dir = path.join(os.tmpdir(), "ralph-codex-jobs");
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const readTail = async (
  filePath: string,
  maxChars: number,
): Promise<string> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (raw.length <= maxChars) return raw;
    return raw.slice(raw.length - maxChars);
  } catch {
    return "";
  }
};

const buildArgs = (input: CodexJobInput, lastMessagePath?: string) => {
  const args: string[] = ["exec", "--color", "never"];
  if (input.cwd) {
    args.push("--cd", input.cwd);
  }
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
  if (lastMessagePath) {
    args.push("--output-last-message", lastMessagePath);
  }
  args.push(input.prompt);
  return args;
};

const startCodexJob = async (input: CodexJobInput) => {
  if (!input.prompt) {
    throw new Error("prompt-required");
  }
  const jobDir = await ensureJobDir();
  const id = randomId("codex");
  const stdoutPath = path.join(jobDir, `${id}.stdout.jsonl`);
  const stderrPath = path.join(jobDir, `${id}.stderr.log`);
  const lastMessagePath =
    (input.captureLastMessage ?? true)
      ? path.join(jobDir, `${id}.last.txt`)
      : null;
  const args = buildArgs(input, lastMessagePath ?? undefined);
  const child = spawn("codex", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });
  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? input.timeoutMs
      : 180_000;

  const record: CodexJobRecord = {
    id,
    pid: child.pid ?? 0,
    startedAt: new Date().toISOString(),
    status: "running",
    timeoutMs,
    stdoutPath,
    stderrPath,
    lastMessagePath,
    child,
  };

  jobs.set(id, record);

  const timeout = setTimeout(() => {
    record.timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, timeoutMs);

  const finalize = (code: number | null, signal: string | null) => {
    clearTimeout(timeout);
    record.exitCode = code;
    record.signal = signal;
    record.completedAt = new Date().toISOString();
    record.status = record.timedOut
      ? "timed_out"
      : code === 0
        ? "completed"
        : "failed";
    stdoutStream.end();
    stderrStream.end();
  };

  child.on("close", (code, signal) => finalize(code, signal));
  child.on("error", (_err) => finalize(1, null));

  return {
    ok: true,
    jobId: id,
    pid: record.pid,
    startedAt: record.startedAt,
    timeoutMs,
  };
};

const tool: ToolDefinition<CodexJobInput> = {
  name: "system.codex_job",
  description: "Manage background Codex jobs: start, status, or cancel.",
  schema: {
    name: "system.codex_job",
    description: "Manage background Codex jobs: start, status, or cancel.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "cancel"] },
        prompt: { type: "string" },
        jobId: { type: "string" },
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
        includeOutput: { type: "boolean" },
        includeLastMessage: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  execute: async (_ctx, input) => {
    if (input.action === "start") {
      return startCodexJob(input);
    }
    if (input.action === "status") {
      if (!input.jobId) {
        return { ok: false, error: "jobId-required" };
      }
      const record = jobs.get(input.jobId);
      if (!record) {
        return { ok: false, error: "job-not-found" };
      }
      const maxOutputChars =
        typeof input.maxOutputChars === "number" && input.maxOutputChars > 0
          ? input.maxOutputChars
          : 8_000;
      const includeOutput = input.includeOutput ?? false;
      const includeLastMessage = input.includeLastMessage ?? true;

      const stdout = includeOutput
        ? await readTail(record.stdoutPath, maxOutputChars)
        : undefined;
      const stderr = includeOutput
        ? await readTail(record.stderrPath, maxOutputChars)
        : undefined;
      let lastMessage: string | undefined;
      if (includeLastMessage && record.lastMessagePath) {
        lastMessage = await readTail(record.lastMessagePath, maxOutputChars);
      }

      return {
        ok: true,
        jobId: record.id,
        pid: record.pid,
        status: record.status,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        timeoutMs: record.timeoutMs,
        exitCode: record.exitCode ?? null,
        signal: record.signal ?? null,
        timedOut: record.timedOut ?? false,
        stdout,
        stderr,
        lastMessage,
      };
    }
    if (input.action === "cancel") {
      if (!input.jobId) {
        return { ok: false, error: "jobId-required" };
      }
      const record = jobs.get(input.jobId);
      if (!record) {
        return { ok: false, error: "job-not-found" };
      }
      if (record.status !== "running") {
        return { ok: false, error: "job-not-running", status: record.status };
      }
      try {
        record.child.kill("SIGKILL");
        record.timedOut = true;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    return { ok: false, error: "invalid-action" };
  },
};

export default tool;

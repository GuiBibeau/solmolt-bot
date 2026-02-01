import fs from "node:fs/promises";
import path from "node:path";
import type { LlmMessage } from "../llm/types.js";
import { appendJsonl } from "../util/jsonl.js";
import { isErrnoException, isRecord } from "../util/types.js";
import type { SessionHistoryEntry, SessionSummary } from "./types.js";

export class SessionStore {
  constructor(private readonly baseDir = "sessions") {}

  async append(sessionKey: string, entry: SessionHistoryEntry): Promise<void> {
    const filePath = this.resolveSessionPath(sessionKey);
    await appendJsonl(filePath, entry);
  }

  async read(
    sessionKey: string,
    limit?: number,
  ): Promise<SessionHistoryEntry[]> {
    const filePath = this.resolveSessionPath(sessionKey);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const entries: SessionHistoryEntry[] = [];
      const lines = raw.split("\n").map((line) => line.trim());
      for (const line of lines) {
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) {
          entries.push(parsed);
        }
      }
      if (limit && limit > 0) {
        return entries.slice(-limit);
      }
      return entries;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async list(): Promise<SessionSummary[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      const summaries: SessionSummary[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionKey = entry.slice(0, -".jsonl".length);
        const stat = await fs.stat(path.join(this.baseDir, entry));
        summaries.push({
          sessionKey,
          updatedAt: stat.mtime.toISOString(),
        });
      }
      summaries.sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      );
      return summaries;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async getMessages(sessionKey: string): Promise<LlmMessage[]> {
    const entries = await this.read(sessionKey);
    const messages: LlmMessage[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (isRecord(message) && typeof message.role === "string") {
        messages.push(normalizeToolCalls(message as LlmMessage));
      }
    }
    return messages;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private resolveSessionPath(sessionKey: string): string {
    if (!sessionKey) {
      throw new Error("Invalid session key.");
    }
    if (sessionKey.includes("/") || sessionKey.includes("\\") || sessionKey.includes("\0")) {
      throw new Error("Invalid session key.");
    }
    const baseDir = path.resolve(this.baseDir);
    const filePath = path.resolve(baseDir, `${sessionKey}.jsonl`);
    const relative = path.relative(baseDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Invalid session key.");
    }
    return filePath;
  }
}

function normalizeToolCalls(message: LlmMessage): LlmMessage {
  if (!message.tool_calls) return message;
  const tool_calls = message.tool_calls.map((call) => ({
    ...call,
    type: call.type ?? "function",
  }));
  return { ...message, tool_calls };
}

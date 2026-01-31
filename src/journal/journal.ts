import fs from "node:fs/promises";
import path from "node:path";
import { appendJsonl } from "../util/jsonl.js";
import { redact } from "../util/redaction.js";
import { isErrnoException, isRecord } from "../util/types.js";

export class SessionJournal {
  constructor(
    private readonly sessionId: string,
    private readonly baseDir = "sessions",
  ) {}

  async append(entry: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.baseDir, `${this.sessionId}.jsonl`);
    await appendJsonl(filePath, redact(entry));
  }
}

export class TradeJournal {
  constructor(private readonly baseDir = "trades") {}

  async append(entry: Record<string, unknown>): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.baseDir, `${date}.jsonl`);
    await appendJsonl(filePath, redact(entry));
  }

  async read(date: string): Promise<Record<string, unknown>[]> {
    const filePath = path.join(this.baseDir, `${date}.jsonl`);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const entries: Record<string, unknown>[] = [];
      for (const line of raw.split("\n").map((item) => item.trim())) {
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) {
          entries.push(parsed);
        }
      }
      return entries;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}

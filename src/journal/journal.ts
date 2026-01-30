import fs from "node:fs/promises";
import path from "node:path";
import { appendJsonl } from "../util/jsonl.js";
import { redact } from "../util/redaction.js";

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
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}

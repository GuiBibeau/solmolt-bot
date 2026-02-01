import fs from "node:fs/promises";
import path from "node:path";
import { isErrnoException, isRecord } from "../util/types.js";
import type { RunRecord } from "./types.js";

export class RunStore {
  constructor(private readonly baseDir = "runs") {}

  async write(record: RunRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const filePath = path.join(this.baseDir, `${record.runId}.json`);
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const existing = (await this.get(runId)) ?? ({ runId } as RunRecord);
    const merged = { ...existing, ...patch };
    await this.write(merged as RunRecord);
    return merged as RunRecord;
  }

  async get(runId: string): Promise<RunRecord | null> {
    const filePath = path.join(this.baseDir, `${runId}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? (parsed as RunRecord) : null;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }
}

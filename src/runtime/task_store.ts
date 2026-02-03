import fs from "node:fs/promises";
import path from "node:path";
import { isErrnoException, isRecord } from "../util/types.js";

export type TaskStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "canceled";

export type TaskRecord = {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  notes: string[];
  metadata?: Record<string, unknown>;
};

export class TaskStore {
  constructor(private readonly baseDir = "tasks") {}

  async list(sessionKey: string): Promise<TaskRecord[]> {
    const data = await this.readAll(sessionKey);
    return data.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(
    sessionKey: string,
    input: {
      title: string;
      status: TaskStatus;
      metadata?: Record<string, unknown>;
    },
  ): Promise<TaskRecord> {
    const tasks = await this.readAll(sessionKey);
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: this.randomId(),
      title: input.title,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      notes: [],
      metadata: input.metadata,
    };
    tasks.push(task);
    await this.writeAll(sessionKey, tasks);
    return task;
  }

  async update(
    sessionKey: string,
    taskId: string,
    patch: Partial<Pick<TaskRecord, "title" | "status" | "metadata">>,
  ): Promise<TaskRecord> {
    const tasks = await this.readAll(sessionKey);
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("task-not-found");
    }
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.metadata !== undefined) task.metadata = patch.metadata;
    task.updatedAt = new Date().toISOString();
    await this.writeAll(sessionKey, tasks);
    return task;
  }

  async addNote(
    sessionKey: string,
    taskId: string,
    note: string,
  ): Promise<TaskRecord> {
    const tasks = await this.readAll(sessionKey);
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("task-not-found");
    }
    task.notes.push(`${new Date().toISOString()} ${note}`);
    task.updatedAt = new Date().toISOString();
    await this.writeAll(sessionKey, tasks);
    return task;
  }

  private async readAll(sessionKey: string): Promise<TaskRecord[]> {
    const filePath = this.resolvePath(sessionKey);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is TaskRecord =>
          isRecord(item) &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.status === "string",
      );
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  private async writeAll(
    sessionKey: string,
    tasks: TaskRecord[],
  ): Promise<void> {
    const filePath = this.resolvePath(sessionKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(tasks, null, 2), "utf8");
  }

  private resolvePath(sessionKey: string): string {
    if (!sessionKey) {
      throw new Error("invalid-session-key");
    }
    if (
      sessionKey.includes("/") ||
      sessionKey.includes("\\") ||
      sessionKey.includes("\0")
    ) {
      throw new Error("invalid-session-key");
    }
    const baseDir = path.resolve(this.baseDir);
    const filePath = path.resolve(baseDir, `${sessionKey}.json`);
    const relative = path.relative(baseDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("invalid-session-key");
    }
    return filePath;
  }

  private randomId(): string {
    return `task_${Math.random().toString(36).slice(2, 10)}`;
  }
}

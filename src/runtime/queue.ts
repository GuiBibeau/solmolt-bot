import { warn } from "../util/logger.js";

export type QueueTask = {
  id: string;
  runId: string;
  sessionKey: string;
  lane: string;
  execute: () => Promise<void>;
};

export class LaneQueue {
  private readonly laneLimits = new Map<string, number>();
  private readonly laneActive = new Map<string, number>();
  private readonly activeSessions = new Set<string>();
  private readonly queue: QueueTask[] = [];

  constructor(lanes: Record<string, number>) {
    for (const [lane, limit] of Object.entries(lanes)) {
      this.laneLimits.set(lane, Math.max(1, limit));
    }
  }

  enqueue(task: QueueTask): void {
    this.queue.push(task);
    this.schedule();
  }

  private schedule(): void {
    if (this.queue.length === 0) return;
    for (let i = 0; i < this.queue.length; i += 1) {
      const task = this.queue[i];
      if (!this.canRun(task)) continue;
      this.queue.splice(i, 1);
      i -= 1;
      this.start(task);
    }
  }

  private canRun(task: QueueTask): boolean {
    if (this.activeSessions.has(task.sessionKey)) return false;
    const limit = this.laneLimits.get(task.lane) ?? 1;
    const active = this.laneActive.get(task.lane) ?? 0;
    return active < limit;
  }

  private start(task: QueueTask): void {
    const active = this.laneActive.get(task.lane) ?? 0;
    this.laneActive.set(task.lane, active + 1);
    this.activeSessions.add(task.sessionKey);
    void task
      .execute()
      .catch((err) => warn("queue.task.failed", { err: String(err) }))
      .finally(() => {
        const current = this.laneActive.get(task.lane) ?? 1;
        this.laneActive.set(task.lane, Math.max(0, current - 1));
        this.activeSessions.delete(task.sessionKey);
        this.schedule();
      });
  }
}

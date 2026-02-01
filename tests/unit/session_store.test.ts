import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/runtime/session_store.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-session-store-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("session store writes and reads valid session key", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(dir);
    await store.append("session-1", {
      type: "message",
      message: { role: "user", content: "hi" },
      ts: new Date().toISOString(),
    });
    const entries = await store.read("session-1");
    expect(entries.length).toBe(1);
  });
});

test("session store rejects traversal session key", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(dir);
    await expect(
      store.append("../evil", { type: "message", ts: "now" }),
    ).rejects.toThrow();
    await expect(
      store.append("..\\evil", { type: "message", ts: "now" }),
    ).rejects.toThrow();
    await expect(
      store.append("/etc/passwd", { type: "message", ts: "now" }),
    ).rejects.toThrow();
  });
});

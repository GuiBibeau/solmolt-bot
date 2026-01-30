import { execSync } from "node:child_process";
import { info, warn } from "../util/logger.js";

export function runUpdate(): void {
  try {
    ensureGitRepo();
    ensureCleanRepo();
    exec("git pull --ff-only");
    exec("bun install");
    info("update.ok", {});
    console.log("Update complete. Restart the gateway to apply changes.");
  } catch (err) {
    warn("update.failed", { err: String(err) });
    throw err;
  }
}

function exec(cmd: string): void {
  execSync(cmd, { stdio: "inherit" });
}

function ensureGitRepo(): void {
  execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
}

function ensureCleanRepo(): void {
  const status = execSync("git status --porcelain", {
    encoding: "utf8",
  }).trim();
  if (status.length > 0) {
    throw new Error(
      "Repository has uncommitted changes. Commit or stash before updating.",
    );
  }
}

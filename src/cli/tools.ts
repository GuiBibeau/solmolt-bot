import fs from "node:fs/promises";
import path from "node:path";
import type { RalphConfig } from "../config/config.js";
import { info } from "../util/logger.js";
import { isRecord } from "../util/types.js";

export type ToolInstallOptions = {
  registryUrl?: string;
  target?: "openclaw" | "skills";
  force?: boolean;
};

type RegistryEntry = {
  name: string;
  url: string;
  filename?: string;
  target?: "openclaw" | "skills";
};

export async function installToolFromRegistry(
  config: RalphConfig,
  name: string,
  options: ToolInstallOptions = {},
): Promise<string> {
  const registryUrl = options.registryUrl || config.openclaw.registryUrl;
  if (!registryUrl) {
    throw new Error("registry url missing; set openclaw.registryUrl in config");
  }

  const entry = await fetchRegistryEntry(registryUrl, name);
  if (!entry) {
    throw new Error(`tool not found in registry: ${name}`);
  }

  const target = options.target ?? entry.target ?? "openclaw";
  const destDir = resolveInstallDir(config, target);
  await fs.mkdir(destDir, { recursive: true });

  const destPath = resolveInstallPath(destDir, entry);

  if (!options.force) {
    let exists = true;
    try {
      await fs.access(destPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
      exists = false;
    }
    if (exists) {
      throw new Error(`tool already installed: ${destPath}`);
    }
  }

  const response = await fetch(entry.url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`registry download failed: ${response.status} ${body}`);
  }
  const content = await response.text();
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, content, "utf8");

  info("tool.installed", { name: entry.name, target, path: destPath });
  return destPath;
}

async function fetchRegistryEntry(
  registryUrl: string,
  name: string,
): Promise<RegistryEntry | null> {
  const response = await fetch(registryUrl);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`registry fetch failed: ${response.status} ${body}`);
  }
  const payload = (await response.json()) as unknown;
  const entry = resolveRegistryEntry(payload, name);
  if (!entry) return null;
  if (!entry.url) {
    throw new Error(`registry entry missing url for ${name}`);
  }
  return entry;
}

function resolveRegistryEntry(
  payload: unknown,
  name: string,
): RegistryEntry | null {
  if (Array.isArray(payload)) {
    return resolveFromArray(payload, name);
  }
  if (isRecord(payload)) {
    const tools = payload.tools;
    if (Array.isArray(tools)) {
      return resolveFromArray(tools, name);
    }
    if (isRecord(tools)) {
      const raw = tools[name];
      return normalizeEntry(name, raw);
    }
    if (name in payload) {
      return normalizeEntry(name, payload[name]);
    }
  }
  return null;
}

function resolveFromArray(
  items: unknown[],
  name: string,
): RegistryEntry | null {
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (String(item.name ?? "") !== name) continue;
    return normalizeEntry(name, item);
  }
  return null;
}

function normalizeEntry(name: string, raw: unknown): RegistryEntry | null {
  if (typeof raw === "string") {
    return { name, url: raw };
  }
  if (!isRecord(raw)) return null;
  const url = raw.url;
  if (typeof url !== "string") return null;
  const filename = typeof raw.filename === "string" ? raw.filename : undefined;
  const target =
    raw.target === "skills"
      ? "skills"
      : raw.target === "openclaw"
        ? "openclaw"
        : undefined;
  return {
    name: typeof raw.name === "string" ? raw.name : name,
    url,
    filename,
    target,
  };
}

function resolveInstallDir(
  config: RalphConfig,
  target: "openclaw" | "skills",
): string {
  if (target === "skills") {
    return config.tools.skillsDir;
  }
  const pluginsDir = config.openclaw.pluginsDir;
  if (!pluginsDir) {
    throw new Error("openclaw.pluginsDir not configured");
  }
  return pluginsDir;
}

function resolveFilename(entry: RegistryEntry): string {
  if (entry.filename) return entry.filename;
  try {
    const url = new URL(entry.url);
    const base = path.basename(url.pathname);
    if (base) return base;
  } catch {
    // ignore
  }
  const safe = entry.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.js`;
}

function resolveInstallPath(destDir: string, entry: RegistryEntry): string {
  const rawFileName = resolveFilename(entry);
  const fileName = normalizeRegistryPath(rawFileName);
  if (!isSafeRelativePath(fileName)) {
    throw new Error(
      `registry entry has unsafe filename (must be a relative path without "." or ".." segments): ${rawFileName}`,
    );
  }
  const destRoot = path.resolve(destDir);
  const destPath = path.resolve(destRoot, fileName);
  if (!isPathWithinDir(destRoot, destPath)) {
    throw new Error("resolved path escapes install dir");
  }
  return destPath;
}

function normalizeRegistryPath(fileName: string): string {
  return fileName.replace(/\\/g, "/");
}

function isSafeRelativePath(fileName: string): boolean {
  if (!fileName) return false;
  if (path.posix.isAbsolute(fileName) || path.win32.isAbsolute(fileName)) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(fileName)) {
    return false;
  }
  if (fileName.includes("\0")) return false;
  const parts = fileName.split("/");
  if (!parts.length) return false;
  for (const part of parts) {
    if (!part || part === "." || part === "..") return false;
  }
  return true;
}

function isPathWithinDir(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

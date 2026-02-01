import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { installToolFromRegistry } from "../../src/cli/tools.js";
import type { RalphConfig } from "../../src/config/config.js";

const tmpRoot = path.resolve(".tmp/test-tools-install");
const registryUrl = "https://registry.example.com/tools.json";
const downloadUrl = "https://registry.example.com/tool.js";

const baseConfig: RalphConfig = {
  rpc: { endpoint: "http://localhost:8899" },
  wallet: {},
  jupiter: { apiKey: "test", baseUrl: "https://api.jup.ag" },
  solana: { sdkMode: "web3" },
  llm: {
    provider: "openai_chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKey: "test",
    model: "glm-4.7",
  },
  autopilot: { enabled: false, intervalMs: 15000 },
  gateway: { bind: "127.0.0.1", port: 8787, authToken: "test" },
  tools: { skillsDir: "skills" },
  openclaw: {},
  notify: {},
  runtime: {
    sessionsDir: "sessions",
    runsDir: "runs",
    lanes: { main: 1, subagent: 4, autopilot: 1 },
  },
  agents: {
    defaultAgentId: "main",
    agents: {},
  },
  policy: {
    killSwitch: false,
    allowedMints: [],
    maxTradeAmountLamports: "0",
    maxSlippageBps: 50,
    maxPriceImpactPct: 1,
    cooldownSeconds: 30,
  },
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function mockFetch(
  responses: Record<
    string,
    { status?: number; body: unknown; headers?: HeadersInit }
  >,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = responses[url];
    if (!match) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const body =
      typeof match.body === "string" ? match.body : JSON.stringify(match.body);
    return new Response(body, {
      status: match.status ?? 200,
      headers: match.headers,
    });
  }) as typeof fetch;
}

function configWithRegistry(): RalphConfig {
  return {
    ...baseConfig,
    tools: { skillsDir: path.join(tmpRoot, "skills") },
    openclaw: {
      ...baseConfig.openclaw,
      registryUrl,
      pluginsDir: path.join(tmpRoot, "plugins"),
    },
  };
}

test("rejects registry entries with path traversal", async () => {
  mockFetch({
    [registryUrl]: {
      body: {
        tools: {
          bad: { url: downloadUrl, filename: "../evil.js" },
        },
      },
    },
    [downloadUrl]: { body: "console.log('x')" },
  });

  await expect(
    installToolFromRegistry(configWithRegistry(), "bad"),
  ).rejects.toThrow(/unsafe filename/i);
});

test("rejects registry entries with absolute paths", async () => {
  mockFetch({
    [registryUrl]: {
      body: {
        tools: {
          bad: { url: downloadUrl, filename: "/etc/passwd" },
        },
      },
    },
    [downloadUrl]: { body: "console.log('x')" },
  });

  await expect(
    installToolFromRegistry(configWithRegistry(), "bad"),
  ).rejects.toThrow(/unsafe filename/i);
});

test("installs tool with a safe filename", async () => {
  mockFetch({
    [registryUrl]: {
      body: {
        tools: {
          ok: { url: downloadUrl, filename: "tool.js" },
        },
      },
    },
    [downloadUrl]: { body: "console.log('ok')" },
  });

  const dest = await installToolFromRegistry(configWithRegistry(), "ok");
  const content = await fs.readFile(dest, "utf8");

  expect(dest).toBe(path.resolve(path.join(tmpRoot, "plugins"), "tool.js"));
  expect(content).toBe("console.log('ok')");
});

test("installs tool into a nested subdirectory", async () => {
  mockFetch({
    [registryUrl]: {
      body: {
        tools: {
          ok: { url: downloadUrl, filename: "nested/tool.js" },
        },
      },
    },
    [downloadUrl]: { body: "console.log('nested')" },
  });

  const dest = await installToolFromRegistry(configWithRegistry(), "ok");
  const content = await fs.readFile(dest, "utf8");

  expect(dest).toBe(
    path.resolve(path.join(tmpRoot, "plugins"), "nested", "tool.js"),
  );
  expect(content).toBe("console.log('nested')");
});

test("refuses to overwrite existing tool without --force", async () => {
  mockFetch({
    [registryUrl]: {
      body: {
        tools: {
          ok: { url: downloadUrl, filename: "tool.js" },
        },
      },
    },
    [downloadUrl]: { body: "console.log('new')" },
  });

  const config = configWithRegistry();
  const destDir = path.join(tmpRoot, "plugins");
  await fs.mkdir(destDir, { recursive: true });
  const existingPath = path.join(destDir, "tool.js");
  await fs.writeFile(existingPath, "console.log('old')", "utf8");

  await expect(installToolFromRegistry(config, "ok")).rejects.toThrow(
    /already installed/i,
  );

  const content = await fs.readFile(existingPath, "utf8");
  expect(content).toBe("console.log('old')");
});

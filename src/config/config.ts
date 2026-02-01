import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isRecord } from "../util/types.js";

const PolicySchema = z.object({
  killSwitch: z.boolean().default(false),
  allowedMints: z.array(z.string()).default([]),
  maxTradeAmountLamports: z.string().default("0"),
  maxSlippageBps: z.number().int().default(50),
  maxPriceImpactPct: z.number().default(1),
  cooldownSeconds: z.number().int().default(30),
  dailySpendCapLamports: z.string().optional(),
});

const ToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  allowAll: z.boolean().optional(),
});

const AgentDefinitionSchema = z.object({
  instructions: z.string().optional(),
  model: z.string().optional(),
  toolPolicy: ToolPolicySchema.optional(),
  lane: z.string().optional(),
  canSpawnSubagents: z.boolean().default(true),
});

const AgentsSchema = z
  .object({
    defaultAgentId: z.string().default("main"),
    agents: z.record(AgentDefinitionSchema).default({}),
  })
  .default({});

const RuntimeSchema = z
  .object({
    sessionsDir: z.string().default("sessions"),
    runsDir: z.string().default("runs"),
    lanes: z
      .record(z.number().int().positive())
      .default({ main: 1, subagent: 4, autopilot: 1 }),
  })
  .default({});

const ConfigSchema = z.object({
  rpc: z.object({
    endpoint: z.string().min(1),
  }),
  wallet: z.object({
    privateKey: z.string().optional(),
    keyfilePath: z.string().optional(),
  }),
  jupiter: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().default("https://api.jup.ag"),
  }),
  solana: z.object({
    sdkMode: z.enum(["web3"]).default("web3"),
  }),
  llm: z.object({
    provider: z
      .enum(["openai_chat", "openai_responses", "anthropic_messages"])
      .default("openai_chat"),
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1),
    model: z.string().min(1),
    toolMode: z.enum(["auto", "tools", "functions", "none"]).default("auto"),
  }),
  autopilot: z.object({
    enabled: z.boolean().default(false),
    intervalMs: z.number().int().default(15_000),
    plan: z
      .object({
        inputMint: z.string().min(1),
        outputMint: z.string().min(1),
        amount: z.string().min(1),
        slippageBps: z.number().int().default(50),
      })
      .optional(),
  }),
  gateway: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().default(8787),
    authToken: z.string().min(1),
  }),
  tools: z
    .object({
      skillsDir: z.string().default("skills"),
    })
    .default({}),
  openclaw: z
    .object({
      pluginsDir: z.string().optional(),
      registryUrl: z.string().optional(),
      gateway: z
        .object({
          baseUrl: z.string().min(1),
          token: z.string().min(1),
          sessionKey: z.string().optional(),
          messageChannel: z.string().optional(),
          accountId: z.string().optional(),
        })
        .optional(),
    })
    .default({}),
  notify: z
    .object({
      webhookUrl: z.string().optional(),
    })
    .default({}),
  runtime: RuntimeSchema,
  agents: AgentsSchema,
  policy: PolicySchema,
});

export type RalphConfig = z.infer<typeof ConfigSchema>;

function parseConfigFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};
  if (filePath.endsWith(".json")) {
    return JSON.parse(raw);
  }
  return YAML.parse(raw);
}

function envBool(value?: string): boolean | undefined {
  if (!value) return undefined;
  return value.toLowerCase() === "true" || value === "1";
}

function envNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const baseValue = isRecord(base[key]) ? base[key] : {};
      const overrideValue = isRecord(value) ? value : {};
      output[key] = deepMerge(baseValue, overrideValue);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function loadConfig(configPath?: string): RalphConfig {
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.env.RALPH_CONFIG || "ralph.config.yaml");

  const parsedConfig = parseConfigFile(resolvedPath);
  const fileConfig = isRecord(parsedConfig) ? parsedConfig : {};

  const envOverrides: Record<string, unknown> = {
    rpc: {
      endpoint: process.env.RPC_ENDPOINT,
    },
    wallet: {
      privateKey: process.env.WALLET_PRIVATE_KEY,
      keyfilePath: process.env.WALLET_KEYFILE,
    },
    jupiter: {
      apiKey: process.env.JUPITER_API_KEY,
      baseUrl: process.env.JUPITER_BASE_URL,
    },
    solana: {
      sdkMode: process.env.SOLANA_SDK_MODE,
    },
    llm: {
      provider: process.env.LLM_PROVIDER,
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
      toolMode: process.env.LLM_TOOL_MODE,
    },
    autopilot: {
      enabled: envBool(process.env.AUTOPILOT_ENABLED),
      intervalMs: envNumber(process.env.AUTOPILOT_INTERVAL_MS),
    },
    gateway: {
      bind: process.env.GATEWAY_BIND,
      port: envNumber(process.env.GATEWAY_PORT),
      authToken: process.env.GATEWAY_AUTH_TOKEN,
    },
    notify: {
      webhookUrl: process.env.NOTIFY_WEBHOOK_URL,
    },
    tools: {
      skillsDir: process.env.SKILLS_DIR,
    },
  };

  const merged = deepMerge(fileConfig, envOverrides);
  return ConfigSchema.parse(merged);
}

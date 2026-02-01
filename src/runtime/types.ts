import type { LlmMessage } from "../llm/types.js";

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
  allowAll?: boolean;
};

export type AgentDefinition = {
  id: string;
  instructions?: string;
  model?: string;
  toolPolicy?: ToolPolicy;
  lane?: string;
  canSpawnSubagents?: boolean;
};

export type AgentMeta = {
  agentId: string;
  sessionKey: string;
  runId: string;
  parentRunId?: string;
  canSpawnSubagents: boolean;
};

export type RunStatus = "accepted" | "running" | "completed" | "failed";

export type RunRecord = {
  runId: string;
  agentId: string;
  sessionKey: string;
  status: RunStatus;
  acceptedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  lane?: string;
  parentRunId?: string;
  metadata?: Record<string, unknown>;
  output?: {
    text?: string | null;
    actionsTaken?: string[];
  };
};

export type RunAccepted = {
  runId: string;
  acceptedAt: string;
};

export type SessionSummary = {
  sessionKey: string;
  updatedAt?: string;
};

export type SessionHistoryEntry = Record<string, unknown>;

export type AgentRunRequest = {
  agentId: string;
  sessionKey: string;
  input: string;
  reason?: "timer" | "operator" | "recovery";
  parentRunId?: string;
  parentSessionKey?: string;
  lane?: string;
  toolPolicy?: ToolPolicy;
  metadata?: Record<string, unknown>;
};

export type AgentRuntime = {
  submitRun: (request: AgentRunRequest) => RunAccepted;
  submitMessage: (input: {
    sessionKey: string;
    content: string;
    agentId?: string;
    triggerRun?: boolean;
  }) => Promise<{ ok: true } | RunAccepted>;
  submitAutopilotTick: (
    reason: "timer" | "operator" | "recovery",
  ) => RunAccepted;
  spawnSubagent: (input: {
    task: string;
    agentId?: string;
    label?: string;
    parentRunId?: string;
    parentSessionKey?: string;
  }) => RunAccepted & { childSessionKey: string };
  wait: (runId: string, timeoutMs?: number) => Promise<RunRecord | null>;
  getRun: (runId: string) => Promise<RunRecord | null>;
  listSessions: () => Promise<SessionSummary[]>;
  getSessionHistory: (
    sessionKey: string,
    limit?: number,
  ) => Promise<SessionHistoryEntry[]>;
  getSessionMessages: (sessionKey: string) => Promise<LlmMessage[]>;
  getDefaultAgentId: () => string;
};

export type AgentTickReason = "timer" | "operator" | "recovery";

export type AgentTickResult = {
  actionsTaken: string[];
  nextTickInMs: number;
  skipped?: string;
  error?: string;
};

export type AgentHandle = {
  tick: (reason: AgentTickReason) => Promise<AgentTickResult>;
};

export type AgentControl = {
  message: (input: {
    content: string;
    triggerTick?: boolean;
  }) => Promise<AgentTickResult | { ok: true }>;
};

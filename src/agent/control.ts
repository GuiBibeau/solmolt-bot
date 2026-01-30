import type { AgentOrchestrator } from "./orchestrator.js";
import type { AgentTickReason, AgentTickResult } from "./types.js";

export type AgentMessageInput = {
  content: string;
  triggerTick?: boolean;
};

export class AgentController {
  constructor(private readonly agent: AgentOrchestrator) {}

  async message(
    input: AgentMessageInput,
  ): Promise<AgentTickResult | { ok: true }> {
    this.agent.injectMessage(input.content);
    if (input.triggerTick) {
      return this.agent.tick("operator" satisfies AgentTickReason);
    }
    return { ok: true };
  }
}

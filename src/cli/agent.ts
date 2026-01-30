import type { RalphConfig } from "../config/config.js";
import { runCliCommand } from "./client.js";

export async function sendAgentMessage(
  config: RalphConfig,
  content: string,
  triggerTick?: boolean,
): Promise<void> {
  await runCliCommand(config, {
    method: "tool.invoke",
    params: {
      name: "agent.message",
      input: { content, triggerTick },
    },
  });
}

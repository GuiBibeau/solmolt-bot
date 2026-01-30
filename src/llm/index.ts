import type { RalphConfig } from "../config/config.js";
import { OpenAiChatClient } from "./openai_chat.js";
import type { LlmClient } from "./types.js";

export function createLlmClient(config: RalphConfig["llm"]): LlmClient {
  if (config.provider === "openai_chat") {
    return new OpenAiChatClient(config);
  }
  throw new Error(`Unsupported LLM provider: ${config.provider}`);
}

export type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  ToolSchema,
} from "./types.js";

export type ToolSchema = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

export type LlmResponse = {
  message: LlmMessage;
  text?: string | null;
  toolCalls?: LlmToolCall[];
};

export type LlmClient = {
  generate: (
    messages: LlmMessage[],
    tools: ToolSchema[],
  ) => Promise<LlmResponse>;
};

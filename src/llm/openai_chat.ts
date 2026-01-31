import type { RalphConfig } from "../config/config.js";
import { OpenAiChatResponseSchema } from "./schema.js";
import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  ToolSchema,
} from "./types.js";

export class OpenAiChatClient implements LlmClient {
  constructor(private readonly config: RalphConfig["llm"]) {}

  async generate(
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const payload = {
      model: this.config.model,
      messages,
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: "auto",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${body}`);
    }

    const data = OpenAiChatResponseSchema.parse(await response.json());
    const choice = data.choices[0]?.message;
    if (!choice) {
      throw new Error("LLM response missing message");
    }

    const toolCalls: LlmToolCall[] | undefined = choice.tool_calls?.map(
      (call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }),
    );

    const role =
      choice.role === "system" ||
      choice.role === "user" ||
      choice.role === "assistant" ||
      choice.role === "tool"
        ? choice.role
        : "assistant";

    return {
      message: {
        role,
        content: choice.content ?? null,
        tool_calls: choice.tool_calls,
      },
      text: choice.content ?? null,
      toolCalls,
    };
  }
}

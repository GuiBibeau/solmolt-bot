import { z } from "zod";

export const OpenAiToolCallSchema = z.object({
  id: z.string(),
  type: z.string().default("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string().default("{}"),
  }),
});

export const OpenAiMessageSchema = z
  .object({
    role: z.string().optional(),
    content: z.union([z.string(), z.null()]).optional(),
    tool_calls: z.array(OpenAiToolCallSchema).optional(),
    function_call: z
      .object({
        name: z.string(),
        arguments: z.string().default("{}"),
      })
      .optional(),
  })
  .passthrough();

export const OpenAiChatResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: OpenAiMessageSchema,
    }),
  ),
});

export type OpenAiMessage = z.infer<typeof OpenAiMessageSchema>;
export type OpenAiToolCall = z.infer<typeof OpenAiToolCallSchema>;

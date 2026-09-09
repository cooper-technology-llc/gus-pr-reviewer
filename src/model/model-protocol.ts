import { z } from "zod";
import { GusError } from "../errors.js";
import type {
  ModelCompletion,
  ModelRequest,
  ModelToolCall,
} from "../review/review-ports.js";
import type { GusConfig } from "../config/config-schema.js";

const providerToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(100),
    arguments: z.string(),
  }),
});
const providerResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().min(1),
        message: z.object({
          role: z.literal("assistant").optional(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(providerToolCallSchema).optional(),
          refusal: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1)
    .max(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
});

export function buildProviderRequest(
  request: ModelRequest,
  config: GusConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined
        ? {}
        : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
    })),
    max_tokens: request.maxOutputTokens,
    stream: false,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: tool,
    }));
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (request.jsonMode) body.response_format = { type: "json_object" };
  if (request.reasoningEffort) {
    if (config.provider.reasoningFormat === "openrouter") {
      body.reasoning =
        request.reasoningEffort === "none"
          ? { enabled: false }
          : { effort: request.reasoningEffort, exclude: true };
    }
    if (config.provider.reasoningFormat === "openai")
      body.reasoning_effort = request.reasoningEffort;
  }
  return body;
}

export function parseProviderCompletion(
  raw: unknown,
  model: string,
  attempts: number,
): ModelCompletion {
  const parsed = providerResponseSchema.safeParse(raw);
  if (!parsed.success)
    throw new GusError(
      "PROVIDER_PROTOCOL",
      "The provider response did not match the completion contract.",
    );
  const choice = parsed.data.choices[0];
  if (!choice || choice.message.refusal)
    throw new GusError(
      "PROVIDER_PROTOCOL",
      "The provider did not return a usable review completion.",
    );
  const toolCalls = (choice.message.tool_calls ?? []).map(
    parseProviderToolCall,
  );
  if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
    throw new GusError(
      "PROVIDER_PROTOCOL",
      "The provider returned duplicate tool call identifiers.",
    );
  }
  const content = choice.message.content ?? "";
  if (!content.trim() && toolCalls.length === 0)
    throw new GusError(
      "PROVIDER_PROTOCOL",
      "The provider returned neither content nor tool calls.",
    );
  const usage = parsed.data.usage;
  return {
    content,
    toolCalls,
    finishReason: choice.finish_reason,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    costUsd: usage?.cost ?? null,
    model: parsed.data.model ?? model,
    requestAttempts: attempts,
    usageAvailable:
      usage?.prompt_tokens !== undefined &&
      usage.completion_tokens !== undefined,
  };
}

function parseProviderToolCall(
  call: z.infer<typeof providerToolCallSchema>,
): ModelToolCall {
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.function.arguments);
  } catch {
    throw new GusError(
      "PROVIDER_PROTOCOL",
      "The provider returned invalid JSON tool arguments.",
    );
  }
  const argumentsObject = z
    .record(z.string(), z.unknown())
    .safeParse(argumentsValue);
  if (!argumentsObject.success)
    throw new GusError(
      "PROVIDER_PROTOCOL",
      "Tool arguments must be a JSON object.",
    );
  return {
    id: call.id,
    name: call.function.name,
    arguments: argumentsObject.data,
  };
}

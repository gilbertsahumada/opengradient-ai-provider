import type { LanguageModelV3ToolCall } from '@ai-sdk/provider';

/** OpenAI-wire tool call as returned by the OpenGradient SDK. */
interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/**
 * Map OpenAI-wire `tool_calls` (from `chatOutput`/`delta`) to V3 tool-call
 * content parts. `input` stays a stringified JSON object, as V3 expects.
 */
export function mapToolCalls(
  toolCalls: readonly OpenAIToolCall[],
): LanguageModelV3ToolCall[] {
  return toolCalls.map((toolCall) => ({
    type: 'tool-call',
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    input:
      typeof toolCall.function.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function.arguments),
  }));
}

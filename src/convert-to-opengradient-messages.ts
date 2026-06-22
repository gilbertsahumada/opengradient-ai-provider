import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  SharedV3Warning,
} from '@ai-sdk/provider';
import type { ChatMessage } from 'opengradient-sdk';

/** Flatten a V3 tool-result output to the plain string the SDK expects. */
function stringifyToolOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
    case 'content':
      return JSON.stringify(output.value);
    case 'execution-denied':
      return output.reason ?? 'tool execution denied';
  }
}

/**
 * Convert a V3 prompt (array of role-tagged structured messages) into the
 * OpenAI-wire `ChatMessage[]` the OpenGradient SDK expects.
 *
 * OpenGradient message content is `string | null`, so anything that can't be
 * represented as text (file/image parts, reasoning) is dropped with a warning.
 */
export function convertToOpenGradientMessages(prompt: LanguageModelV3Prompt): {
  messages: ChatMessage[];
  warnings: SharedV3Warning[];
} {
  const messages: ChatMessage[] = [];
  const warnings: SharedV3Warning[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: message.content });
        break;

      case 'user': {
        const text: string[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            text.push(part.text);
          } else {
            warnings.push({
              type: 'unsupported',
              feature: 'file-input',
              details: `dropped ${part.mediaType} file part (text-only model)`,
            });
          }
        }
        messages.push({ role: 'user', content: text.join('') });
        break;
      }

      case 'assistant': {
        const text: string[] = [];
        const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              text.push(part.text);
              break;
            case 'tool-call':
              toolCalls.push({
                id: part.toolCallId,
                type: 'function',
                function: {
                  name: part.toolName,
                  arguments:
                    typeof part.input === 'string'
                      ? part.input
                      : JSON.stringify(part.input),
                },
              });
              break;
            case 'reasoning':
              warnings.push({
                type: 'unsupported',
                feature: 'reasoning',
                details: 'assistant reasoning parts are dropped',
              });
              break;
            case 'file':
              warnings.push({
                type: 'unsupported',
                feature: 'file-input',
                details: `dropped ${part.mediaType} file part (text-only model)`,
              });
              break;
          }
        }
        const assistant: ChatMessage = {
          role: 'assistant',
          content: text.join('') || null,
        };
        if (toolCalls.length > 0) {
          assistant.tool_calls = toolCalls;
        }
        messages.push(assistant);
        break;
      }

      case 'tool': {
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            messages.push({
              role: 'tool',
              tool_call_id: part.toolCallId,
              content: stringifyToolOutput(part.output),
            });
          }
        }
        break;
      }
    }
  }

  return { messages, warnings };
}

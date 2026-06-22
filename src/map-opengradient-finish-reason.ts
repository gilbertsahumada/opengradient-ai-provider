import type { LanguageModelV3FinishReason } from '@ai-sdk/provider';

/**
 * Map OpenGradient's string finish reason to the V3 structured finish reason.
 * The original string is preserved in `raw`.
 */
export function mapOpenGradientFinishReason(
  raw: string | undefined,
): LanguageModelV3FinishReason {
  let unified: LanguageModelV3FinishReason['unified'];
  switch (raw) {
    case 'stop':
      unified = 'stop';
      break;
    case 'length':
      unified = 'length';
      break;
    case 'tool_calls':
      unified = 'tool-calls';
      break;
    case 'content_filter':
      unified = 'content-filter';
      break;
    case 'error':
      unified = 'error';
      break;
    default:
      unified = 'other';
  }
  return { unified, raw };
}

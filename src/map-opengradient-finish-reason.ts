import type { LanguageModelV3FinishReason } from '@ai-sdk/provider';

const FINISH_REASON_MAP: Record<
  string,
  LanguageModelV3FinishReason['unified']
> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool-calls',
  content_filter: 'content-filter',
  error: 'error',
};

/**
 * Map OpenGradient's string finish reason to the V3 structured finish reason.
 * The original string is preserved in `raw`.
 */
export function mapOpenGradientFinishReason(
  raw: string | undefined,
): LanguageModelV3FinishReason {
  const unified = raw ? (FINISH_REASON_MAP[raw] ?? 'other') : 'other';
  return { unified, raw };
}

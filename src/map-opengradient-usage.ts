import type { LanguageModelV3Usage } from '@ai-sdk/provider';
import type { TokenUsage } from 'opengradient-sdk';

/**
 * Map OpenGradient's flat token usage to the V3 nested usage shape. OpenGradient
 * only reports totals, so the cache/text/reasoning sub-fields are `undefined`.
 */
export function mapOpenGradientUsage(
  usage: TokenUsage | undefined,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage?.prompt_tokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.completion_tokens,
      text: undefined,
      reasoning: undefined,
    },
    raw: usage
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        }
      : undefined,
  };
}

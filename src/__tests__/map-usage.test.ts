import { describe, it, expect } from 'vitest';
import { mapOpenGradientUsage } from '../map-opengradient-usage';

describe('mapOpenGradientUsage', () => {
  it('maps totals to the nested V3 shape and keeps raw', () => {
    const usage = mapOpenGradientUsage({
      prompt_tokens: 15,
      completion_tokens: 10,
      total_tokens: 25,
    });
    expect(usage.inputTokens.total).toBe(15);
    expect(usage.outputTokens.total).toBe(10);
    expect(usage.inputTokens.cacheRead).toBeUndefined();
    expect(usage.outputTokens.reasoning).toBeUndefined();
    expect(usage.raw).toEqual({
      prompt_tokens: 15,
      completion_tokens: 10,
      total_tokens: 25,
    });
  });

  it('returns all-undefined totals when usage is missing', () => {
    const usage = mapOpenGradientUsage(undefined);
    expect(usage.inputTokens.total).toBeUndefined();
    expect(usage.outputTokens.total).toBeUndefined();
    expect(usage.raw).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { mapOpenGradientFinishReason } from '../map-opengradient-finish-reason';

describe('mapOpenGradientFinishReason', () => {
  it('maps known reasons to unified values, preserving raw', () => {
    expect(mapOpenGradientFinishReason('stop')).toEqual({
      unified: 'stop',
      raw: 'stop',
    });
    expect(mapOpenGradientFinishReason('length')).toEqual({
      unified: 'length',
      raw: 'length',
    });
    expect(mapOpenGradientFinishReason('tool_calls')).toEqual({
      unified: 'tool-calls',
      raw: 'tool_calls',
    });
    expect(mapOpenGradientFinishReason('content_filter')).toEqual({
      unified: 'content-filter',
      raw: 'content_filter',
    });
    expect(mapOpenGradientFinishReason('error')).toEqual({
      unified: 'error',
      raw: 'error',
    });
  });

  it('falls back to "other" for unknown/undefined, keeping raw', () => {
    expect(mapOpenGradientFinishReason('weird')).toEqual({
      unified: 'other',
      raw: 'weird',
    });
    expect(mapOpenGradientFinishReason(undefined)).toEqual({
      unified: 'other',
      raw: undefined,
    });
  });
});

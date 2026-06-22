import { describe, it, expect } from 'vitest';
import { mapToolCalls } from '../map-opengradient-tool-calls';

describe('mapToolCalls', () => {
  it('passes string arguments through as the V3 input', () => {
    const result = mapToolCalls([
      {
        id: 'call_1',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(result).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: '{"city":"Paris"}',
      },
    ]);
  });

  it('stringifies non-string arguments', () => {
    const result = mapToolCalls([
      {
        id: 'call_2',
        function: {
          name: 'get_weather',
          arguments: { city: 'Paris' } as never,
        },
      },
    ]);
    expect(result[0]!.input).toBe('{"city":"Paris"}');
  });

  it('maps multiple tool calls in order', () => {
    const result = mapToolCalls([
      { id: 'a', function: { name: 'one', arguments: '{}' } },
      { id: 'b', function: { name: 'two', arguments: '{}' } },
    ]);
    expect(result.map((c) => c.toolCallId)).toEqual(['a', 'b']);
    expect(result.map((c) => c.toolName)).toEqual(['one', 'two']);
  });
});

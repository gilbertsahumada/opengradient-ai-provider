import { describe, it, expect } from 'vitest';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { convertToOpenGradientMessages } from '../convert-to-opengradient-messages';

describe('convertToOpenGradientMessages', () => {
  it('maps system and text user/assistant messages', () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ];
    const { messages, warnings } = convertToOpenGradientMessages(prompt);
    expect(messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('drops file parts with an unsupported warning', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look:' },
          {
            type: 'file',
            data: 'aGVsbG8=',
            mediaType: 'image/png',
          },
        ],
      },
    ];
    const { messages, warnings } = convertToOpenGradientMessages(prompt);
    expect(messages).toEqual([{ role: 'user', content: 'look:' }]);
    expect(warnings).toEqual([
      expect.objectContaining({ type: 'unsupported', feature: 'file-input' }),
    ]);
  });

  it('maps assistant tool calls to the OpenAI wire shape', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'Paris' },
          },
        ],
      },
    ];
    const { messages } = convertToOpenGradientMessages(prompt);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ city: 'Paris' }),
          },
        },
      ],
    });
  });

  it('stringifies tool results into tool messages', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            output: { type: 'json', value: { tempC: 21 } },
          },
        ],
      },
    ];
    const { messages } = convertToOpenGradientMessages(prompt);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: JSON.stringify({ tempC: 21 }),
      },
    ]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { StreamChunk } from 'opengradient-sdk';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  OpenGradientChatLanguageModel,
  type OpenGradientClientLike,
} from '../opengradient-chat-language-model';

function streamingClient(
  chunks: StreamChunk[],
  closeSpy = vi.fn().mockResolvedValue(undefined),
): OpenGradientClientLike {
  async function* gen() {
    for (const chunk of chunks) yield chunk;
  }
  return {
    llm: { chat: vi.fn().mockReturnValue(gen()) as never },
    close: closeSpy as never,
  };
}

function model(client: OpenGradientClientLike) {
  return new OpenGradientChatLanguageModel('anthropic/claude-haiku-4-5', {
    settings: { privateKey: '0xabc' },
    createClient: () => client,
  });
}

const baseCall = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

async function drain(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function chunk(partial: Partial<StreamChunk>): StreamChunk {
  return { choices: [], model: 'm', isFinal: false, ...partial } as StreamChunk;
}

describe('OpenGradientChatLanguageModel.doStream', () => {
  it('emits ordered text parts and a finish part with usage + TEE metadata', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const client = streamingClient(
      [
        chunk({ choices: [{ delta: { content: 'Hello' }, index: 0 }] }),
        chunk({ choices: [{ delta: { content: ', world' }, index: 0 }] }),
        chunk({
          choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
          isFinal: true,
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          teeSignature: 'sig123',
          teeEndpoint: 'https://13.59.207.188',
        }),
      ],
      closeSpy,
    );

    const { stream } = await model(client).doStream(baseCall);
    const parts = await drain(stream);

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);

    const text = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta: string }).delta)
      .join('');
    expect(text).toBe('Hello, world');

    const finish = parts.find((p) => p.type === 'finish') as Extract<
      LanguageModelV3StreamPart,
      { type: 'finish' }
    >;
    expect(finish.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect(finish.usage.inputTokens.total).toBe(5);
    expect(finish.usage.outputTokens.total).toBe(3);
    expect(finish.providerMetadata?.opengradient).toEqual({
      teeSignature: 'sig123',
      teeEndpoint: 'https://13.59.207.188',
    });

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('synthesizes tool parts from the degraded single final chunk', async () => {
    const client = streamingClient([
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                },
              ],
            },
            index: 0,
            finish_reason: 'tool_calls',
          },
        ],
        isFinal: true,
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    ]);

    const { stream } = await model(client).doStream(baseCall);
    const parts = await drain(stream);

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish',
    ]);

    const toolCall = parts.find((p) => p.type === 'tool-call') as Extract<
      LanguageModelV3StreamPart,
      { type: 'tool-call' }
    >;
    expect(toolCall).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'get_weather',
      input: '{"city":"Paris"}',
    });

    const finish = parts.find((p) => p.type === 'finish') as Extract<
      LanguageModelV3StreamPart,
      { type: 'finish' }
    >;
    expect(finish.finishReason).toEqual({ unified: 'tool-calls', raw: 'tool_calls' });
  });

  it('fails over to the next endpoint when the first connection fails', async () => {
    const closeA = vi.fn().mockResolvedValue(undefined);
    const badClient: OpenGradientClientLike = {
      llm: {
        chat: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('fetch failed')),
          }),
        }) as never,
      },
      close: closeA as never,
    };
    const goodClient = streamingClient([
      chunk({ choices: [{ delta: { content: 'hi' }, index: 0 }] }),
      chunk({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        isFinal: true,
        teeSignature: 'sig',
      }),
    ]);

    const seen: Array<string | undefined> = [];
    const m = new OpenGradientChatLanguageModel('anthropic/claude-haiku-4-5', {
      settings: { privateKey: '0xabc', llmServerUrl: ['https://a', 'https://b'] },
      createClient: (_settings, endpoint) => {
        seen.push(endpoint);
        return endpoint === 'https://a' ? badClient : goodClient;
      },
    });

    const { stream } = await m.doStream(baseCall);
    const parts = await drain(stream);

    expect(seen).toEqual(['https://a', 'https://b']);
    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it('emits an error part and still closes when the stream throws', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const boom: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('stream boom')),
      }),
    };
    const client: OpenGradientClientLike = {
      llm: { chat: vi.fn().mockReturnValue(boom) as never },
      close: closeSpy as never,
    };

    const { stream } = await model(client).doStream(baseCall);
    const parts = await drain(stream);

    const error = parts.find((p) => p.type === 'error') as Extract<
      LanguageModelV3StreamPart,
      { type: 'error' }
    >;
    expect(error).toBeDefined();
    expect(error.error).toMatchObject({ name: 'AI_APICallError', message: 'stream boom' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { OpenGradientError, type TextGenerationOutput } from 'opengradient-sdk';
import {
  OpenGradientChatLanguageModel,
  type OpenGradientClientLike,
} from '../opengradient-chat-language-model';

function fakeClient(
  output: TextGenerationOutput,
  chatSpy = vi.fn(),
): OpenGradientClientLike {
  return {
    llm: {
      chat: chatSpy.mockResolvedValue(output) as never,
    },
    close: vi.fn().mockResolvedValue(undefined) as never,
  };
}

function model(
  client: OpenGradientClientLike,
  modelId = 'anthropic/claude-haiku-4-5',
) {
  return new OpenGradientChatLanguageModel(modelId, {
    settings: { privateKey: '0xabc' },
    createClient: () => client,
  });
}

const baseCall = {
  prompt: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
  ],
};

describe('OpenGradientChatLanguageModel.doGenerate', () => {
  it('maps a text completion, usage, finishReason and TEE metadata', async () => {
    const client = fakeClient({
      finishReason: 'stop',
      chatOutput: { role: 'assistant', content: 'Hi there!' },
      usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      teeSignature: 'sig123',
      teeEndpoint: 'https://13.59.207.188',
    });

    const result = await model(client).doGenerate(baseCall);

    expect(result.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect(result.usage.inputTokens.total).toBe(15);
    expect(result.usage.outputTokens.total).toBe(10);
    expect(result.providerMetadata?.opengradient).toEqual({
      teeSignature: 'sig123',
      teeEndpoint: 'https://13.59.207.188',
    });
  });

  it('injects the default maxTokens and passes through settlement mode', async () => {
    const chatSpy = vi.fn();
    const client = fakeClient(
      {
        finishReason: 'stop',
        chatOutput: { role: 'assistant', content: 'ok' },
      },
      chatSpy,
    );

    await model(client).doGenerate({
      ...baseCall,
      providerOptions: { opengradient: { settlementMode: 'individual' } },
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const args = chatSpy.mock.calls[0]![0];
    expect(args.maxTokens).toBe(1024);
    expect(args.x402SettlementMode).toBe('individual');
    expect(args.stream).toBe(false);
  });

  it('warns on unsupported settings and closes the client', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const client: OpenGradientClientLike = {
      llm: {
        chat: vi.fn().mockResolvedValue({
          finishReason: 'stop',
          chatOutput: { role: 'assistant', content: 'ok' },
        }) as never,
      },
      close: closeSpy as never,
    };

    const result = await model(client).doGenerate({
      ...baseCall,
      topP: 0.5,
      seed: 7,
    });

    const features = result.warnings.map((w) =>
      w.type === 'unsupported' ? w.feature : w.type,
    );
    expect(features).toContain('topP');
    expect(features).toContain('seed');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn for an empty headers object, but does for real headers', async () => {
    const client = () =>
      fakeClient({
        finishReason: 'stop',
        chatOutput: { role: 'assistant', content: 'ok' },
      });

    const empty = await model(client()).doGenerate({
      ...baseCall,
      headers: {},
    });
    expect(
      empty.warnings.some(
        (w) => w.type === 'unsupported' && w.feature === 'headers',
      ),
    ).toBe(false);

    const withHeaders = await model(client()).doGenerate({
      ...baseCall,
      headers: { 'x-foo': 'bar' },
    });
    expect(
      withHeaders.warnings.some(
        (w) => w.type === 'unsupported' && w.feature === 'headers',
      ),
    ).toBe(true);
  });

  it('maps tool calls into content and forwards tools/toolChoice', async () => {
    const chatSpy = vi.fn();
    const client = fakeClient(
      {
        finishReason: 'tool_calls',
        chatOutput: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
      },
      chatSpy,
    );

    const result = await model(client).doGenerate({
      ...baseCall,
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ],
      toolChoice: { type: 'auto' },
    });

    expect(result.finishReason).toEqual({
      unified: 'tool-calls',
      raw: 'tool_calls',
    });
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: '{"city":"Paris"}',
      },
    ]);

    const args = chatSpy.mock.calls[0]![0];
    expect(args.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      },
    ]);
    expect(args.toolChoice).toBe('auto');
  });

  it('warns and falls back to auto for a forced specific tool', async () => {
    const chatSpy = vi.fn();
    const client = fakeClient(
      {
        finishReason: 'stop',
        chatOutput: { role: 'assistant', content: 'ok' },
      },
      chatSpy,
    );

    const result = await model(client).doGenerate({
      ...baseCall,
      toolChoice: { type: 'tool', toolName: 'get_weather' },
    });

    expect(
      result.warnings.some(
        (w) => w.type === 'unsupported' && w.feature === 'tool-choice-specific',
      ),
    ).toBe(true);
    expect(chatSpy.mock.calls[0]![0].toolChoice).toBe('auto');
  });

  it('fails over to the next endpoint on a connection error', async () => {
    const closeA = vi.fn().mockResolvedValue(undefined);
    const closeB = vi.fn().mockResolvedValue(undefined);
    const seen: Array<string | undefined> = [];
    const m = new OpenGradientChatLanguageModel('anthropic/claude-haiku-4-5', {
      settings: {
        privateKey: '0xabc',
        llmServerUrl: ['https://a', 'https://b'],
      },
      createClient: (_settings, endpoint) => {
        seen.push(endpoint);
        if (endpoint === 'https://a') {
          return {
            llm: {
              chat: vi
                .fn()
                .mockRejectedValue(new TypeError('fetch failed')) as never,
            },
            close: closeA as never,
          };
        }
        return {
          llm: {
            chat: vi.fn().mockResolvedValue({
              finishReason: 'stop',
              chatOutput: { role: 'assistant', content: 'from B' },
            }) as never,
          },
          close: closeB as never,
        };
      },
    });

    const result = await m.doGenerate(baseCall);

    expect(seen).toEqual(['https://a', 'https://b']);
    expect(result.content).toEqual([{ type: 'text', text: 'from B' }]);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(
      result.warnings.some(
        (w) => w.type === 'other' && w.message.includes('https://a'),
      ),
    ).toBe(true);
  });

  it('does not fail over on a reachable-TEE error with a status code', async () => {
    const seen: Array<string | undefined> = [];
    const m = new OpenGradientChatLanguageModel('anthropic/claude-haiku-4-5', {
      settings: {
        privateKey: '0xabc',
        llmServerUrl: ['https://a', 'https://b'],
      },
      createClient: (_settings, endpoint) => {
        seen.push(endpoint);
        return {
          llm: {
            chat: vi
              .fn()
              .mockRejectedValue(
                new OpenGradientError('payment required', 402),
              ) as never,
          },
          close: vi.fn().mockResolvedValue(undefined) as never,
        };
      },
    });

    await expect(m.doGenerate(baseCall)).rejects.toMatchObject({
      name: 'AI_APICallError',
    });
    expect(seen).toEqual(['https://a']);
  });

  it('does not fail over on a non-network error', async () => {
    const seen: Array<string | undefined> = [];
    const m = new OpenGradientChatLanguageModel('anthropic/claude-haiku-4-5', {
      settings: {
        privateKey: '0xabc',
        llmServerUrl: ['https://a', 'https://b'],
      },
      createClient: (_settings, endpoint) => {
        seen.push(endpoint);
        return {
          llm: { chat: vi.fn().mockRejectedValue(new Error('boom')) as never },
          close: vi.fn().mockResolvedValue(undefined) as never,
        };
      },
    });

    await expect(m.doGenerate(baseCall)).rejects.toMatchObject({
      name: 'AI_APICallError',
    });
    expect(seen).toEqual(['https://a']);
  });

  it('preserves a successful result when close() rejects', async () => {
    const client: OpenGradientClientLike = {
      llm: {
        chat: vi.fn().mockResolvedValue({
          finishReason: 'stop',
          chatOutput: { role: 'assistant', content: 'ok' },
        }) as never,
      },
      close: vi.fn().mockRejectedValue(new Error('close failed')) as never,
    };

    const result = await model(client).doGenerate(baseCall);
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('preserves the original error when close() rejects', async () => {
    const client: OpenGradientClientLike = {
      llm: {
        chat: vi.fn().mockRejectedValue(new Error('upstream boom')) as never,
      },
      close: vi.fn().mockRejectedValue(new Error('close failed')) as never,
    };

    await expect(model(client).doGenerate(baseCall)).rejects.toMatchObject({
      message: 'upstream boom',
    });
  });

  it('throws without building a client when the signal is already aborted', async () => {
    const createClient = vi.fn();
    const m = new OpenGradientChatLanguageModel('anthropic/claude-haiku-4-5', {
      settings: { privateKey: '0xabc' },
      createClient: createClient as never,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      m.doGenerate({ ...baseCall, abortSignal: controller.signal }),
    ).rejects.toBeDefined();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('warns on an unknown settlementMode', async () => {
    const client = fakeClient({
      finishReason: 'stop',
      chatOutput: { role: 'assistant', content: 'ok' },
    });

    const result = await model(client).doGenerate({
      ...baseCall,
      providerOptions: { opengradient: { settlementMode: 'bogus' as never } },
    });

    expect(
      result.warnings.some(
        (w) => w.type === 'compatibility' && w.feature === 'settlementMode',
      ),
    ).toBe(true);
  });

  it('maps SDK errors to APICallError and still closes', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const client: OpenGradientClientLike = {
      llm: { chat: vi.fn().mockRejectedValue(new Error('boom')) as never },
      close: closeSpy as never,
    };

    await expect(model(client).doGenerate(baseCall)).rejects.toMatchObject({
      name: 'AI_APICallError',
      message: 'boom',
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

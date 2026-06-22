import { describe, it, expect, vi } from 'vitest';
import type { TextGenerationOutput } from 'opengradient-sdk';
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

function model(client: OpenGradientClientLike, modelId = 'anthropic/claude-haiku-4-5') {
  return new OpenGradientChatLanguageModel(modelId, {
    settings: { privateKey: '0xabc' },
    createClient: () => client,
  });
}

const baseCall = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
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
      { finishReason: 'stop', chatOutput: { role: 'assistant', content: 'ok' } },
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

    const result = await model(client).doGenerate({ ...baseCall, topP: 0.5, seed: 7 });

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

    const empty = await model(client()).doGenerate({ ...baseCall, headers: {} });
    expect(
      empty.warnings.some((w) => w.type === 'unsupported' && w.feature === 'headers'),
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

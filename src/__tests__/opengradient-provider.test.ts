import { describe, it, expect } from 'vitest';
import { NoSuchModelError } from '@ai-sdk/provider';
import { createOpenGradient, opengradient } from '../opengradient-provider';

describe('createOpenGradient', () => {
  it('exposes specificationVersion v3 at runtime', () => {
    const provider = createOpenGradient();
    expect(provider.specificationVersion).toBe('v3');
    expect(opengradient.specificationVersion).toBe('v3');
  });

  it('is callable and returns a v3 language model', () => {
    const provider = createOpenGradient({ privateKey: '0xabc' });
    const model = provider('anthropic/claude-haiku-4-5');
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('opengradient');
    expect(model.modelId).toBe('anthropic/claude-haiku-4-5');
  });

  it('languageModel and chat both build a model', () => {
    const provider = createOpenGradient({ privateKey: '0xabc' });
    expect(provider.languageModel('x').modelId).toBe('x');
    expect(provider.chat('y').modelId).toBe('y');
  });

  it('throws NoSuchModelError for embedding and image models', () => {
    const provider = createOpenGradient();
    expect(() => provider.embeddingModel('m')).toThrow(NoSuchModelError);
    expect(() => provider.imageModel('m')).toThrow(NoSuchModelError);
  });

  it('cannot be called with new', () => {
    const provider = createOpenGradient();
    const Ctor = provider as unknown as new (id: string) => unknown;
    expect(() => new Ctor('m')).toThrow();
  });
});

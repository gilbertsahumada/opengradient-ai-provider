import type { LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';
import { NoSuchModelError } from '@ai-sdk/provider';
import {
  OpenGradientChatLanguageModel,
  type OpenGradientChatConfig,
} from './opengradient-chat-language-model';
import type {
  OpenGradientChatModelId,
  OpenGradientProviderSettings,
} from './opengradient-chat-options';

/**
 * The OpenGradient provider. Callable as a shorthand for `.languageModel(id)`,
 * and implements the AI SDK `ProviderV3` shape.
 *
 * OpenGradient only serves language models (TEE LLM chat), so the embedding and
 * image model accessors throw `NoSuchModelError`.
 */
export interface OpenGradientProvider extends ProviderV3 {
  (modelId: OpenGradientChatModelId): LanguageModelV3;

  languageModel(modelId: OpenGradientChatModelId): LanguageModelV3;

  /** Alias for {@link languageModel}. */
  chat(modelId: OpenGradientChatModelId): LanguageModelV3;
}

/**
 * Create an OpenGradient provider instance.
 *
 * `settings` is optional — when omitted, the private key is resolved lazily from
 * `OPENGRADIENT_PRIVATE_KEY` at call time, so `createOpenGradient()` never throws
 * at construction.
 *
 * The wallet must hold OPG on Base mainnet and have granted Permit2 approval
 * (`ensureOpgApproval` from `opengradient-sdk`) before any inference call — that
 * is a documented prerequisite and is intentionally NOT performed here, since it
 * sends on-chain transactions.
 */
export function createOpenGradient(
  settings: OpenGradientProviderSettings = {},
): OpenGradientProvider {
  const config: OpenGradientChatConfig = { settings };

  const createChatModel = (
    modelId: OpenGradientChatModelId,
  ): LanguageModelV3 => new OpenGradientChatLanguageModel(modelId, config);

  const provider = function (modelId: OpenGradientChatModelId) {
    if (new.target) {
      throw new Error(
        'The OpenGradient provider cannot be called with the new keyword.',
      );
    }
    return createChatModel(modelId);
  } as OpenGradientProvider;

  provider.languageModel = createChatModel;
  provider.chat = createChatModel;

  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };
  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  return provider;
}

/**
 * Default OpenGradient provider instance. Resolves `OPENGRADIENT_PRIVATE_KEY`
 * from the environment lazily on first call, so importing it never throws.
 *
 * **Server-only** — it carries an EVM private key that controls real funds.
 * Never bundle it into client-side code. For custom configuration, use
 * {@link createOpenGradient}.
 */
export const opengradient: OpenGradientProvider = createOpenGradient();

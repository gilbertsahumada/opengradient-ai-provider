import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { UnsupportedFunctionalityError } from '@ai-sdk/provider';
import type {
  OpenGradientChatModelId,
  OpenGradientProviderSettings,
} from './opengradient-chat-options';

/**
 * Internal config handed to a chat model by the provider factory. Holds the
 * provider settings; the OpenGradient `Client` is constructed per-call inside
 * `doGenerate` / `doStream` (a later phase), not here.
 */
export interface OpenGradientChatConfig {
  settings: OpenGradientProviderSettings;
}

/**
 * OpenGradient TEE chat model implementing the AI SDK `LanguageModelV3` spec.
 *
 * Phase 1: structural stub. `doGenerate` / `doStream` are wired up in later
 * phases; the request/response mapping is documented in docs/PLAN.md.
 */
export class OpenGradientChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'opengradient';

  readonly modelId: OpenGradientChatModelId;

  /**
   * OpenGradient TEE chat accepts text only — message content is `string | null`
   * on the wire. No media URLs are fetched or supported natively.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly config: OpenGradientChatConfig;

  constructor(
    modelId: OpenGradientChatModelId,
    config: OpenGradientChatConfig,
  ) {
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(
    _options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    void this.config;
    throw new UnsupportedFunctionalityError({
      functionality: 'not-implemented-yet',
    });
  }

  async doStream(
    _options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    throw new UnsupportedFunctionalityError({
      functionality: 'not-implemented-yet',
    });
  }
}

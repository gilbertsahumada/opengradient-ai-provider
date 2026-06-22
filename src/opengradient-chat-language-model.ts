import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  SharedV3Warning,
} from '@ai-sdk/provider';
import { UnsupportedFunctionalityError } from '@ai-sdk/provider';
import {
  Client,
  TEE_LLM,
  X402SettlementMode,
  type ChatParams,
  type ClientConfig,
  type TextGenerationOutput,
} from 'opengradient-sdk';
import { convertToOpenGradientMessages } from './convert-to-opengradient-messages';
import { mapOpenGradientError } from './opengradient-error';
import { mapOpenGradientFinishReason } from './map-opengradient-finish-reason';
import { mapOpenGradientUsage } from './map-opengradient-usage';
import type {
  OpenGradientChatModelId,
  OpenGradientChatProviderOptions,
  OpenGradientProviderSettings,
} from './opengradient-chat-options';

/** Default output token cap (the SDK silently truncates at 100 otherwise). */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Minimal structural shape of the OpenGradient SDK client the model depends on.
 * Lets tests inject a fake without constructing a real on-chain `Client`.
 */
export interface OpenGradientClientLike {
  llm: {
    chat(
      params: ChatParams & { stream?: false },
    ): Promise<TextGenerationOutput>;
  };
  close(): Promise<void>;
}

/**
 * Internal config handed to a chat model by the provider factory. The client is
 * constructed per-call (lifecycle owned by `doGenerate`/`doStream`), via the
 * injectable `createClient` seam (defaults to a real `Client`).
 */
export interface OpenGradientChatConfig {
  settings: OpenGradientProviderSettings;
  createClient?: (settings: OpenGradientProviderSettings) => OpenGradientClientLike;
}

/** Resolve provider settings into an SDK `ClientConfig`, with env fallbacks. */
function resolveClientConfig(settings: OpenGradientProviderSettings): ClientConfig {
  const privateKey = settings.privateKey ?? process.env.OPENGRADIENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'OpenGradient: privateKey missing — pass it to createOpenGradient(...) or set OPENGRADIENT_PRIVATE_KEY',
    );
  }
  return {
    privateKey,
    rpcUrl: settings.rpcUrl ?? process.env.OPENGRADIENT_RPC_URL,
    llmServerUrl: settings.llmServerUrl ?? process.env.OPENGRADIENT_LLM_SERVER_URL,
    maxPaymentValue: settings.maxPaymentValue,
    teeRegistryAddress: settings.teeRegistryAddress,
  };
}

const defaultCreateClient = (
  settings: OpenGradientProviderSettings,
): OpenGradientClientLike => new Client(resolveClientConfig(settings));

const KNOWN_MODEL_IDS = new Set<string>(Object.values(TEE_LLM));

function mapSettlementMode(mode: string | undefined): X402SettlementMode | undefined {
  switch (mode) {
    case 'private':
      return X402SettlementMode.PRIVATE;
    case 'batch':
      return X402SettlementMode.BATCH_HASHED;
    case 'individual':
      return X402SettlementMode.INDIVIDUAL_FULL;
    default:
      return undefined;
  }
}

/**
 * OpenGradient TEE chat model implementing the AI SDK `LanguageModelV3` spec.
 * Phase 2: non-streaming text generation. `doStream` and tool calling land in
 * later phases.
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

  constructor(modelId: OpenGradientChatModelId, config: OpenGradientChatConfig) {
    this.modelId = modelId;
    this.config = config;
  }

  /** Build SDK `ChatParams` from V3 call options, collecting warnings. */
  private getArgs(options: LanguageModelV3CallOptions): {
    args: ChatParams;
    warnings: SharedV3Warning[];
  } {
    const { messages, warnings } = convertToOpenGradientMessages(options.prompt);

    // Settings the SDK chat path cannot honor.
    const unsupported: Array<[string, unknown]> = [
      ['topP', options.topP],
      ['topK', options.topK],
      ['presencePenalty', options.presencePenalty],
      ['frequencyPenalty', options.frequencyPenalty],
      ['seed', options.seed],
      ['abortSignal', options.abortSignal],
    ];
    for (const [feature, value] of unsupported) {
      if (value !== undefined) {
        warnings.push({ type: 'unsupported', feature });
      }
    }
    // The AI SDK forwards a `headers` object on every call (often empty), so
    // only warn when the caller actually set headers.
    if (options.headers && Object.keys(options.headers).length > 0) {
      warnings.push({ type: 'unsupported', feature: 'headers' });
    }
    if (options.tools && options.tools.length > 0) {
      warnings.push({
        type: 'unsupported',
        feature: 'tools',
        details: 'tool calling is implemented in a later phase',
      });
    }

    if (!KNOWN_MODEL_IDS.has(this.modelId)) {
      warnings.push({
        type: 'compatibility',
        feature: 'unknown-model-id',
        details: `"${this.modelId}" is not a known TEE_LLM id; passing through`,
      });
    }

    const providerOptions = options.providerOptions?.opengradient as
      | OpenGradientChatProviderOptions
      | undefined;

    const args: ChatParams = {
      model: this.modelId as TEE_LLM,
      messages,
      maxTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: options.temperature,
      stopSequence: options.stopSequences,
      responseFormat: this.mapResponseFormat(options.responseFormat, warnings),
      x402SettlementMode: mapSettlementMode(providerOptions?.settlementMode),
    };

    return { args, warnings };
  }

  private mapResponseFormat(
    responseFormat: LanguageModelV3CallOptions['responseFormat'],
    warnings: SharedV3Warning[],
  ): ChatParams['responseFormat'] {
    if (responseFormat == null || responseFormat.type === 'text') {
      return undefined;
    }
    if (responseFormat.schema) {
      return {
        type: 'json_schema',
        jsonSchema: {
          name: responseFormat.name ?? 'response',
          schema: responseFormat.schema as Record<string, unknown>,
        },
      };
    }
    warnings.push({
      type: 'compatibility',
      feature: 'json-object',
      details:
        'responseFormat json without a schema maps to json_object, which Anthropic models reject — provide a schema',
    });
    return { type: 'json_object' };
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const { args, warnings } = this.getArgs(options);
    const createClient = this.config.createClient ?? defaultCreateClient;
    const client = createClient(this.config.settings);

    let result: TextGenerationOutput;
    try {
      result = await client.llm.chat({ ...args, stream: false });
    } catch (error) {
      throw mapOpenGradientError(error, args, this.config.settings.llmServerUrl);
    } finally {
      await client.close();
    }

    return {
      content: [{ type: 'text', text: result.chatOutput?.content ?? '' }],
      finishReason: mapOpenGradientFinishReason(result.finishReason),
      usage: mapOpenGradientUsage(result.usage),
      providerMetadata: { opengradient: collectTeeMetadata(result) },
      warnings,
      request: { body: args },
    };
  }

  async doStream(
    _options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    throw new UnsupportedFunctionalityError({
      functionality: 'not-implemented-yet',
    });
  }
}

/** Surface TEE attestation + payment/settlement data as provider metadata. */
function collectTeeMetadata(
  result: TextGenerationOutput,
): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    teeSignature: result.teeSignature,
    teeId: result.teeId,
    teeTimestamp: result.teeTimestamp,
    teeEndpoint: result.teeEndpoint,
    teePaymentAddress: result.teePaymentAddress,
    paymentHash: result.paymentHash,
    dataSettlementTransactionHash: result.dataSettlementTransactionHash,
    dataSettlementBlobId: result.dataSettlementBlobId,
  };
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  return metadata;
}

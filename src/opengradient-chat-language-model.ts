import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3Warning,
} from '@ai-sdk/provider';
import {
  Client,
  TEE_LLM,
  X402SettlementMode,
  type ChatParams,
  type ClientConfig,
  type StreamChunk,
  type TextGenerationOutput,
  type Tool,
} from 'opengradient-sdk';
import { convertToOpenGradientMessages } from './convert-to-opengradient-messages';
import { mapOpenGradientError } from './opengradient-error';
import { mapOpenGradientFinishReason } from './map-opengradient-finish-reason';
import { mapOpenGradientUsage } from './map-opengradient-usage';
import { mapToolCalls } from './map-opengradient-tool-calls';
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
    chat(params: ChatParams & { stream: true }): AsyncIterable<StreamChunk>;
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

const SETTLEMENT_MODES: Record<string, X402SettlementMode> = {
  private: X402SettlementMode.PRIVATE,
  batch: X402SettlementMode.BATCH_HASHED,
  individual: X402SettlementMode.INDIVIDUAL_FULL,
};

function mapSettlementMode(
  mode: string | undefined,
): X402SettlementMode | undefined {
  return mode ? SETTLEMENT_MODES[mode] : undefined;
}

/**
 * Map a V3 tool choice to the SDK's plain-string `toolChoice`. Forcing a
 * specific tool is unsupported: the SDK types `toolChoice` as a string and can't
 * carry OpenAI's force-tool object, so we warn and fall back to `'auto'`.
 */
function mapToolChoice(
  choice: LanguageModelV3CallOptions['toolChoice'],
  warnings: SharedV3Warning[],
): string | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
    case 'none':
    case 'required':
      return choice.type;
    case 'tool':
      warnings.push({ type: 'unsupported', feature: 'tool-choice-specific' });
      return 'auto';
  }
}

/** Map V3 function tools to SDK `Tool[]`, warning on provider-defined tools. */
function mapTools(
  tools: LanguageModelV3CallOptions['tools'],
  warnings: SharedV3Warning[],
): Tool[] {
  if (!tools) return [];
  const mapped: Tool[] = [];
  for (const tool of tools) {
    if (tool.type === 'function') {
      mapped.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      });
    } else {
      warnings.push({ type: 'unsupported', feature: 'provider-defined-tool' });
    }
  }
  return mapped;
}

/**
 * OpenGradient TEE chat model implementing the AI SDK `LanguageModelV3` spec.
 * Supports non-streaming generation, streaming text, and tool calling (streaming
 * with tools is single-shot upstream — see `doStream`).
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
  private readonly createClient: (
    settings: OpenGradientProviderSettings,
  ) => OpenGradientClientLike;

  constructor(modelId: OpenGradientChatModelId, config: OpenGradientChatConfig) {
    this.modelId = modelId;
    this.config = config;
    this.createClient = config.createClient ?? defaultCreateClient;
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
    const tools = mapTools(options.tools, warnings);

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
      tools: tools.length > 0 ? tools : undefined,
      toolChoice: mapToolChoice(options.toolChoice, warnings),
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
    const client = this.createClient(this.config.settings);

    let result: TextGenerationOutput;
    try {
      result = await client.llm.chat({ ...args, stream: false });
    } catch (error) {
      throw mapOpenGradientError(error, args, this.config.settings.llmServerUrl);
    } finally {
      await client.close();
    }

    const content: LanguageModelV3Content[] = [];
    const text = result.chatOutput?.content ?? '';
    if (text) {
      content.push({ type: 'text', text });
    }
    const toolCalls = result.chatOutput?.tool_calls;
    if (toolCalls?.length) {
      content.push(...mapToolCalls(toolCalls));
    }
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      finishReason: mapOpenGradientFinishReason(result.finishReason),
      usage: mapOpenGradientUsage(result.usage),
      providerMetadata: { opengradient: collectTeeMetadata(result) },
      warnings,
      request: { body: args },
    };
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const { args, warnings } = this.getArgs(options);
    const client = this.createClient(this.config.settings);
    const llmServerUrl = this.config.settings.llmServerUrl;

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await client.close();
    };

    let textId: string | undefined;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings });
        try {
          // With tools the SDK degrades to a single non-streamed final chunk
          // carrying the full `tool_calls`; we synthesize the V3 tool parts from
          // it below (args are not token-streamed).
          for await (const chunk of client.llm.chat({ ...args, stream: true })) {
            if (options.includeRawChunks) {
              controller.enqueue({ type: 'raw', rawValue: chunk });
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;
            if (delta) {
              if (textId === undefined) {
                textId = crypto.randomUUID();
                controller.enqueue({ type: 'text-start', id: textId });
              }
              controller.enqueue({ type: 'text-delta', id: textId, delta });
            }

            if (chunk.isFinal) {
              if (textId !== undefined) {
                controller.enqueue({ type: 'text-end', id: textId });
              }
              const toolCalls = choice?.delta?.tool_calls;
              if (toolCalls?.length) {
                for (const toolCall of mapToolCalls(toolCalls)) {
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                  });
                  controller.enqueue({
                    type: 'tool-input-delta',
                    id: toolCall.toolCallId,
                    delta: toolCall.input,
                  });
                  controller.enqueue({
                    type: 'tool-input-end',
                    id: toolCall.toolCallId,
                  });
                  controller.enqueue(toolCall);
                }
              }
              controller.enqueue({
                type: 'finish',
                finishReason: mapOpenGradientFinishReason(
                  choice?.finish_reason ?? undefined,
                ),
                usage: mapOpenGradientUsage(chunk.usage),
                providerMetadata: {
                  opengradient: pickDefinedStrings(
                    chunk,
                    STREAM_TEE_METADATA_FIELDS,
                  ),
                },
              });
            }
          }
        } catch (error) {
          controller.enqueue({
            type: 'error',
            error: mapOpenGradientError(error, args, llmServerUrl),
          });
        } finally {
          await close();
          controller.close();
        }
      },
      cancel: close,
    });

    return { stream, request: { body: args } };
  }
}

/** TEE attestation + settlement fields present on a streaming final chunk. */
const STREAM_TEE_METADATA_FIELDS = [
  'teeSignature',
  'teeId',
  'teeTimestamp',
  'teeEndpoint',
  'teePaymentAddress',
  'dataSettlementTransactionHash',
  'dataSettlementBlobId',
] as const;

/** Non-streaming output adds `paymentHash` (absent from `StreamChunk`). */
const TEE_METADATA_FIELDS = [
  ...STREAM_TEE_METADATA_FIELDS,
  'paymentHash',
] as const;

/** Collect the defined string fields from `source` as provider metadata. */
function pickDefinedStrings<T>(
  source: T,
  fields: readonly (keyof T)[],
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string') {
      metadata[field as string] = value;
    }
  }
  return metadata;
}

/** Surface TEE attestation + payment/settlement data as provider metadata. */
function collectTeeMetadata(
  result: TextGenerationOutput,
): Record<string, string> {
  return pickDefinedStrings(result, TEE_METADATA_FIELDS);
}

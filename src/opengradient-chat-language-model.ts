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
  OpenGradientError,
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
  createClient?: (
    settings: OpenGradientProviderSettings,
    llmServerUrl: string | undefined,
  ) => OpenGradientClientLike;
}

/** Resolve provider settings into an SDK `ClientConfig` for one TEE endpoint. */
export function resolveClientConfig(
  settings: OpenGradientProviderSettings,
  llmServerUrl: string | undefined,
): ClientConfig {
  const privateKey =
    settings.privateKey ?? process.env.OPENGRADIENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'OpenGradient: privateKey missing, pass it to createOpenGradient(...) or set OPENGRADIENT_PRIVATE_KEY',
    );
  }
  return {
    privateKey,
    rpcUrl: settings.rpcUrl ?? process.env.OPENGRADIENT_RPC_URL,
    llmServerUrl,
    maxPaymentValue:
      settings.maxPaymentValue ??
      parseMaxPayment(process.env.OPENGRADIENT_MAX_PAYMENT_VALUE),
    teeRegistryAddress:
      settings.teeRegistryAddress ??
      process.env.OPENGRADIENT_TEE_REGISTRY_ADDRESS,
  };
}

/** Parse `OPENGRADIENT_MAX_PAYMENT_VALUE` to a bigint; ignore a malformed value. */
function parseMaxPayment(raw: string | undefined): bigint | undefined {
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

const defaultCreateClient = (
  settings: OpenGradientProviderSettings,
  llmServerUrl: string | undefined,
): OpenGradientClientLike =>
  new Client(resolveClientConfig(settings, llmServerUrl));

/**
 * Resolve the ordered list of TEE endpoints to try, with failover.
 *
 * INTERIM: the published SDK's default TEE registry is stale (returns no active
 * TEEs), so callers pass explicit `llmServerUrl` endpoint(s) and we fail over
 * across them in order. This bypasses on-chain TLS pinning and the endpoint IPs
 * rotate, so any hardcoded list is short-lived.
 *
 * FUTURE: once the SDK's registry is fixed (see docs/TS-SDK-REGISTRY-FIX.md),
 * drop the manual list and let the SDK discover and fail over across all active
 * TEEs on-chain, the way the Python SDK does, so no `llmServerUrl` is needed.
 *
 * An `undefined` element means "no override" → the SDK's registry path (the
 * default when no endpoints are configured).
 */
function resolveEndpoints(
  settings: OpenGradientProviderSettings,
): Array<string | undefined> {
  const configured = settings.llmServerUrl;
  if (Array.isArray(configured)) {
    return configured.length > 0 ? configured : [undefined];
  }
  if (typeof configured === 'string') {
    return [configured];
  }
  const env = process.env.OPENGRADIENT_LLM_SERVER_URL;
  if (env) {
    const list = env
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);
    return list.length > 0 ? list : [undefined];
  }
  return [undefined];
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * The SDK reports connection-level failures (the fetch threw, or a registry
 * refresh failed) as a status-less `OpenGradientError` whose message starts with
 * "TEE LLM request failed" / "TEE LLM stream failed". Status-less errors raised
 * *after* a paid request (e.g. "Invalid response", "empty body") or from config
 * validation do not match this prefix, so they never trigger a re-pay.
 */
const SDK_CONNECTION_FAILURE = /^TEE LLM (request|stream) failed/;

/**
 * Whether a failed request should fail over to the next TEE endpoint. Because
 * each attempt can spend funds, this is a strict allow-list of genuine
 * connection failures, never a reachable TEE's rejection (an `OpenGradientError`
 * with an HTTP `statusCode`) nor a local config/mapping bug, which would fail the
 * same way on the next TEE and risk paying twice.
 */
function isConnectionError(error: unknown): boolean {
  if (error instanceof OpenGradientError && error.statusCode !== undefined) {
    return false;
  }
  if (
    error instanceof OpenGradientError &&
    SDK_CONNECTION_FAILURE.test(error.message)
  ) {
    return true;
  }
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code && NETWORK_ERROR_CODES.has(e.code)) return true;
  if (e.cause?.code && NETWORK_ERROR_CODES.has(e.cause.code)) return true;
  return (
    error instanceof TypeError &&
    error.message.toLowerCase().includes('fetch failed')
  );
}

/** Close a client, swallowing cleanup errors so they never mask the result/error. */
async function safeClose(client: OpenGradientClientLike): Promise<void> {
  try {
    await client.close();
  } catch {
    /* empty */
  }
}

/**
 * Bail out before building a client (which would spend funds) if the request is
 * already aborted.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('OpenGradient: request aborted');
  }
}

/**
 * Surface a TEE failover as a warning so callers can see that the primary
 * endpoint(s) were unreachable, the transparency principle: never fail over
 * silently. The endpoint that ultimately served the request is in
 * `providerMetadata.opengradient.teeEndpoint`.
 */
function failoverWarning(
  failedEndpoints: string[],
  servedBy: string | undefined,
): SharedV3Warning {
  return {
    type: 'other',
    message: `OpenGradient: TEE endpoint(s) unreachable (${failedEndpoints.join(
      ', ',
    )}); failed over to ${servedBy ?? 'the registry default'}`,
  };
}

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
 * with tools is single-shot upstream, see `doStream`).
 */
export class OpenGradientChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'opengradient';

  readonly modelId: OpenGradientChatModelId;

  /**
   * OpenGradient TEE chat accepts text only, message content is `string | null`
   * on the wire. No media URLs are fetched or supported natively.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly config: OpenGradientChatConfig;
  private readonly createClient: (
    settings: OpenGradientProviderSettings,
    llmServerUrl: string | undefined,
  ) => OpenGradientClientLike;

  constructor(
    modelId: OpenGradientChatModelId,
    config: OpenGradientChatConfig,
  ) {
    this.modelId = modelId;
    this.config = config;
    this.createClient = config.createClient ?? defaultCreateClient;
  }

  /** Build SDK `ChatParams` from V3 call options, collecting warnings. */
  private getArgs(options: LanguageModelV3CallOptions): {
    args: ChatParams;
    warnings: SharedV3Warning[];
  } {
    const { messages, warnings } = convertToOpenGradientMessages(
      options.prompt,
    );

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

    const settlementMode = providerOptions?.settlementMode;
    if (settlementMode !== undefined && !(settlementMode in SETTLEMENT_MODES)) {
      warnings.push({
        type: 'compatibility',
        feature: 'settlementMode',
        details: `unknown settlementMode "${settlementMode}" ignored; expected private | batch | individual`,
      });
    }

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
        'responseFormat json without a schema maps to json_object, which Anthropic models reject, provide a schema',
    });
    return { type: 'json_object' };
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    throwIfAborted(options.abortSignal);
    const { args, warnings } = this.getArgs(options);
    const endpoints = resolveEndpoints(this.config.settings);
    const failedEndpoints: string[] = [];

    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      const client = this.createClient(this.config.settings, endpoint);
      try {
        const result = await client.llm.chat({ ...args, stream: false });

        if (failedEndpoints.length > 0) {
          warnings.push(failoverWarning(failedEndpoints, endpoint));
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
      } catch (error) {
        const isLast = i === endpoints.length - 1;
        if (isLast || !isConnectionError(error)) {
          throw mapOpenGradientError(error, args, endpoint);
        }
        if (endpoint) failedEndpoints.push(endpoint);
      } finally {
        await safeClose(client);
      }
    }

    throw new Error('OpenGradient: no TEE endpoints configured');
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    throwIfAborted(options.abortSignal);
    const { args, warnings } = this.getArgs(options);
    const endpoints = resolveEndpoints(this.config.settings);
    const createClient = this.createClient;
    const settings = this.config.settings;
    const includeRawChunks = options.includeRawChunks ?? false;

    let activeClient: OpenGradientClientLike | undefined;
    let activeIterator: AsyncIterator<StreamChunk> | undefined;
    let cancelled = false;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      const client = activeClient;
      activeClient = undefined;
      if (client) await safeClose(client);
    };

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        const enqueue = (part: LanguageModelV3StreamPart) => {
          if (!cancelled) controller.enqueue(part);
        };

        let iterator: AsyncIterator<StreamChunk> | undefined;
        let first: IteratorResult<StreamChunk> | undefined;
        let connectError: unknown;
        let endpoint: string | undefined;
        const failedEndpoints: string[] = [];

        for (let i = 0; i < endpoints.length; i++) {
          if (cancelled) break;
          endpoint = endpoints[i];
          try {
            const candidate = createClient(settings, endpoint);
            activeClient = candidate;
            const iterable = candidate.llm.chat({ ...args, stream: true });
            const it = iterable[Symbol.asyncIterator]();
            activeIterator = it;
            first = await it.next();
            iterator = it;
            break;
          } catch (error) {
            activeIterator = undefined;
            if (cancelled) break;
            if (activeClient) {
              await safeClose(activeClient);
              activeClient = undefined;
            }
            connectError = error;
            const isLast = i === endpoints.length - 1;
            if (isLast || !isConnectionError(error)) break;
            if (endpoint) failedEndpoints.push(endpoint);
          }
        }

        if (cancelled) return;

        if (iterator && failedEndpoints.length > 0) {
          warnings.push(failoverWarning(failedEndpoints, endpoint));
        }
        enqueue({ type: 'stream-start', warnings });

        if (!iterator || !first) {
          enqueue({
            type: 'error',
            error: mapOpenGradientError(connectError, args, endpoint),
          });
          if (!cancelled) controller.close();
          return;
        }

        let textId: string | undefined;
        let finished = false;
        try {
          let result = first;
          while (!result.done) {
            if (cancelled) break;
            const chunk = result.value;
            if (includeRawChunks) {
              enqueue({ type: 'raw', rawValue: chunk });
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;
            if (delta) {
              if (textId === undefined) {
                textId = crypto.randomUUID();
                enqueue({ type: 'text-start', id: textId });
              }
              enqueue({ type: 'text-delta', id: textId, delta });
            }

            if (chunk.isFinal) {
              if (textId !== undefined) {
                enqueue({ type: 'text-end', id: textId });
              }
              const toolCalls = choice?.delta?.tool_calls;
              if (toolCalls?.length) {
                for (const toolCall of mapToolCalls(toolCalls)) {
                  enqueue({
                    type: 'tool-input-start',
                    id: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                  });
                  enqueue({
                    type: 'tool-input-delta',
                    id: toolCall.toolCallId,
                    delta: toolCall.input,
                  });
                  enqueue({ type: 'tool-input-end', id: toolCall.toolCallId });
                  enqueue(toolCall);
                }
              }
              enqueue({
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
              finished = true;
            }

            result = await iterator.next();
          }

          if (!cancelled && !finished) {
            if (textId !== undefined) {
              enqueue({ type: 'text-end', id: textId });
            }
            enqueue({
              type: 'finish',
              finishReason: mapOpenGradientFinishReason(undefined),
              usage: mapOpenGradientUsage(undefined),
              providerMetadata: { opengradient: {} },
            });
          }
        } catch (error) {
          enqueue({
            type: 'error',
            error: mapOpenGradientError(error, args, endpoint),
          });
        } finally {
          await close();
          if (!cancelled) controller.close();
        }
      },
      async cancel() {
        cancelled = true;
        void Promise.resolve(activeIterator?.return?.()).catch(() => {});
        await close();
      },
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

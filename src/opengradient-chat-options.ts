import type { TEE_LLM } from 'opengradient-sdk';

/**
 * The set of TEE LLM model ids supported by OpenGradient. Accepts any of the
 * `TEE_LLM` enum string values (autocompletion via the union) while still
 * allowing arbitrary strings so the TEE can ship new models before the enum
 * is updated.
 */
export type OpenGradientChatModelId = TEE_LLM | (string & {});

/**
 * Provider-level configuration for the OpenGradient provider.
 *
 * Mirrors the OpenGradient SDK's `ClientConfig`. Unlike most AI SDK providers
 * there is **no base URL / API key** — the TEE endpoint and x402 payment flow
 * are resolved by the SDK from an on-chain registry, authenticated with an EVM
 * private key.
 *
 * Every field is optional: `privateKey` falls back to the
 * `OPENGRADIENT_PRIVATE_KEY` environment variable (and `rpcUrl` to
 * `OPENGRADIENT_RPC_URL`) when omitted, resolved lazily at call time.
 */
export interface OpenGradientProviderSettings {
  /**
   * EVM private key (hex string, with or without `0x` prefix) used to pay for
   * inference via x402 and to authenticate against the TEE. Server-only.
   *
   * Falls back to the `OPENGRADIENT_PRIVATE_KEY` environment variable.
   */
  privateKey?: string;

  /**
   * Override the RPC URL used to query the on-chain TEE registry.
   * Falls back to `OPENGRADIENT_RPC_URL`, then the SDK default.
   */
  rpcUrl?: string;

  /**
   * Hardcoded TEE LLM server URL(s) for dev / self-hosted use. When set, the
   * on-chain registry is bypassed and TLS pinning is disabled.
   *
   * Pass an array to fail over across endpoints in order: if one is unreachable
   * the next is tried. Falls back to `OPENGRADIENT_LLM_SERVER_URL`
   * (comma-separated for a list). This is an interim measure while the SDK's
   * default registry is stale — see the note in the language model.
   */
  llmServerUrl?: string | string[];

  /**
   * Maximum payment per request, in atomic units (USDC has 6 decimals).
   * Accepted and passed to the SDK, but **not currently enforced upstream** —
   * do not treat it as a spend cap.
   */
  maxPaymentValue?: bigint;

  /**
   * Override the deployed TEERegistry contract address.
   */
  teeRegistryAddress?: string;
}

/**
 * Per-call provider options, supplied via `providerOptions.opengradient` on an
 * AI SDK call. Parsed manually by the language model.
 *
 * String-literal values mirror the SDK's `X402SettlementMode` so consumers do
 * not need to import the SDK enum; they are mapped to the enum internally.
 */
export interface OpenGradientChatProviderOptions {
  /**
   * x402 settlement mode for this request. Defaults to the SDK default
   * (`batch`) when unset.
   */
  settlementMode?: 'private' | 'batch' | 'individual';
}

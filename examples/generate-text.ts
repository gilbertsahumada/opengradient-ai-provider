/**
 * Phase 2 example, non-streaming text generation via the AI SDK.
 *
 * Spends real OPG on Base. Prerequisites:
 *   - wallet funded with OPG + a little ETH on Base
 *   - `ensureOpgApproval` run once (see README)
 *
 * Run:
 *   npx tsx --env-file=.env examples/generate-text.ts
 *
 * Note: the published TS SDK's default registry currently has no active TEE, so
 * we pass `llmServerUrl`. The list below is the set of active TEEs discovered
 * from the current on-chain registry; the provider fails over across them in
 * order. IPs rotate, override via OPENGRADIENT_LLM_SERVER_URL (comma-separated)
 * or re-discover if all fail.
 */
import { generateText } from 'ai';
import { createOpenGradient } from '../src/index';
import { TEE_ENDPOINTS } from './shared';

const opengradient = createOpenGradient({
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
  llmServerUrl:
    process.env.OPENGRADIENT_LLM_SERVER_URL?.split(',') ?? TEE_ENDPOINTS,
});

const prompt =
  'In two sentences, explain what a Trusted Execution Environment (TEE) is and why it matters for verifiable AI.';

const { text, usage, finishReason, providerMetadata } = await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt,
});

console.log('\n──────── PROMPT ────────');
console.log(prompt);
console.log('\n──────── LLM RESPONSE ────────');
console.log(text);
console.log('\n──────── META ────────');
console.log('finishReason:', finishReason);
console.log(
  'tokens:      ',
  `${usage.inputTokens} in / ${usage.outputTokens} out`,
);
console.log('teeSignature:', providerMetadata?.opengradient?.teeSignature);
console.log('teeEndpoint: ', providerMetadata?.opengradient?.teeEndpoint);

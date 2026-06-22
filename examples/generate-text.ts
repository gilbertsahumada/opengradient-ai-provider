/**
 * Phase 2 example — non-streaming text generation via the AI SDK.
 *
 * Spends real OPG on Base. Prerequisites:
 *   - wallet funded with OPG + a little ETH on Base
 *   - `ensureOpgApproval` run once (see README)
 *
 * Run:
 *   npx tsx --env-file=.env examples/generate-text.ts
 *
 * Note: the published TS SDK's default registry currently has no active TEE, so
 * we pass `llmServerUrl`. Override with OPENGRADIENT_LLM_SERVER_URL; the default
 * below is an endpoint discovered from the current on-chain registry (may rotate).
 */
import { generateText } from 'ai';
import { createOpenGradient } from '../src/index';

const opengradient = createOpenGradient({
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
  llmServerUrl:
    process.env.OPENGRADIENT_LLM_SERVER_URL ?? 'https://13.59.207.188',
});

const { text, usage, finishReason, providerMetadata } = await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt: 'Say hi in 5 words.',
});

console.log('text:           ', text);
console.log('finishReason:   ', finishReason);
console.log('usage:          ', usage);
console.log('providerMetadata:', providerMetadata?.opengradient);

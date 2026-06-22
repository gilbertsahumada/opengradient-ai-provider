/**
 * Phase 3 example — streaming text generation via the AI SDK.
 *
 * Spends real OPG on Base. Prerequisites:
 *   - wallet funded with OPG + a little ETH on Base
 *   - `ensureOpgApproval` run once (see README)
 *
 * Run:
 *   npx tsx --env-file=.env examples/stream-text.ts
 *
 * Note: the published TS SDK's default registry currently has no active TEE, so
 * we pass `llmServerUrl`. Override with OPENGRADIENT_LLM_SERVER_URL; the default
 * below is an endpoint discovered from the current on-chain registry (may rotate).
 */
import { streamText } from 'ai';
import { createOpenGradient } from '../src/index';

const opengradient = createOpenGradient({
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
  llmServerUrl:
    process.env.OPENGRADIENT_LLM_SERVER_URL ?? 'https://13.59.207.188',
});

const prompt =
  'In two sentences, explain what a Trusted Execution Environment (TEE) is and why it matters for verifiable AI.';

const result = streamText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt,
});

console.log('\n──────── PROMPT ────────');
console.log(prompt);
console.log('\n──────── LLM RESPONSE (streaming) ────────');
for await (const delta of result.textStream) {
  process.stdout.write(delta);
}

const usage = await result.usage;
const finishReason = await result.finishReason;
const providerMetadata = await result.providerMetadata;

console.log('\n\n──────── META ────────');
console.log('finishReason:', finishReason);
console.log('tokens:      ', `${usage.inputTokens} in / ${usage.outputTokens} out`);
console.log('teeSignature:', providerMetadata?.opengradient?.teeSignature);
console.log('teeEndpoint: ', providerMetadata?.opengradient?.teeEndpoint);

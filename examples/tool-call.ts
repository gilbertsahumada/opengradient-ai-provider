/**
 * Phase 4 example — tool calling via the AI SDK.
 *
 * Spends real OPG on Base. Prerequisites:
 *   - wallet funded with OPG + a little ETH on Base
 *   - `ensureOpgApproval` run once (see README)
 *
 * Run:
 *   npx tsx --env-file=.env examples/tool-call.ts
 *
 * Note: streaming + tools is degraded upstream — `streamText` with tools goes
 * non-streaming inside the SDK and surfaces the tool call in one shot (arguments
 * are not token-streamed).
 */
import { generateText, streamText, tool, jsonSchema } from 'ai';
import { createOpenGradient } from '../src/index';

const opengradient = createOpenGradient({
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
  llmServerUrl:
    process.env.OPENGRADIENT_LLM_SERVER_URL ?? 'https://13.59.207.188',
});

const tools = {
  get_weather: tool({
    description: 'Get the current weather for a city.',
    inputSchema: jsonSchema<{ city: string }>({
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    }),
  }),
};

const prompt = 'What is the weather in Paris? Use the get_weather tool.';

console.log('\n──────── generateText + tools ────────');
const gen = await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  tools,
  prompt,
});
console.log('finishReason:', gen.finishReason);
console.log('toolCalls:   ', JSON.stringify(gen.toolCalls, null, 2));

console.log('\n──────── streamText + tools (degraded) ────────');
const streamed = streamText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  tools,
  prompt,
});
for await (const part of streamed.fullStream) {
  if (part.type === 'tool-call') {
    console.log('tool-call:', part.toolName, JSON.stringify(part.input));
  }
}
console.log('finishReason:', await streamed.finishReason);

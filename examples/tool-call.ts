/**
 * Tool calling, end to end. The model calls a tool that hits a real public API
 * (Open-Meteo, no API key), gets the result back, and writes a final answer. If
 * the final sentence carries the live temperature, the whole loop works: model ->
 * tool call -> real internet fetch -> model uses the result -> text.
 *
 * The second section shows streamText + tools, which is degraded upstream: the
 * SDK goes non-streaming and surfaces the tool call in one shot (arguments are not
 * token-streamed), then the final answer streams normally.
 *
 * Spends real OPG on Base, one paid TEE call per step. Prerequisites:
 *   - wallet funded with OPG + a little ETH on Base
 *   - `ensureOpgApproval` run once (see README)
 *
 * Run:
 *   npx tsx --env-file=.env examples/tool-call.ts
 */
import { generateText, streamText, tool, jsonSchema, stepCountIs } from 'ai';
import { createOpenGradient } from '../src/index';
import { TEE_ENDPOINTS } from './shared';

const opengradient = createOpenGradient({
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
  llmServerUrl:
    process.env.OPENGRADIENT_LLM_SERVER_URL?.split(',') ?? TEE_ENDPOINTS,
});

const tools = {
  get_weather: tool({
    description: 'Get the current temperature for a city, in Celsius.',
    inputSchema: jsonSchema<{ city: string }>({
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    }),
    execute: async ({ city }) => {
      const geo = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      ).then((r) => r.json());
      const place = geo?.results?.[0];
      if (!place) return { error: `City not found: ${city}` };

      const wx = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m`,
      ).then((r) => r.json());

      return {
        city: place.name,
        country: place.country,
        temperatureC: wx?.current?.temperature_2m,
        observedAt: wx?.current?.time,
      };
    },
  }),
};

const prompt =
  'What is the current temperature in Tokyo? Use the get_weather tool.';

console.log('\n──────── generateText + tools (full loop) ────────');
const gen = await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  tools,
  stopWhen: stepCountIs(3),
  prompt,
});
// `gen.toolResults` reflects only the last step (the text answer), so read the
// executed tool results from across all steps.
const toolResults = gen.steps.flatMap((s) => s.toolResults);
console.log('tool results:', JSON.stringify(toolResults, null, 2));
console.log('final answer:', gen.text);
console.log('steps:', gen.steps.length, '| finishReason:', gen.finishReason);

console.log('\n──────── streamText + tools (degraded streaming) ────────');
const streamed = streamText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  tools,
  stopWhen: stepCountIs(3),
  prompt,
});
for await (const part of streamed.fullStream) {
  if (part.type === 'tool-call') {
    console.log('tool-call:', part.toolName, JSON.stringify(part.input));
  } else if (part.type === 'text-delta') {
    process.stdout.write(part.text);
  }
}
console.log('\nfinishReason:', await streamed.finishReason);

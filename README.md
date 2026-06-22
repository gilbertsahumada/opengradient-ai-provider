# opengradient-ai-provider

A [Vercel AI SDK](https://sdk.vercel.ai) community provider for the
[OpenGradient](https://opengradient.ai) TEE LLM — verifiable inference inside a
Trusted Execution Environment, paid for on-chain via x402.

Implements `LanguageModelV3`: `generateText`, `streamText`, and tool calling, with
TEE attestation surfaced through `providerMetadata`.

## Install

```bash
npm install opengradient-ai-provider ai
```

`ai` (the Vercel AI SDK) is a peer dependency.

## Quick start

```ts
import { createOpenGradient } from 'opengradient-ai-provider';
import { generateText } from 'ai';

const opengradient = createOpenGradient({
  // server-only; falls back to OPENGRADIENT_PRIVATE_KEY when omitted
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
  // see "TEE endpoints" below — currently required
  llmServerUrl: process.env.OPENGRADIENT_LLM_SERVER_URL?.split(','),
});

const { text, providerMetadata } = await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt: 'In one sentence, what is a TEE?',
});

console.log(text);
console.log('TEE signature:', providerMetadata?.opengradient?.teeSignature);
```

### TEE endpoints (`llmServerUrl`) — currently required

The published OpenGradient SDK ships a default on-chain TEE registry that
currently returns **no active TEEs**, so the normal discovery path fails. As an
interim workaround, pass one or more TEE endpoints explicitly via `llmServerUrl`
(a string or an array); the provider tries them in order and **fails over** to the
next on a connection failure, surfacing a warning when it does.

```ts
const opengradient = createOpenGradient({
  llmServerUrl: ['https://13.59.207.188', 'https://3.15.214.21'],
});
```

Caveats: passing `llmServerUrl` **bypasses on-chain TLS pinning**, and the endpoint
IPs rotate over time. This is temporary until the SDK's registry discovery is
fixed (after which no `llmServerUrl` is needed). You can also set
`OPENGRADIENT_LLM_SERVER_URL` (comma-separated for a failover list).

## Streaming

```ts
import { streamText } from 'ai';

const result = streamText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt: 'Explain verifiable inference in two sentences.',
});

for await (const delta of result.textStream) process.stdout.write(delta);
console.log('\n', await result.providerMetadata);
```

## Tool calling

```ts
import { generateText, tool, jsonSchema } from 'ai';

const { toolCalls, finishReason } = await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt: 'What is the weather in Paris? Use the tool.',
  tools: {
    get_weather: tool({
      description: 'Get the current weather for a city.',
      inputSchema: jsonSchema<{ city: string }>({
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      }),
    }),
  },
});
```

`streamText` with tools works too, but is **degraded upstream**: the SDK falls back
to non-streaming and returns the tool call in a single final chunk (arguments are
not token-streamed). The provider synthesizes the proper V3 tool-call stream parts
from that chunk.

## TEE attestation

Every response exposes attestation and payment data under
`providerMetadata.opengradient`:

| Field                                                   | Description                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `teeSignature`                                          | RSA-PSS signature over the response (verifiable).            |
| `teeId`                                                 | On-chain registry id of the enclave that served the request. |
| `teeTimestamp`                                          | ISO-8601 signing time.                                       |
| `teeEndpoint`                                           | Endpoint URL of the serving TEE.                             |
| `teePaymentAddress`                                     | Payment address registered for the TEE.                      |
| `paymentHash`                                           | x402 payment hash (**non-streaming only**).                  |
| `dataSettlementTransactionHash`, `dataSettlementBlobId` | Data-settlement details, when available.                     |

## Configuration

`createOpenGradient(settings)` — all fields optional; each has an env fallback.

| Setting              | Type                 | Env fallback                                    | Notes                                                                                   |
| -------------------- | -------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `privateKey`         | `string`             | `OPENGRADIENT_PRIVATE_KEY`                      | EVM key that pays for inference. **Server-only.**                                       |
| `rpcUrl`             | `string`             | `OPENGRADIENT_RPC_URL`                          | RPC for the on-chain TEE registry.                                                      |
| `llmServerUrl`       | `string \| string[]` | `OPENGRADIENT_LLM_SERVER_URL` (comma-separated) | Explicit TEE endpoint(s) with failover (see above).                                     |
| `maxPaymentValue`    | `bigint`             | `OPENGRADIENT_MAX_PAYMENT_VALUE`                | Passed to the SDK. **Not enforced as a spend cap** upstream — do not rely on it as one. |
| `teeRegistryAddress` | `string`             | `OPENGRADIENT_TEE_REGISTRY_ADDRESS`             | Override the TEERegistry contract.                                                      |

### Per-call options

```ts
await generateText({
  model: opengradient('anthropic/claude-haiku-4-5'),
  prompt: '...',
  providerOptions: {
    opengradient: {
      // x402 settlement mode: 'private' | 'batch' | 'individual'
      settlementMode: 'individual',
    },
  },
});
```

## Security — server-only

This provider takes an **EVM private key that controls real funds**. Run it
**server-side only** (route handler, server action, backend). Never bundle it into
client-side code, never hard-code or commit the key; load it from
`OPENGRADIENT_PRIVATE_KEY`.

## Prerequisite — OPG / Permit2 approval

The paying wallet must hold **OPG on Base mainnet** (and a little ETH for the
one-time approval gas), and grant Permit2 approval **once** before any inference
call. The provider intentionally never does this — it sends on-chain transactions,
so you run it yourself:

```ts
import { ensureOpgApproval } from 'opengradient-sdk';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(
  process.env.OPENGRADIENT_PRIVATE_KEY as `0x${string}`,
);

// run once: approve up to 100 OPG for Permit2 (sends a tx; needs ETH for gas)
await ensureOpgApproval(account, 5, 100);
```

## Limitations

- **No multimodal:** file / image / audio parts are dropped with a warning (text only).
- **Streaming + tools is degraded:** the tool call arrives in one synthesized final
  chunk, not token-streamed.
- **`toolChoice: { type: 'tool' }`** (force a specific tool) is unsupported; it falls
  back to `'auto'` with a warning.
- **Ignored sampling params:** `topP`, `topK`, `presencePenalty`, `frequencyPenalty`,
  `seed`, `abortSignal` (mid-flight), and `headers` are not supported and warn.
- **JSON without a schema:** `responseFormat: { type: 'json' }` without a schema maps
  to `json_object`, which Anthropic models reject — provide a schema.
- **OPG / Permit2 approval** is a prerequisite (see above).

## Examples

Runnable scripts live in [`examples/`](./examples) on GitHub
(`generate-text.ts`, `stream-text.ts`, `tool-call.ts`).

## License

MIT © Gilberts Ahumada

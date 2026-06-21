# opengradient-ai-provider

A [Vercel AI SDK](https://sdk.vercel.ai) community provider for the
[OpenGradient](https://opengradient.ai) TEE LLM — verifiable inference inside a
Trusted Execution Environment, paid for on-chain via x402.

> **Status:** work in progress. Phase 1 (scaffold + `ProviderV3` factory with a
> `LanguageModelV3` stub) is complete; `doGenerate` / `doStream` are implemented
> in later phases. See `docs/PLAN.md`.

## Install

```bash
npm install opengradient-ai-provider ai
```

`ai` (the Vercel AI SDK) is a peer dependency.

## Usage (preview)

```ts
import { createOpenGradient } from 'opengradient-ai-provider';
import { generateText } from 'ai';

const opengradient = createOpenGradient({
  // falls back to OPENGRADIENT_PRIVATE_KEY when omitted
  privateKey: process.env.OPENGRADIENT_PRIVATE_KEY,
});

const model = opengradient('anthropic/claude-haiku-4-5');
```

## Security — server-only

This provider takes an **EVM private key that controls real funds**. It must run
**server-side only** (route handler, server action, backend). Never bundle it
into client-side code, never hard-code or commit the key. Load it from
`OPENGRADIENT_PRIVATE_KEY`.

## Prerequisite — OPG / Permit2 approval

The paying wallet must hold OPG on Base mainnet and grant Permit2 approval once
before any inference call. Run `ensureOpgApproval` from `opengradient-sdk`
yourself — the provider does **not** do this (it sends on-chain transactions):

```ts
import { ensureOpgApproval } from 'opengradient-sdk';
// run once, with a viem account derived from your private key
```

## License

MIT © Gilberts Ahumada

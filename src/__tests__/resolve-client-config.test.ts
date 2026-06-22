import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveClientConfig } from '../opengradient-chat-language-model';

// Includes PRIVATE_KEY so an ambient value in CI/local doesn't leak into tests.
const ENV_KEYS = [
  'OPENGRADIENT_TEE_REGISTRY_ADDRESS',
  'OPENGRADIENT_MAX_PAYMENT_VALUE',
  'OPENGRADIENT_RPC_URL',
  'OPENGRADIENT_PRIVATE_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('resolveClientConfig', () => {
  it('reads teeRegistryAddress and maxPaymentValue from env', () => {
    process.env.OPENGRADIENT_TEE_REGISTRY_ADDRESS = '0xregistry';
    process.env.OPENGRADIENT_MAX_PAYMENT_VALUE = '250000';

    const config = resolveClientConfig({ privateKey: '0xabc' }, undefined);

    expect(config.teeRegistryAddress).toBe('0xregistry');
    expect(config.maxPaymentValue).toBe(250000n);
  });

  it('prefers explicit settings over env', () => {
    process.env.OPENGRADIENT_TEE_REGISTRY_ADDRESS = '0xenv';
    process.env.OPENGRADIENT_MAX_PAYMENT_VALUE = '1';

    const config = resolveClientConfig(
      {
        privateKey: '0xabc',
        teeRegistryAddress: '0xsettings',
        maxPaymentValue: 9n,
      },
      undefined,
    );

    expect(config.teeRegistryAddress).toBe('0xsettings');
    expect(config.maxPaymentValue).toBe(9n);
  });

  it('ignores a malformed OPENGRADIENT_MAX_PAYMENT_VALUE', () => {
    process.env.OPENGRADIENT_MAX_PAYMENT_VALUE = 'not-a-number';
    const config = resolveClientConfig({ privateKey: '0xabc' }, undefined);
    expect(config.maxPaymentValue).toBeUndefined();
  });

  it('throws a clear error when no private key is available', () => {
    expect(() => resolveClientConfig({}, undefined)).toThrow(
      /privateKey missing/,
    );
  });
});

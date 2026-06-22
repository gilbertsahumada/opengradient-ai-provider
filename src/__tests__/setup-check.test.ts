import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import {
  checkOpenGradientSetup,
  type OpenGradientReadClient,
} from '../opengradient-setup-check';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;

/**
 * Fake read client: `balanceOf` and `allowance` are distinguished by `functionName`;
 * `getBalance` returns the native ETH balance.
 */
function readClient(values: {
  opg: bigint;
  eth: bigint;
  allowance: bigint;
}): OpenGradientReadClient {
  return {
    readContract: vi.fn(async ({ functionName }) =>
      functionName === 'allowance' ? values.allowance : values.opg,
    ) as never,
    getBalance: vi.fn(async () => values.eth) as never,
  };
}

describe('checkOpenGradientSetup', () => {
  it('reports ready with no issues when funded and approved', async () => {
    const report = await checkOpenGradientSetup({ address: ADDRESS } as never, {
      publicClient: readClient({ opg: 100n, eth: 5n, allowance: 50n }),
    });

    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.address).toBe(ADDRESS);
    expect(report.opgBalance).toBe(100n);
    expect(report.permit2Allowance).toBe(50n);
  });

  it('flags a missing OPG balance with a funding pointer', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({ opg: 0n, eth: 5n, allowance: 50n }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('hub.opengradient.ai'))).toBe(
      true,
    );
  });

  it('flags a missing Permit2 allowance with the approval command', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({ opg: 100n, eth: 5n, allowance: 0n }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('ensureOpgApproval'))).toBe(
      true,
    );
    expect(report.issues.some((i) => i.includes('ETH'))).toBe(false);
  });

  it('also flags missing gas when allowance is 0 and there is no ETH', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({ opg: 100n, eth: 0n, allowance: 0n }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('ensureOpgApproval'))).toBe(
      true,
    );
    expect(report.issues.some((i) => i.includes('ETH'))).toBe(true);
  });

  it('accepts a plain address string', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({ opg: 1n, eth: 1n, allowance: 1n }),
    });

    expect(report.address).toBe(ADDRESS);
    expect(report.ready).toBe(true);
  });
});

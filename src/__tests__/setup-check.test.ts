import { describe, it, expect, vi } from 'vitest';
import { parseUnits, type Address } from 'viem';
import {
  checkOpenGradientSetup,
  type OpenGradientReadClient,
} from '../opengradient-setup-check';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const opg = (n: string) => parseUnits(n, 18);

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
      publicClient: readClient({
        opg: opg('100'),
        eth: opg('0.01'),
        allowance: opg('100'),
      }),
    });

    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.address).toBe(ADDRESS);
    expect(report.opgBalance).toBe(opg('100'));
    expect(report.permit2Allowance).toBe(opg('100'));
  });

  it('flags a missing OPG balance with a funding pointer', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({
        opg: 0n,
        eth: opg('0.01'),
        allowance: opg('100'),
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('hub.opengradient.ai'))).toBe(
      true,
    );
  });

  it('flags a missing Permit2 allowance with the approval command', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({
        opg: opg('100'),
        eth: opg('0.01'),
        allowance: 0n,
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('ensureOpgApproval'))).toBe(
      true,
    );
    expect(report.issues.some((i) => i.includes('ETH'))).toBe(false);
  });

  it('treats a non-zero allowance below the 5 OPG minimum as not ready', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({
        opg: opg('100'),
        eth: opg('0.01'),
        allowance: opg('1'),
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('need ≥ 5'))).toBe(true);
    // Balance clears the approval minimum, so no balance warning.
    expect(report.issues.some((i) => i.includes('below the'))).toBe(false);
  });

  it('warns that a low OPG balance will make the approval call fail', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({
        opg: opg('1'),
        eth: opg('0.01'),
        allowance: 0n,
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('ensureOpgApproval'))).toBe(
      true,
    );
    expect(
      report.issues.some(
        (i) => i.includes('below the') && i.includes('approval'),
      ),
    ).toBe(true);
  });

  it('honors a custom minAllowance', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      minAllowance: opg('1'),
      publicClient: readClient({
        opg: opg('100'),
        eth: opg('0.01'),
        allowance: opg('1'),
      }),
    });

    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('reflects a custom minAllowance in the remediation advice', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      minAllowance: opg('10'),
      publicClient: readClient({
        opg: opg('100'),
        eth: opg('0.01'),
        allowance: opg('5'),
      }),
    });

    expect(report.ready).toBe(false);
    const allowanceIssue = report.issues.find((i) => i.includes('allowance'));
    expect(allowanceIssue).toContain('need ≥ 10');
    expect(allowanceIssue).toContain('ensureOpgApproval(account, 10');
    expect(allowanceIssue).not.toContain('account, 5');
  });

  it('also flags missing gas when the allowance is low and there is no ETH', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({ opg: opg('100'), eth: 0n, allowance: 0n }),
    });

    expect(report.ready).toBe(false);
    expect(report.issues.some((i) => i.includes('ensureOpgApproval'))).toBe(
      true,
    );
    expect(report.issues.some((i) => i.includes('ETH'))).toBe(true);
  });

  it('accepts a plain address string', async () => {
    const report = await checkOpenGradientSetup(ADDRESS, {
      publicClient: readClient({
        opg: opg('100'),
        eth: opg('0.01'),
        allowance: opg('100'),
      }),
    });

    expect(report.address).toBe(ADDRESS);
    expect(report.ready).toBe(true);
  });
});

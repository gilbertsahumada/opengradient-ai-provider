import {
  type Account,
  type Address,
  createPublicClient,
  erc20Abi,
  http,
} from 'viem';
import { base } from 'viem/chains';
import {
  BASE_MAINNET_RPC,
  BASE_OPG_ADDRESS,
  DEFAULT_HUB_SIGNUP_URL,
} from 'opengradient-sdk';

/**
 * Canonical Permit2 contract — deployed at the same address on every EVM chain
 * (deterministic CREATE2). Hardcoded to avoid a dependency on the SDK's transitive
 * `@x402/evm`.
 */
const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * A read-only on-chain report of whether a wallet is ready to pay for OpenGradient
 * inference. All amounts are raw atomic units (bigint); `issues` are actionable,
 * human-readable next steps.
 */
export interface OpenGradientSetupReport {
  address: Address;
  /** OPG balance on Base mainnet (atomic units). */
  opgBalance: bigint;
  /** Native ETH balance on Base — gas for the one-time Permit2 approval. */
  ethBalance: bigint;
  /** OPG allowance granted to Permit2 (atomic units). */
  permit2Allowance: bigint;
  /** True when the wallet can pay right now: OPG funded and Permit2 allowance set. */
  ready: boolean;
  issues: string[];
}

/**
 * Minimal read-only client seam (a subset of viem's `PublicClient`). Tests inject a
 * fake; production uses a real viem client against Base.
 */
export interface OpenGradientReadClient {
  readContract(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
}

export interface CheckOpenGradientSetupOptions {
  /**
   * RPC URL for **Base mainnet** (where OPG and Permit2 live). Defaults to a public
   * Base RPC. Note: this is unrelated to the provider's `rpcUrl`, which points at the
   * OpenGradient TEE registry network.
   */
  rpcUrl?: string;
  /** Inject a read client (for testing). Defaults to a viem client against Base. */
  publicClient?: OpenGradientReadClient;
}

/**
 * Read-only preflight: inspect a wallet's OPG balance, ETH-for-gas, and Permit2
 * allowance on Base so you can fix funding/approval before paying for inference.
 *
 * **Sends no transactions.** It never calls `ensureOpgApproval` or any write — when an
 * approval is needed it tells you to run it yourself.
 *
 * ```ts
 * import { privateKeyToAccount } from 'viem/accounts';
 * import { checkOpenGradientSetup } from 'opengradient-ai-provider';
 *
 * const account = privateKeyToAccount(process.env.OPENGRADIENT_PRIVATE_KEY as `0x${string}`);
 * const report = await checkOpenGradientSetup(account);
 * if (!report.ready) console.error(report.issues.join('\n'));
 * ```
 */
export async function checkOpenGradientSetup(
  account: Account | Address,
  opts: CheckOpenGradientSetupOptions = {},
): Promise<OpenGradientSetupReport> {
  const address = typeof account === 'string' ? account : account.address;

  const publicClient =
    opts.publicClient ??
    (createPublicClient({
      chain: base,
      transport: http(opts.rpcUrl ?? BASE_MAINNET_RPC),
    }) as unknown as OpenGradientReadClient);

  const [opgBalance, ethBalance, permit2Allowance] = await Promise.all([
    publicClient.readContract({
      address: BASE_OPG_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    }),
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: BASE_OPG_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [address, PERMIT2_ADDRESS],
    }),
  ]);

  const issues: string[] = [];
  if (opgBalance === 0n) {
    issues.push(
      `No OPG on Base for ${address}. Fund the wallet before inference — see ${DEFAULT_HUB_SIGNUP_URL}.`,
    );
  }
  if (permit2Allowance === 0n) {
    issues.push(
      'Permit2 allowance for OPG is 0. Run `ensureOpgApproval(account, 5, 100)` once before paying.',
    );
    if (ethBalance === 0n) {
      issues.push(
        'No ETH on Base for gas — the one-time Permit2 approval tx will fail. Fund the wallet with a little ETH.',
      );
    }
  }

  return {
    address,
    opgBalance,
    ethBalance,
    permit2Allowance,
    ready: opgBalance > 0n && permit2Allowance > 0n,
    issues,
  };
}

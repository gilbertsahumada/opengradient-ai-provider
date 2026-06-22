/**
 * Shared config for the example scripts (not part of the published package).
 */

/**
 * Active LLM-proxy TEEs from the OpenGradient registry
 * 0x703cB174AEadB35D611858369B4b1111dC9Abda6 (as of 2026-06-22), tried in order
 * with failover (the published SDK's default registry is stale — see
 * docs/TS-SDK-REGISTRY-FIX.md). IPs rotate — re-query the registry if all become
 * unreachable (preflight/check-payment-path.ts does this).
 */
export const TEE_ENDPOINTS = [
  'https://13.59.207.188',
  'https://3.15.214.21',
  'https://3.147.79.53',
];

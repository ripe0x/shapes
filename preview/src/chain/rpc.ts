import {createPublicClient, defineChain, fallback, http, type Transport} from "viem";

/** Public Sepolia endpoints from independent operators, used only after a configured primary. */
export const PUBLIC_SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://public.1rpc.io/sepolia",
  "https://sepolia.gateway.tenderly.co",
] as const;

/** Public mainnet endpoints from independent operators, tried after the configured primary and
 *  the deployment record's RPC. Free gateways rate-limit bursts with HTTP 429; the fallback
 *  transport moves to the next endpoint on any error. */
export const PUBLIC_MAINNET_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
] as const;

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Keeps a configured provider first, then the deployment record's RPC, then public endpoints for
 * mainnet and Sepolia so neither site depends on a single operator. Local chains keep their
 * explicit RPC only.
 */
export function rpcUrlsForChain(
  chainId: number,
  deploymentRpc: string,
  primaryRpc?: string,
): string[] {
  const publicRpcs = chainId === 1 ? PUBLIC_MAINNET_RPCS : chainId === 11155111 ? PUBLIC_SEPOLIA_RPCS : [];
  const urls = [primaryRpc, deploymentRpc, ...publicRpcs]
    .filter(nonEmpty)
    .map((url) => url.trim());
  return [...new Set(urls)];
}

/** Shared, non-batching failover policy for browser reads and server-side OG reads. */
export function fallbackTransport<const transports extends readonly Transport[]>(transports: transports) {
  // A failed provider moves straight to the next one. Retrying a dead endpoint first only makes
  // the gallery and OG route look unavailable for longer.
  return fallback(transports, {rank: false, retryCount: 0});
}

export function shapesTransport(chainId: number, deploymentRpc: string, primaryRpc?: string) {
  return fallbackTransport(
    rpcUrlsForChain(chainId, deploymentRpc, primaryRpc).map((url) =>
      // Keep requests unbatched. Site-level Multicall3 already coalesces reads, and an RPC batch
      // can exceed anvil's request-size limit during local seed demos.
      http(url, {batch: false, retryCount: 0}),
    ),
  );
}

export interface RpcDeployment {
  chainId: number;
  rpc: string;
}

export interface PublicClientOptions {
  /** An explicit test transport. Production callers use the shared fallback transport. */
  transport?: Transport;
  primaryRpcUrl?: string;
  chainName?: string;
}

/** The OG route's client constructor, kept here so it cannot drift from the browser transport. */
export function createShapesPublicClient(dep: RpcDeployment, options: PublicClientOptions = {}) {
  const primaryRpcUrl = options.primaryRpcUrl?.trim() || undefined;
  const chain = defineChain({
    id: dep.chainId,
    name: options.chainName ?? "Shapes",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: rpcUrlsForChain(dep.chainId, dep.rpc, primaryRpcUrl)}},
  });
  return createPublicClient({
    chain,
    transport: options.transport ?? shapesTransport(dep.chainId, dep.rpc, primaryRpcUrl),
  });
}

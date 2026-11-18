import {createPublicClient, defineChain, type Transport} from "viem";
import {rpcUrlsForChain, shapesTransport} from "./rpcTransport";
export {PUBLIC_MAINNET_RPCS, PUBLIC_SEPOLIA_RPCS, rpcUrlsForChain, fallbackTransport, shapesTransport, rpcRequestCounter} from "./rpcTransport";

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

import {getDefaultConfig} from "@rainbow-me/rainbowkit";
import {createConfig} from "wagmi";
import {injected} from "@wagmi/core";
import {defineChain, type Transport} from "viem";
import {sepolia} from "viem/chains";
import type {Deployment} from "./abi";
import {rpcUrlsForChain, shapesTransport} from "./rpc";

export interface WalletOptions {
  /** WalletConnect Cloud project id. Present enables the full RainbowKit wallet inventory
   *  (Rainbow, MetaMask, Coinbase, WalletConnect, ...); absent falls back to injected only. */
  walletConnectProjectId?: string;
  /** Optional paid/provider URL, ahead of deployment and public Sepolia fallbacks. */
  primaryRpcUrl?: string;
  /** Test-only override for exercising the client without live RPC requests. */
  transport?: Transport;
  /** Enable wagmi's deferred hydration when embedded in a server-rendered app. */
  ssr?: boolean;
}

/**
 * The viem chain for the deployment. Sepolia uses viem's canonical `sepolia` object; custom RPC
 * endpoints are applied through the transport rather than by redefining the chain. Only a
 * non-canonical dev chain (local anvil) is defined by hand.
 */
function deploymentChain(dep: Deployment, primaryRpcUrl?: string) {
  if (dep.chainId === sepolia.id) return sepolia;
  const rpcUrls = rpcUrlsForChain(dep.chainId, dep.rpc, primaryRpcUrl);
  return defineChain({
    id: dep.chainId,
    name: "Shapes dev chain",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: rpcUrls}},
    // Canonical Multicall3 address. fork-dev.sh etches it onto a plain dev chain; forks and
    // public chains already have it. Batched readers check for deployed code before using it.
    contracts: {multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"}},
  });
}

/**
 * Builds the wagmi config for a single deployment chain.
 *
 * With a WalletConnect project id this is RainbowKit's standard `getDefaultConfig` scoped to the
 * deployment chain. Wallet support for that chain is wallet-specific; Rainbow does not support
 * testnets and is therefore not a Sepolia acceptance target. Without a project id (local anvil dev,
 * unit tests) this is a plain injected-only config, so no relay identity is created.
 */
export function buildConfig(dep: Deployment, options: WalletOptions = {}) {
  const primaryRpcUrl = options.primaryRpcUrl?.trim() || undefined;
  const walletConnectProjectId = options.walletConnectProjectId?.trim() || undefined;
  const chain = deploymentChain(dep, primaryRpcUrl);
  // No transport-level JSON-RPC batching: same-tick Multicall3 aggregates would coalesce into
  // request bodies past anvil's ~2MB limit, which resets the connection.
  const transport = options.transport ?? shapesTransport(dep.chainId, dep.rpc, primaryRpcUrl);

  if (walletConnectProjectId) {
    return getDefaultConfig({
      appName: "Shapes",
      projectId: walletConnectProjectId,
      chains: [chain],
      transports: {[chain.id]: transport},
      ssr: options.ssr ?? false,
    });
  }

  return createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: {[chain.id]: transport},
    ssr: options.ssr ?? false,
  });
}

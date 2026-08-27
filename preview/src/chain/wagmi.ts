import {getDefaultConfig, type RainbowKitWalletConnectParameters} from "@rainbow-me/rainbowkit";
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
}

/** The viem chain for the deployment: id, RPC list, explorer, and Multicall3 for batched reads. */
function deploymentChain(dep: Deployment, primaryRpcUrl?: string) {
  const rpcUrls = rpcUrlsForChain(dep.chainId, dep.rpc, primaryRpcUrl);
  return defineChain({
    id: dep.chainId,
    name: dep.chainId === sepolia.id ? sepolia.name : "Shapes dev chain",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: rpcUrls}},
    blockExplorers:
      dep.chainId === sepolia.id
        ? {default: {name: "Etherscan", url: "https://sepolia.etherscan.io"}}
        : undefined,
    // Canonical Multicall3 address. fork-dev.sh etches it onto a plain dev chain; forks and
    // public chains already have it. Batched readers check for deployed code before using it.
    contracts: {multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"}},
  });
}

/**
 * Declares the deployment chain as WalletConnect's REQUIRED chain.
 *
 * WalletConnect's EthereumProvider derives the session's required namespace from `chains` and the
 * optional namespace from `optionalChains`. wagmi's connector only ever sets `optionalChains`, so
 * the required namespace is empty and a wallet's approval screen shows the network as "None" and
 * may return no accounts. Setting `chains` puts the deployment chain (Sepolia) in the required
 * namespace, so the approval names Sepolia and the account resolves on it. `chains` is a real
 * EthereumProvider option that wagmi omits from its public parameter type, hence the cast.
 */
function requiredWalletConnectChain(chainId: number): RainbowKitWalletConnectParameters {
  return {chains: [chainId]} as unknown as RainbowKitWalletConnectParameters;
}

/**
 * Builds the wagmi config for a single deployment chain.
 *
 * With a WalletConnect project id this is RainbowKit's `getDefaultConfig` scoped to exactly one
 * chain, with that chain declared as the required WalletConnect chain (see above). Without a
 * project id (local anvil dev, unit tests) it is a plain injected-only config, so no relay
 * identity is created.
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
      walletConnectParameters: requiredWalletConnectChain(chain.id),
      ssr: false,
    });
  }

  return createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: {[chain.id]: transport},
    ssr: false,
  });
}

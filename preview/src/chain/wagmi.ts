import {getDefaultWallets} from "@rainbow-me/rainbowkit";
import {createConfig} from "wagmi";
import {injected} from "@wagmi/core";
import {defineChain, http, type Transport} from "viem";
import {mainnet, sepolia} from "viem/chains";
import type {Deployment} from "./abi";
import {rpcUrlsForChain, shapesTransport} from "./rpc";

export interface WalletOptions {
  /** Optional real WalletConnect Cloud project id. Missing means injected wallets only. */
  walletConnectProjectId?: string;
  /** Optional paid/provider URL, ahead of deployment and public Sepolia fallbacks. */
  primaryRpcUrl?: string;
  /** Test-only override for exercising the client without live RPC requests. */
  transport?: Transport;
}

// The wagmi config is built from the deployment file at runtime, since the fork's chain id and
// RPC are only known then. WalletConnect is deliberately absent without a real project id: an
// injected wallet keeps working and no fake relay identity reaches production.
export function buildConfig(dep: Deployment, options: WalletOptions = {}) {
  const primaryRpcUrl = options.primaryRpcUrl?.trim() || undefined;
  const walletConnectProjectId = options.walletConnectProjectId?.trim() || undefined;
  const rpcUrls = rpcUrlsForChain(dep.chainId, dep.rpc, primaryRpcUrl);
  const chain = defineChain({
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

  // Use RainbowKit's maintained default inventory so mobile users see named deep-link choices
  // instead of only the generic Browser Wallet and WalletConnect entries.
  const connectors = walletConnectProjectId
    ? getDefaultWallets({appName: "Shapes", projectId: walletConnectProjectId}).connectors
    : [injected()];
  // Some mobile wallets do not expose an account when a testnet is the session's only namespace.
  // Bootstrap the WalletConnect session on Ethereum, advertise the deployment chain alongside it,
  // and switch to the deployment chain immediately before every Shapes write.
  const chains =
    walletConnectProjectId && chain.id !== mainnet.id
      ? ([mainnet, chain] as const)
      : ([chain] as const);
  const transports: Record<number, Transport> = {
    [chain.id]: options.transport ?? shapesTransport(dep.chainId, dep.rpc, primaryRpcUrl),
  };
  if (walletConnectProjectId && chain.id !== mainnet.id) transports[mainnet.id] = http();

  return createConfig({
    chains,
    connectors,
    // No transport-level JSON-RPC batching: same-tick Multicall3 aggregates would coalesce
    // into request bodies past anvil's ~2MB limit, which resets the connection.
    transports,
    ssr: false,
  });
}

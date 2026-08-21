import {connectorsForWallets} from "@rainbow-me/rainbowkit";
import {injectedWallet} from "@rainbow-me/rainbowkit/wallets";
import {createConfig, http} from "wagmi";
import {defineChain} from "viem";
import type {Deployment} from "./abi";

// The wagmi config is built from the deployment file at runtime, since the fork's chain id and
// RPC are only known then. Only the injected wallet is offered: this is a local dev tool, so no
// WalletConnect project id is needed and no remote relay is involved.
export function buildConfig(dep: Deployment) {
  const chain = defineChain({
    id: dep.chainId,
    name: "Shapes dev chain",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [dep.rpc]}},
    // Canonical Multicall3 address. fork-dev.sh etches it onto a plain dev chain; forks and
    // public chains already have it. Batched readers check for deployed code before using it.
    contracts: {multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"}},
  });

  const connectors = connectorsForWallets(
    [{groupName: "Recommended", wallets: [injectedWallet]}],
    {appName: "Shapes chain tester", projectId: "shapes-local-dev"},
  );

  return createConfig({
    chains: [chain],
    connectors,
    // No transport-level JSON-RPC batching: same-tick Multicall3 aggregates would coalesce
    // into request bodies past anvil's ~2MB limit, which resets the connection.
    transports: {[chain.id]: http(dep.rpc)},
    ssr: false,
  });
}

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
    name: "Shapes dev fork",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [dep.rpc]}},
  });

  const connectors = connectorsForWallets(
    [{groupName: "Recommended", wallets: [injectedWallet]}],
    {appName: "Shapes chain tester", projectId: "shapes-local-dev"},
  );

  return createConfig({
    chains: [chain],
    connectors,
    transports: {[chain.id]: http(dep.rpc)},
    ssr: false,
  });
}

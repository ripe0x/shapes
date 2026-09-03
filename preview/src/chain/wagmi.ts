import {getDefaultConfig} from "@rainbow-me/rainbowkit";
import {createConfig, createStorage, cookieStorage, cookieToInitialState, type Config} from "wagmi";
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
  /** Enable wagmi's deferred hydration when embedded in a server-rendered app. Also switches
   *  connection persistence from localStorage to a cookie (see `ssrStorage`), so the same
   *  connection state is readable on the server via `initialWalletState`. */
  ssr?: boolean;
}

/**
 * Connection storage for the server-rendered app. wagmi's default (localStorage) is invisible to
 * the server, so a fresh SSR render — and the client render that must match it — always starts
 * disconnected; only after the post-mount reconnect resolves does the wallet reappear, and any
 * remount before that (a route change that drops `WagmiProvider` from the tree, a hard refresh
 * racing a slow RPC) loses it again. Cookie storage is readable server-side via
 * `initialWalletState`, so the initial render already reflects the connection.
 */
export const ssrStorage = createStorage({storage: cookieStorage});

/**
 * Decodes the persisted wagmi connection state from a request's `Cookie` header, for use as
 * `WagmiProvider`'s `initialState`. Only `storage.key` (the "wagmi" prefix, shared by every
 * deployment's config) is consulted, so this needs no chain-specific config of its own.
 */
export function initialWalletState(cookieHeader?: string | null) {
  return cookieToInitialState({storage: ssrStorage} as unknown as Config, cookieHeader ?? undefined);
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

type WagmiConfig = Config;

// Keyed on the fields that determine wallet identity: chain, contract, ssr mode and wallet
// surface. A caller that rebuilds from a freshly-fetched (structurally equal but not
// referentially equal) deployment object still gets the exact same Config instance back, so a
// live connection's in-memory store is never swapped out for a second, disconnected one.
const configCache = new Map<string, WagmiConfig>();

function cacheKey(dep: Deployment, ssr: boolean, walletConnectProjectId: string | undefined): string {
  return `${dep.chainId}:${dep.shapes}:${ssr}:${walletConnectProjectId ?? ""}`;
}

/**
 * Builds the wagmi config for a single deployment chain.
 *
 * With a WalletConnect project id this is RainbowKit's standard `getDefaultConfig` scoped to the
 * deployment chain. Wallet support for that chain is wallet-specific; Rainbow does not support
 * testnets and is therefore not a Sepolia acceptance target. Without a project id (local anvil dev,
 * unit tests) this is a plain injected-only config, so no relay identity is created.
 *
 * Memoized (see `configCache`): the same deployment and wallet surface always resolve to the same
 * Config object for the life of the app.
 */
export function buildConfig(dep: Deployment, options: WalletOptions = {}): WagmiConfig {
  const primaryRpcUrl = options.primaryRpcUrl?.trim() || undefined;
  const walletConnectProjectId = options.walletConnectProjectId?.trim() || undefined;
  const ssr = options.ssr ?? false;

  const key = cacheKey(dep, ssr, walletConnectProjectId);
  const cached = configCache.get(key);
  if (cached) return cached;

  const chain = deploymentChain(dep, primaryRpcUrl);
  // No transport-level JSON-RPC batching: same-tick Multicall3 aggregates would coalesce into
  // request bodies past anvil's ~2MB limit, which resets the connection.
  const transport = options.transport ?? shapesTransport(dep.chainId, dep.rpc, primaryRpcUrl);
  const storage = ssr ? ssrStorage : undefined;

  const config = walletConnectProjectId
    ? getDefaultConfig({
        appName: "Shapes",
        projectId: walletConnectProjectId,
        chains: [chain],
        transports: {[chain.id]: transport},
        ssr,
        storage,
      })
    : createConfig({
        chains: [chain],
        connectors: [injected()],
        transports: {[chain.id]: transport},
        ssr,
        storage,
      });

  configCache.set(key, config);
  return config;
}

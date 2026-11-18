"use client";

import React from "react";
import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme, useConnectModal } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount } from "wagmi";
import type { Deployment } from "@shared/chain/abi";
import { buildConfig, initialWalletState } from "@shared/chain/wagmi";
import { useMintDraft } from "@shared/site/MintDraft";
import { DeploymentContext, SiteRuntimeContext } from "./deploymentContext";

const queryClient = new QueryClient();

function PendingConnection() {
  const { connectRequested, consumeConnect } = useMintDraft();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  React.useEffect(() => {
    if (!connectRequested) return;
    if (isConnected) { consumeConnect(); return; }
    if (openConnectModal) { openConnectModal(); consumeConnect(); }
  }, [connectRequested, consumeConnect, isConnected, openConnectModal]);
  return null;
}

export function ChainProviders({ children, deployment, siteRuntime }: {
  children: React.ReactNode;
  deployment: Deployment;
  siteRuntime: typeof import("./SiteRuntime").SiteRuntime;
}) {
  const [wallet] = React.useState(() => {
    // This component first mounts in the browser. Restore the cookie before Wagmi mounts,
    // without putting a visitor's wallet state into the server's cacheable public HTML.
    const config = buildConfig(deployment, {
      primaryRpcUrl: process.env.NEXT_PUBLIC_SHAPES_RPC_URL,
      walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
      ssr: true,
    });
    let initialState;
    try { initialState = initialWalletState(document.cookie); } catch { /* Ignore a damaged cookie. */ }
    return { config, initialState };
  });
  return (
    <WagmiProvider config={wallet.config} initialState={wallet.initialState} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme()}>
          <PendingConnection />
          <DeploymentContext.Provider value={deployment}>
            <SiteRuntimeContext.Provider value={siteRuntime}>{children}</SiteRuntimeContext.Provider>
          </DeploymentContext.Provider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

"use client";

import React from "react";
import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { Deployment } from "@shared/chain/abi";
import { buildConfig, initialWalletState } from "@shared/chain/wagmi";
import { DeploymentContext } from "./deploymentContext";

const queryClient = new QueryClient();

export function ChainProviders({ children, deployment }: {
  children: React.ReactNode;
  deployment: Deployment;
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
          <DeploymentContext.Provider value={deployment}>{children}</DeploymentContext.Provider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

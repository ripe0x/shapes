"use client";

import React from "react";
import { usePathname } from "next/navigation";
import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { Deployment } from "@shared/chain/abi";
import { buildConfig } from "@shared/chain/wagmi";

type WalletState = {
  dep: Deployment;
  config: ReturnType<typeof buildConfig>;
};

const DeploymentContext = React.createContext<Deployment | null>(null);
const queryClient = new QueryClient();

const centered: React.CSSProperties = {
  color: "#71716b",
  padding: 48,
  textAlign: "center",
  fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
};

/**
 * Keeps the wallet stack above routed pages so client navigation cannot replace it. The playground
 * remains deliberately wallet-free and does not wait for deployment metadata or an RPC.
 */
export function ShapesProviders({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPlayground = pathname === "/play";
  const [state, setState] = React.useState<WalletState | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isPlayground || state || err) return;

    let active = true;
    // A local dev target (script/lived-in.sh, web/public/deployment.local.json, gitignored)
    // takes priority over the bundled deployment.json so a local chain is picked up without
    // touching the tracked file. Falls back to deployment.json when no local target exists.
    fetch("/deployment.local.json", { cache: "no-store" })
      .then((response) => (response.ok ? response : fetch("/deployment.json", { cache: "no-store" })))
      .then((response) => {
        if (!response.ok) throw new Error("no deployment.json");
        return response.json();
      })
      .then((dep: Deployment) => {
        if (!active) return;
        setState({
          dep,
          config: buildConfig(dep, {
            primaryRpcUrl: process.env.NEXT_PUBLIC_SHAPES_RPC_URL,
            walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
            ssr: true,
          }),
        });
      })
      .catch(() => {
        if (active) setErr("The Shapes contract is not connected here yet.");
      });

    return () => {
      active = false;
    };
  }, [err, isPlayground, state]);

  if (isPlayground) return children;
  if (err) return <div style={centered}>{err}</div>;
  if (!state) return <div style={centered}>Connecting…</div>;

  return (
    <WagmiProvider config={state.config} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme()}>
          <DeploymentContext.Provider value={state.dep}>{children}</DeploymentContext.Provider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export function useShapesDeployment(): Deployment {
  const deployment = React.useContext(DeploymentContext);
  if (!deployment) throw new Error("useShapesDeployment must be used inside ShapesProviders");
  return deployment;
}

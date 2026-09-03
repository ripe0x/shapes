import "../reactPerfTrackOff";
import React from "react";
import {createRoot} from "react-dom/client";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@rainbow-me/rainbowkit/styles.css";
import {WagmiProvider} from "wagmi";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {RainbowKitProvider, lightTheme} from "@rainbow-me/rainbowkit";
import {SiteApp} from "./SiteApp";
import {buildConfig} from "../chain/wagmi";
import type {Deployment} from "../chain/abi";
import {C} from "./theme";

const queryClient = new QueryClient();

const centered: React.CSSProperties = {
  color: C.muted,
  padding: 48,
  textAlign: "center",
  fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
};

/**
 * Boot mirrors chain/main.tsx: the wagmi config depends on the deployment, so fetch it first.
 * VITE_SHAPES_RPC_URL optionally puts a paid/provider RPC first. VITE_WALLETCONNECT_PROJECT_ID
 * enables WalletConnect only when it is a real project id; otherwise injected wallets remain.
 */
function Boot() {
  const [state, setState] = React.useState<{
    dep: Deployment;
    config: ReturnType<typeof buildConfig>;
  } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/deployment.json", {cache: "no-store"})
      .then((r) => {
        if (!r.ok) throw new Error("no deployment.json");
        return r.json();
      })
      .then((dep: Deployment) =>
        setState({
          dep,
          config: buildConfig(dep, {
            primaryRpcUrl: import.meta.env.VITE_SHAPES_RPC_URL,
            walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
          }),
        }),
      )
      .catch(() =>
        setErr("No deployment found. Run ./script/fork-dev.sh from the repo root, then reload."),
      );
  }, []);

  if (err) return <div style={centered}>{err}</div>;
  if (!state) return <div style={centered}>Connecting…</div>;

  return (
    <WagmiProvider config={state.config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme()}>
          <SiteApp dep={state.dep} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
);

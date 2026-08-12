import React from "react";
import {createRoot} from "react-dom/client";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@rainbow-me/rainbowkit/styles.css";
import {WagmiProvider} from "wagmi";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {RainbowKitProvider, darkTheme} from "@rainbow-me/rainbowkit";
import {SiteApp} from "./SiteApp";
import {buildConfig} from "../chain/wagmi";
import type {Deployment} from "../chain/abi";

const queryClient = new QueryClient();

const centered: React.CSSProperties = {
  color: "#71716b",
  padding: 48,
  textAlign: "center",
  fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
};

/**
 * Boot mirrors chain/main.tsx: the wagmi config depends on the deployment, so fetch it first.
 * A public deployment replaces /deployment.json with a static deployment record and swaps
 * buildConfig's injected-only connector set for a full one (see chain/wagmi.ts).
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
      .then((dep: Deployment) => setState({dep, config: buildConfig(dep)}))
      .catch(() =>
        setErr("No deployment found. Run ./script/fork-dev.sh from the repo root, then reload."),
      );
  }, []);

  if (err) return <div style={centered}>{err}</div>;
  if (!state) return <div style={centered}>Connecting…</div>;

  return (
    <WagmiProvider config={state.config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
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

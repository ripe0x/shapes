import "../reactPerfTrackOff";
import React from "react";
import {createRoot} from "react-dom/client";
import "@rainbow-me/rainbowkit/styles.css";
import {WagmiProvider} from "wagmi";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {RainbowKitProvider, darkTheme} from "@rainbow-me/rainbowkit";
import {ChainApp} from "./ChainApp";
import {buildConfig} from "./wagmi";
import type {Deployment} from "./abi";

const queryClient = new QueryClient();

const centered: React.CSSProperties = {
  color: "#888",
  padding: 48,
  textAlign: "center",
  fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
};

// The wagmi config depends on the deployed chain, so fetch the deployment first, then build the
// providers around it.
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
  if (!state) return <div style={centered}>Connecting to dev chain…</div>;

  return (
    <WagmiProvider config={state.config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          <ChainApp dep={state.dep} />
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

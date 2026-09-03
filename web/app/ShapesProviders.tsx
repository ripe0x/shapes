"use client";

import React from "react";
import { usePathname } from "next/navigation";
import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, type State } from "wagmi";
import { getPublicClient } from "@wagmi/core";
import { shapesAbi, type Deployment } from "@shared/chain/abi";
import { buildConfig } from "@shared/chain/wagmi";
import { LADDER_NAME, UNIT } from "@shared/canonical/denominations";
import { LaunchLanding } from "./LaunchLanding";

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
 * remains deliberately wallet-free and does not wait for deployment metadata or an RPC. "/" needs
 * no chain either, except in app mode (`chainOnIndex`), where it hosts the mint panel inline and
 * so waits for the same deployment load as every other routed page.
 */
export function ShapesProviders({
  children,
  chainOnIndex,
  walletInitialState,
}: {
  children: React.ReactNode;
  chainOnIndex: boolean;
  /** Connection state decoded server-side from the request's cookies (see layout.tsx), so the
   *  first client render already reflects a previously connected wallet. */
  walletInitialState?: State;
}) {
  const pathname = usePathname();
  const isIndex = pathname === "/";
  const skipsChain = pathname === "/play" || (isIndex && !chainOnIndex);
  const [state, setState] = React.useState<WalletState | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (skipsChain || state || err) return;

    let active = true;
    // A local dev target (script/lived-in.sh, web/public/deployment.local.json, gitignored)
    // takes priority over the bundled deployment.json so a local chain is picked up without
    // touching the tracked file. Falls back to deployment.json when no local target exists.
    // The content-type check matters: the catch-all route streams a 200 HTML page for an unknown
    // path before notFound() can set the status, so a missing local file is not a non-ok response.
    const isJson = (response: Response) =>
      response.ok && (response.headers.get("content-type") ?? "").includes("json");
    fetch("/deployment.local.json", { cache: "no-store" })
      .then((response) => (isJson(response) ? response : fetch("/deployment.json", { cache: "no-store" })))
      .then((response) => {
        if (!response.ok) throw new Error("no deployment.json");
        return response.json();
      })
      .then(async (dep: Deployment) => {
        const config = buildConfig(dep, {
          primaryRpcUrl: process.env.NEXT_PUBLIC_SHAPES_RPC_URL,
          walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
          ssr: true,
        });
        // The denomination ladder is compiled in (SHAPES_LADDER at build time) while the contract
        // comes from deployment.json, so the two can disagree. One unit() read at load catches
        // that before any amount is shown. Uses the config's own fallback-wired transport.
        const client = getPublicClient(config);
        const unit = client
          ? await client.readContract({address: dep.shapes, abi: shapesAbi, functionName: "unit"})
          : UNIT;
        if (!active) return;
        if (unit !== UNIT) {
          setErr(
            `This build uses the ${LADDER_NAME} denomination ladder but the contract at ${dep.shapes} uses a different one. Rebuild with the matching SHAPES_LADDER.`,
          );
          return;
        }
        setState({dep, config});
      })
      .catch(() => {
        if (active) setErr("The Shapes contract is not connected here yet.");
      });

    return () => {
      active = false;
    };
  }, [err, skipsChain, state]);

  if (skipsChain) return children;
  // The index route in app mode hosts the mint panel inline: the hero renders immediately
  // rather than sitting behind "Connecting…", and a load failure surfaces inside the mint
  // section rather than replacing the whole page.
  if (isIndex && chainOnIndex) {
    // mintStartSeconds={0n} shows this transient placeholder as open immediately; the real gate
    // (dep.mintStart, once state resolves) takes over on the very next render.
    if (err) return <LaunchLanding mintStartSeconds={0n} mintSlot={<p className="launch-mint-unavailable">{err}</p>} />;
    if (!state) return <LaunchLanding mintStartSeconds={0n} />;
  } else {
    if (err) return <div style={centered}>{err}</div>;
    if (!state) return <div style={centered}>Connecting…</div>;
  }

  return (
    <WagmiProvider config={state.config} initialState={walletInitialState} reconnectOnMount>
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

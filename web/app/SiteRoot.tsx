"use client";

import React from "react";
import { useRouter } from "next/navigation";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@rainbow-me/rainbowkit/styles.css";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { SiteApp, type View } from "@shared/site/SiteApp";
import { buildConfig } from "@shared/chain/wagmi";
import type { Deployment } from "@shared/chain/abi";

const queryClient = new QueryClient();

const centered: React.CSSProperties = {
  color: "#71716b",
  padding: 48,
  textAlign: "center",
  fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
};

// Route slug <-> SiteApp view. "/" is the mint home; the others get their own path.
function pathFor(view: View, tokenId: bigint | null): string {
  if (view === "auction") return "/auction";
  if (view === "gallery") return "/gallery";
  if (view === "about") return "/how-it-works";
  if (view === "token" && tokenId !== null) return `/shape/${tokenId.toString()}`;
  if (view === "manage" && tokenId !== null) return `/shape/${tokenId.toString()}/manage`;
  return "/";
}

/**
 * The client shell: mirrors the Vite site's Boot (fetch the deployment, build the wagmi config,
 * wrap in the providers) and renders the shared SiteApp, but drives real URLs — the route's
 * `initialView`/`initialTokenId` set the view, and navigation pushes the matching path.
 */
export function SiteRoot({
  initialView,
  initialTokenId,
}: {
  initialView: View;
  initialTokenId: bigint | null;
}) {
  const router = useRouter();
  const [state, setState] = React.useState<{
    dep: Deployment;
    config: ReturnType<typeof buildConfig>;
  } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/deployment.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("no deployment.json");
        return r.json();
      })
      .then((dep: Deployment) =>
        setState({
          dep,
          config: buildConfig(dep, {
            primaryRpcUrl: process.env.NEXT_PUBLIC_SHAPES_RPC_URL,
            walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
          }),
        }),
      )
      .catch(() => setErr("The Shapes contract is not connected here yet."));
  }, []);

  if (err) return <div style={centered}>{err}</div>;
  if (!state) return <div style={centered}>Connecting…</div>;

  return (
    <WagmiProvider config={state.config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          <SiteApp
            dep={state.dep}
            initialView={initialView}
            initialTokenId={initialTokenId}
            onNavigate={(view, tokenId) => router.push(pathFor(view, tokenId))}
          />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

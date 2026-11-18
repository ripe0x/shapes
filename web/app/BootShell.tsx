"use client";

import React from "react";
import { useRouter } from "next/navigation";
import type { Deployment } from "@shared/chain/abi";
import { mintStartOf } from "@shared/site/mintValues";
import { useMintDraft } from "@shared/site/MintDraft";
import { MintPanelContent } from "@shared/site/MintPanelContent";
import type { View } from "@shared/site/SiteApp";
import { SiteHeader } from "@shared/site/SiteHeader";
import { SiteFooter } from "@shared/site/SiteFooter";
import { LaunchLanding } from "./LaunchLanding";

const paths: Partial<Record<View, string>> = {home: "/", mint: "/mint", gallery: "/gallery", packs: "/packs", fwa: "/fwa"};

export function BootShell({ pathname, deployment, error, onRetry }: {
  pathname: string;
  deployment: Deployment;
  error: string | null;
  onRetry: () => void;
}) {
  const router = useRouter();
  const draft = useMintDraft();
  const accountMenuRef = React.useRef<HTMLDivElement>(null);
  const header = <SiteHeader
    active={(Object.keys(paths) as View[]).find((view) => paths[view] === pathname) ?? null}
    go={(view) => { const path = paths[view]; if (path) router.push(path); }}
    routed isConnected={false} wrongChain={false} accountLabel="" accountMenuOpen={false}
    setAccountMenuOpen={() => {}} accountMenuRef={accountMenuRef}
    onConnect={draft.requestConnect} onSwitchChain={() => {}} onDisconnect={() => {}}
    refreshing={false} refreshFailed={false} onRetryRefresh={onRetry} initializing={!draft.bootstrap || draft.connectRequested || !!error} walletReady={false}
  />;
  const status = <div className="site-startup-status" role={error ? "alert" : "status"}>
    <p>{error ?? "Connecting…"}</p>
    {error && <button type="button" className="btn-ghost" onClick={onRetry}>Retry</button>}
  </div>;
  const mint = draft.bootstrap ? <MintPanelContent data={draft.bootstrap} dep={deployment}
    chainId={deployment.chainId} connected={false} sel={draft.sel} setSel={draft.setSel}
    qty={draft.qty} setQty={draft.setQty} mint={{status: "idle"}} onMint={() => {}}
    onOpenToken={() => {}} onConnect={draft.requestConnect} connectPending={draft.connectRequested} /> : status;
  if (pathname === "/") return <LaunchLanding header={<>{header}{error && status}</>}
    mintStartSeconds={draft.bootstrap?.mintStart ?? mintStartOf(deployment)} mintSlot={error ? null : mint} />;
  return <main className="site-app">{header}{error ? status : pathname === "/mint" ? mint : status}<SiteFooter /></main>;
}

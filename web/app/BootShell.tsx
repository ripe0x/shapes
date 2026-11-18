"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { mintStartOf, type Deployment } from "@shared/chain/abi";
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
  const accountMenuRef = React.useRef<HTMLDivElement>(null);
  const header = <SiteHeader
    active={(Object.keys(paths) as View[]).find((view) => paths[view] === pathname) ?? null}
    go={(view) => { const path = paths[view]; if (path) router.push(path); }}
    routed isConnected={false} wrongChain={false} accountLabel="" accountMenuOpen={false}
    setAccountMenuOpen={() => {}} accountMenuRef={accountMenuRef}
    onConnect={() => {}} onSwitchChain={() => {}} onDisconnect={() => {}}
    refreshing={false} refreshFailed={false} onRetryRefresh={onRetry} initializing
  />;
  const status = <div className="site-startup-status" role={error ? "alert" : "status"}>
    <p>{error ?? "Connecting…"}</p>
    {error && <button type="button" className="btn-ghost" onClick={onRetry}>Retry</button>}
  </div>;
  if (pathname === "/") return <LaunchLanding header={<>{header}{error && status}</>}
    mintStartSeconds={mintStartOf(deployment)} mintSlot={error ? null : status} />;
  return <main className="site-app">{header}{status}<SiteFooter /></main>;
}

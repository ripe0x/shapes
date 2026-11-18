"use client";

import React from "react";
import { usePathname } from "next/navigation";
import type { Deployment } from "@shared/chain/abi";
import { MintDraftProvider, type MintBootstrap } from "@shared/site/MintDraft";
import { BootShell } from "./BootShell";
import { verifyDeployment } from "./verifyDeployment";
import type { MintReadCalls } from "./mintReadAbi";
export { useShapesDeployment } from "./deploymentContext";

type Runtime = {
  Provider: typeof import("./ChainProviders").ChainProviders;
  Site: typeof import("./SiteRuntime").SiteRuntime;
  deployment: Deployment;
};

/** Keep the interactive mint draft above the wallet boundary so early input and a queued
 * Connect request survive the transition into the persistent full application. */
export function ShapesProviders({ children, chainOnIndex, indexerConfigured, deployment, mintCalls }: {
  children: React.ReactNode;
  chainOnIndex: boolean;
  indexerConfigured: boolean;
  deployment: Deployment;
  mintCalls: MintReadCalls;
}) {
  const pathname = usePathname();
  const skipsChain = pathname === "/play" || pathname === "/docs" || pathname.startsWith("/docs/") ||
    (pathname === "/" && !chainOnIndex);
  const [runtime, setRuntime] = React.useState<Runtime | null>(null);
  const [verified, setVerified] = React.useState<{ deployment: Deployment; mint: MintBootstrap } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const dep = React.useMemo(() => ({
    ...deployment, indexerUrl: indexerConfigured ? "/api/indexer" : undefined,
  }), [deployment, indexerConfigured]);

  React.useEffect(() => {
    if (skipsChain || verified || runtime) return;
    let active = true;
    verifyDeployment(dep, mintCalls).then((mint) => {
      if (active) setVerified({ deployment: dep, mint });
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : "The Shapes contract is not connected here yet.");
    });
    return () => { active = false; };
  }, [dep, mintCalls, skipsChain, verified, runtime, attempt]);

  React.useEffect(() => {
    if (!verified || runtime) return;
    let active = true;
    let frame = 0;
    // Let the validated form paint before background wallet downloads compete for bandwidth.
    const firstFrame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        Promise.all([import("./ChainProviders"), import("./SiteRuntime")]).then(([wallet, site]) => {
          if (active) setRuntime({ Provider: wallet.ChainProviders, Site: site.SiteRuntime, deployment: verified.deployment });
        }).catch(() => {
          if (active) setError("Wallet connection could not load. Please retry.");
        });
      });
    });
    return () => { active = false; cancelAnimationFrame(firstFrame); cancelAnimationFrame(frame); };
  }, [verified, runtime, attempt]);

  const retry = () => { setError(null); setAttempt((value) => value + 1); };
  let content: React.ReactNode;
  if (runtime) content = <runtime.Provider deployment={runtime.deployment} siteRuntime={runtime.Site}>{children}</runtime.Provider>;
  else if (skipsChain) content = children;
  else content = <BootShell pathname={pathname} deployment={verified?.deployment ?? dep} error={error} onRetry={retry} />;
  return <MintDraftProvider bootstrap={verified?.mint ?? null}>{content}</MintDraftProvider>;
}

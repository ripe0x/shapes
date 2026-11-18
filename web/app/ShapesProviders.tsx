"use client";

import React from "react";
import { usePathname } from "next/navigation";
import type { Deployment } from "@shared/chain/abi";
import { BootShell } from "./BootShell";
import { ChainProviders } from "./ChainProviders";
import { verifyDeployment } from "./verifyDeployment";
export { useShapesDeployment } from "./deploymentContext";

/** Public HTML does not depend on a wallet cookie or a live RPC. The persistent wallet stack
 * mounts after hydration and the denomination check, before any amounts/actions appear. */
export function ShapesProviders({ children, chainOnIndex, indexerConfigured, deployment }: {
  children: React.ReactNode;
  chainOnIndex: boolean;
  indexerConfigured: boolean;
  deployment: Deployment;
}) {
  const pathname = usePathname();
  const skipsChain = pathname === "/play" || pathname === "/docs" || pathname.startsWith("/docs/") ||
    (pathname === "/" && !chainOnIndex);
  const [runtime, setRuntime] = React.useState<{
    Provider: typeof ChainProviders;
    deployment: Deployment;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const dep = React.useMemo(() => ({
    ...deployment, indexerUrl: indexerConfigured ? "/api/indexer" : undefined,
  }), [deployment, indexerConfigured]);

  React.useEffect(() => {
    if (skipsChain || runtime) return;
    let active = true;
    verifyDeployment(dep).then(() => {
      if (active) setRuntime({ Provider: ChainProviders, deployment: dep });
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : "The Shapes contract is not connected here yet.");
    });
    return () => { active = false; };
  }, [dep, skipsChain, runtime, attempt]);

  // Once mounted, retain the wallet and query cache even when visiting wallet-free routes.
  if (runtime) return <runtime.Provider deployment={runtime.deployment}>{children}</runtime.Provider>;
  if (skipsChain) return children;
  return <BootShell pathname={pathname} deployment={dep} error={error} onRetry={() => {
    setError(null);
    setAttempt((value) => value + 1);
  }} />;
}

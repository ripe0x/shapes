"use client";

import { createContext, useContext } from "react";
import type { Deployment } from "@shared/chain/abi";

export const SiteRuntimeContext = createContext<typeof import("./SiteRuntime").SiteRuntime | null>(null);

export const DeploymentContext = createContext<Deployment | null>(null);

export function useShapesDeployment(): Deployment {
  const deployment = useContext(DeploymentContext);
  if (!deployment) throw new Error("useShapesDeployment must be used inside ShapesProviders");
  return deployment;
}

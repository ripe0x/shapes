"use client";

import React from "react";
import type { View } from "@shared/site/SiteApp";
import { SiteRuntimeContext } from "./deploymentContext";

export function SiteRoot(props: { initialView: View; initialTokenId: bigint | null }) {
  const Runtime = React.useContext(SiteRuntimeContext);
  if (!Runtime) throw new Error("Site runtime must load before wallet providers mount");
  return React.createElement(Runtime, props);
}

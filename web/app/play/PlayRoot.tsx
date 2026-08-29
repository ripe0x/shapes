"use client";

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { PlayApp } from "@shared/play/PlayApp";

/**
 * Client shell for `/play`. No providers, no fetch, no chain: the page must work with no wallet
 * and no RPC, which is why it renders `PlayApp` directly instead of going through `SiteRoot`
 * (which fetches `deployment.json` and wires up wagmi).
 */
export function PlayRoot() {
  return <PlayApp />;
}

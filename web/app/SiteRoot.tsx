"use client";

import { useRouter } from "next/navigation";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { SiteApp, type View } from "@shared/site/SiteApp";
import { ActivityFeed } from "@shared/site/ActivityFeed";
import { mintStartOf } from "@shared/chain/abi";
import { useShapesDeployment } from "./ShapesProviders";
import { LaunchLanding } from "./LaunchLanding";

// Route slug <-> SiteApp view. "home" owns "/"; the full mint app lives at "/mint".
function pathFor(view: View, tokenId: bigint | null): string {
  if (view === "home") return "/";
  if (view === "auction") return "/auction";
  if (view === "gallery") return "/gallery";
  if (view === "contracts") return "/contracts";
  if (view === "collection") return "/my-shapes";
  if (view === "token" && tokenId !== null) return `/shape/${tokenId.toString()}`;
  if (view === "manage" && tokenId !== null) return `/shape/${tokenId.toString()}/manage`;
  return "/mint";
}

/**
 * The routed client shell. Wallet providers live in the persistent root layout so changing URLs
 * cannot disconnect the active wallet.
 */
export function SiteRoot({
  initialView,
  initialTokenId,
}: {
  initialView: View;
  initialTokenId: bigint | null;
}) {
  const router = useRouter();
  const dep = useShapesDeployment();

  return (
    <SiteApp
      dep={dep}
      initialView={initialView}
      initialTokenId={initialTokenId}
      onNavigate={(view, tokenId) => router.push(pathFor(view, tokenId))}
      renderHome={(mint, footer, header, data) => (
        <LaunchLanding
          mintSlot={mint}
          activity={
            <ActivityFeed
              indexerUrl={dep.indexerUrl}
              chainId={dep.chainId}
              onOpenToken={(id) => router.push(pathFor("token", id))}
              totalSupply={data?.supply ?? null}
              redeemableBacking={data?.reserve ?? null}
            />
          }
          footer={footer}
          header={header}
          mintStartSeconds={mintStartOf(dep)}
        />
      )}
    />
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { View } from "@shared/site/SiteApp";
import { SiteRoot } from "../SiteRoot";
import { PlayRoot } from "../play/PlayRoot";

type Params = { slug?: string[] };
type SearchParams = { s?: string | string[] };

const MAX_OG_STATE_LENGTH = 6000;

// Resolve a URL path into the SiteApp view it shows. Returns null for an unknown path.
function resolve(slug: string[] | undefined): { view: View; tokenId: bigint | null } | null {
  const parts = slug ?? [];
  if (parts.length === 0) return { view: "mint", tokenId: null };
  if (parts.length === 1 && parts[0] === "auction") return { view: "auction", tokenId: null };
  if (parts.length === 1 && parts[0] === "gallery") return { view: "gallery", tokenId: null };
  if (parts.length === 1 && parts[0] === "my-shapes") return { view: "collection", tokenId: null };
  if (parts.length === 1 && parts[0] === "how-it-works") return { view: "about", tokenId: null };
  if (parts.length === 2 && parts[0] === "shape" && /^\d+$/.test(parts[1])) {
    return { view: "token", tokenId: BigInt(parts[1]) };
  }
  if (parts.length === 3 && parts[0] === "shape" && /^\d+$/.test(parts[1]) && parts[2] === "manage") {
    return { view: "manage", tokenId: BigInt(parts[1]) };
  }
  return null;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const slug = (await params).slug ?? [];
  if (slug.length === 1 && slug[0] === "play") {
    const s = (await searchParams).s;
    const state = typeof s === "string" && s.length > 0 && s.length <= MAX_OG_STATE_LENGTH ? s : null;
    const ogUrl = state ? `/og/play?s=${encodeURIComponent(state)}` : "/og/play";
    return {
      title: "Playground",
      description:
        "Draw a Shape, compose Shapes, and trace every cell to its parent. Simulation, no wallet, nothing minted.",
      openGraph: {
        title: "Playground · Shapes",
        url: "/play",
        images: [{ url: ogUrl, width: 1200, height: 630 }],
      },
      twitter: { card: "summary_large_image", images: [ogUrl] },
    };
  }

  const r = resolve(slug);
  if (!r) return { title: "Not found" };

  if (r.view === "auction") {
    return {
      title: "Auction",
      description:
        "Token 0 of the collection, sold at auction. Bids are Shapes: a set of cards whose backing sums to the bid.",
      openGraph: { title: "Auction · Shapes", url: "/auction" },
    };
  }
  if (r.view === "gallery") {
    return {
      title: "Gallery",
      description: "Every live Shape in the collection, newest first.",
      openGraph: { title: "Gallery · Shapes", url: "/gallery" },
    };
  }
  if (r.view === "collection") {
    return {
      title: "My Shapes",
      description: "The live Shapes currently owned by your connected wallet.",
      openGraph: { title: "My Shapes · Shapes", url: "/my-shapes" },
    };
  }
  if (r.view === "about") {
    return {
      title: "How it works",
      description:
        "ETH in, Shape out. How Shapes wrap ETH, redeem for exactly their backing, and generate their art entirely on chain.",
      openGraph: { title: "How it works · Shapes", url: "/how-it-works" },
    };
  }
  if (r.view === "token" && r.tokenId !== null) {
    const id = r.tokenId.toString();
    return {
      title: `Shape ${id}`,
      description: `Shape ${id} — an ETH-backed on-chain object, redeemable for exactly its denomination.`,
      openGraph: {
        title: `Shape ${id} · Shapes`,
        url: `/shape/${id}`,
        images: [{ url: `/og/shape/${id}`, width: 1200, height: 630 }],
      },
      twitter: { card: "summary_large_image", images: [`/og/shape/${id}`] },
    };
  }
  if (r.view === "manage" && r.tokenId !== null) {
    const id = r.tokenId.toString();
    return {
      title: `Manage Shape ${id}`,
      description: `Review and manage the available lifecycle actions for Shape ${id}.`,
      openGraph: {title: `Manage Shape ${id} · Shapes`, url: `/shape/${id}/manage`},
    };
  }
  return {
    title: "Shapes",
    description: "ETH in, Shape out. Shape burned, the same ETH out.",
  };
}

export default async function Page({ params }: { params: Promise<Params> }) {
  const slug = (await params).slug ?? [];
  if (slug.length === 1 && slug[0] === "play") {
    return <PlayRoot />;
  }

  const r = resolve(slug);
  if (!r) notFound();
  return <SiteRoot initialView={r.view} initialTokenId={r.tokenId} />;
}

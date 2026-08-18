import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { View } from "@shared/site/SiteApp";
import { SiteRoot } from "../SiteRoot";

type Params = { slug?: string[] };

// Resolve a URL path into the SiteApp view it shows. Returns null for an unknown path.
function resolve(slug: string[] | undefined): { view: View; tokenId: bigint | null } | null {
  const parts = slug ?? [];
  if (parts.length === 0) return { view: "mint", tokenId: null };
  if (parts.length === 1 && parts[0] === "gallery") return { view: "gallery", tokenId: null };
  if (parts.length === 1 && parts[0] === "how-it-works") return { view: "about", tokenId: null };
  if (parts.length === 2 && parts[0] === "shape" && /^\d+$/.test(parts[1])) {
    return { view: "token", tokenId: BigInt(parts[1]) };
  }
  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const r = resolve((await params).slug);
  if (!r) return { title: "Not found" };

  if (r.view === "gallery") {
    return {
      title: "Gallery",
      description: "Every live Shape in the collection, newest first.",
      openGraph: { title: "Gallery · Shapes", url: "/gallery" },
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
      title: `Shape #${id}`,
      description: `Shape #${id} — an ETH-backed on-chain object, redeemable for exactly its denomination.`,
      openGraph: {
        title: `Shape #${id} · Shapes`,
        url: `/shape/${id}`,
        images: [{ url: `/og/shape/${id}`, width: 1200, height: 630 }],
      },
      twitter: { card: "summary_large_image", images: [`/og/shape/${id}`] },
    };
  }
  return {
    title: "Shapes",
    description: "ETH in, Shape out. Shape burned, the same ETH out.",
  };
}

export default async function Page({ params }: { params: Promise<Params> }) {
  const r = resolve((await params).slug);
  if (!r) notFound();
  return <SiteRoot initialView={r.view} initialTokenId={r.tokenId} />;
}

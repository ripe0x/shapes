import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

// Canonical origin for absolute OG/Twitter URLs. Env-overridable so a preview deploy can stamp its
// own origin; defaults to the production custom domain.
const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://shapes.ripe.wtf";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: "Shapes",
    template: "%s · Shapes",
  },
  description:
    "ETH in, Shape out. Shape burned, the same ETH out. An ERC721 that wraps an exact amount of ETH at nine fixed denominations, with fully on-chain generative art.",
  openGraph: {
    title: "Shapes",
    description:
      "ETH in, Shape out. Shape burned, the same ETH out. Fully on-chain, exactly redeemable.",
    url: SITE,
    siteName: "Shapes",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Shapes",
    description:
      "ETH in, Shape out. Shape burned, the same ETH out. Fully on-chain, exactly redeemable.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* react-dom 19.2's dev build logs component renders to the Performance panel and
            serializes prop diffs with JSON.stringify, which throws on props containing an
            array of bigints (addValueToProperties, PRIMITIVE_ARRAY branch) and crashes the
            tree. The track is enabled only if console.timeStamp exists when react-dom's
            module scope runs; beforeInteractive executes this before any framework chunk.
            Production react-dom omits the track. Remove once react-dom serializes bigint
            arrays without throwing. Same workaround as preview/src/reactPerfTrackOff.ts. */}
        {process.env.NODE_ENV === "development" && (
          <Script id="react-perf-track-off" strategy="beforeInteractive">
            {`delete console.timeStamp;`}
          </Script>
        )}
        {children}
      </body>
    </html>
  );
}

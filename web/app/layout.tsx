import type { Metadata } from "next";
import Script from "next/script";
import { ShapesProviders } from "./ShapesProviders";
import { appOnly } from "./lib/siteMode";
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
      {/* suppressHydrationWarning: browser extensions (e.g. screen recorders) inject body
          attributes before hydration; attribute-level mismatches are noise, content
          mismatches still warn. */}
      <body suppressHydrationWarning>
        {/* react-dom 19.2's development Performance track JSON-stringifies bigint arrays and can
            crash the tree. It only arms when console.timeStamp exists before React initializes. */}
        {process.env.NODE_ENV === "development" && (
          <Script id="react-perf-track-off" strategy="beforeInteractive">
            {`delete console.timeStamp;`}
          </Script>
        )}
        <ShapesProviders chainOnIndex={appOnly()}>{children}</ShapesProviders>
      </body>
    </html>
  );
}

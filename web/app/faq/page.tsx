import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { SiteFooter } from "@shared/site/SiteFooter";
import { ChainFreeHeader } from "../ChainFreeHeader";
import { renderDoc } from "../docs/render";

export const dynamic = "force-static";

// The FAQ source is one markdown file outside web/docs, so it stays out of the docs nav while
// rendering through the same renderer and the same .docs-* typography. process.cwd() is the
// `web/` package directory in both `next dev` and `next build`.
function readFaq() {
  return renderDoc(readFileSync(path.join(process.cwd(), "content", "faq.md"), "utf8"));
}

export function generateMetadata(): Metadata {
  return {
    title: "FAQ",
    description:
      "What a Shape is, what the ETH inside it does, and what the contract can and cannot do. Forty questions about Shapes, answered against the deployed contracts.",
  };
}

export default function FaqPage() {
  // renderDoc ids every heading and collects the h2s, which are the question groups here.
  const doc = readFaq();

  return (
    <>
      <ChainFreeHeader />

      <div className="faq-layout">
        <main className="docs-main">
          <h1>{doc.title || "Questions"}</h1>

          <nav className="faq-jump" aria-label="Question groups">
            {doc.toc.map((group) => (
              <a key={group.id} href={`#${group.id}`}>
                {group.text}
              </a>
            ))}
          </nav>

          {/* Content is our own markdown, rendered server-side by app/docs/render.ts. */}
          <div className="docs-prose faq-prose" dangerouslySetInnerHTML={{ __html: doc.bodyHtml }} />
        </main>
      </div>

      <SiteFooter />
    </>
  );
}

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { SiteFooter } from "@shared/site/SiteFooter";
import { MobileNav } from "@shared/site/MobileNav";
import { DOCS_NAV, DOCS_PAGES, docsNeighbors, pageBySlug, type DocsPage } from "../nav";
import { renderDoc } from "../render";

export const dynamic = "force-static";
export const dynamicParams = false;

type Params = { slug?: string[] };

function slugParam(slug: string[] | undefined): string {
  return (slug ?? []).join("/");
}

export function generateStaticParams() {
  return DOCS_PAGES.map((p) => ({ slug: p.slug === "" ? [] : p.slug.split("/") }));
}

function docsRoot(): string {
  // process.cwd() is the `web/` package directory in both `next dev` and `next build`.
  return path.join(process.cwd(), "docs");
}

function readDoc(page: DocsPage) {
  const markdown = readFileSync(path.join(docsRoot(), page.file), "utf8");
  return renderDoc(markdown);
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const page = pageBySlug(slugParam((await params).slug));
  if (!page) return { title: "Not found" };
  const doc = readDoc(page);
  return {
    title: page.title,
    description: doc.description || "Shapes developer documentation.",
  };
}

export default async function DocsPage({ params }: { params: Promise<Params> }) {
  const slug = slugParam((await params).slug);
  const page = pageBySlug(slug);
  if (!page) notFound();

  const doc = readDoc(page);
  const { prev, next } = docsNeighbors(slug);

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="site-nav-link">SHAPES</Link>
          <nav className="site-nav">
            <Link href="/mint" className="site-nav-link" style={{ color: "var(--muted)" }}>MINT</Link>
            <Link href="/gallery" className="site-nav-link" style={{ color: "var(--muted)" }}>GALLERY</Link>
          </nav>
          <MobileNav
            items={[
              { label: "MINT", href: "/mint" },
              { label: "GALLERY", href: "/gallery" },
            ]}
          />
        </div>
      </header>

      <div className="docs-layout">
        <details className="docs-nav-mobile">
          <summary>Docs menu</summary>
          <DocsSidebar currentSlug={slug} />
        </details>

        <aside className="docs-sidebar">
          <DocsSidebar currentSlug={slug} />
        </aside>

        <main className="docs-main">
          <h1>{doc.title || page.title}</h1>
          {/* Content is our own markdown, rendered server-side by app/docs/render.ts. */}
          <div className="docs-prose" dangerouslySetInnerHTML={{ __html: doc.bodyHtml }} />

          <nav className="docs-prevnext" aria-label="Docs pagination">
            {prev ? (
              <Link href={prev.slug === "" ? "/docs" : `/docs/${prev.slug}`} className="docs-prev">
                ← Previous: {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={`/docs/${next.slug}`} className="docs-next">
                Next: {next.title} →
              </Link>
            )}
          </nav>
        </main>

        <aside className="docs-toc">
          {doc.toc.length > 0 && (
            <>
              <div className="docs-toc-label">On this page</div>
              <ul>
                {doc.toc.map((entry) => (
                  <li key={entry.id}>
                    <a href={`#${entry.id}`}>{entry.text}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>

      <SiteFooter />
    </>
  );
}

function DocsSidebar({ currentSlug }: { currentSlug: string }) {
  return (
    <nav aria-label="Docs sections">
      {DOCS_NAV.map((section) => (
        <div className="docs-nav-section" key={section.title}>
          <div className="docs-nav-label">{section.title}</div>
          <ul>
            {section.pages.map((p) => {
              const href = p.slug === "" ? "/docs" : `/docs/${p.slug}`;
              const current = p.slug === currentSlug;
              return (
                <li key={p.slug}>
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    className={current ? "docs-nav-current" : undefined}
                  >
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

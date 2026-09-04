import Link from "next/link";

/** Header for the routes that read no chain state (/docs, /faq): wordmark plus links into the
 *  app. The app's own header (preview/src/site/SiteHeader.tsx) carries the connect control and a
 *  view nav, both of which need the wallet stack these routes skip. Docs and FAQ links live in
 *  SiteFooter, so they are not repeated here. */
export function ChainFreeHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="site-nav-link">SHAPES</Link>
        <nav className="site-nav" style={{ display: "flex", gap: "clamp(20px, 4vw, 40px)" }}>
          <Link href="/mint" className="site-nav-link" style={{ color: "var(--muted)" }}>MINT</Link>
          <Link href="/gallery" className="site-nav-link" style={{ color: "var(--muted)" }}>GALLERY</Link>
        </nav>
      </div>
    </header>
  );
}

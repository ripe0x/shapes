// Table of contents for the /docs section. Each page's markdown source lives at
// `web/docs/<file>`; slug "" (file index.md) is the /docs index.

export interface DocsPage {
  slug: string;
  title: string;
  file: string;
}

export interface DocsSection {
  title: string;
  pages: DocsPage[];
}

export const DOCS_NAV: DocsSection[] = [
  {
    title: "Start",
    pages: [
      { slug: "", title: "Overview", file: "index.md" },
      { slug: "quickstart", title: "Quickstart", file: "quickstart.md" },
      { slug: "deployments", title: "Deployments", file: "deployments.md" },
    ],
  },
  {
    title: "Concepts",
    pages: [
      { slug: "concepts", title: "Core concepts", file: "concepts.md" },
      { slug: "trust-model", title: "Trust model", file: "trust-model.md" },
    ],
  },
  {
    title: "Operations",
    pages: [
      { slug: "minting", title: "Minting", file: "minting.md" },
      { slug: "redeeming", title: "Redeeming", file: "redeeming.md" },
      { slug: "composing", title: "Composing", file: "composing.md" },
      { slug: "decomposing", title: "Decomposing", file: "decomposing.md" },
      { slug: "splitting", title: "Splitting", file: "splitting.md" },
      { slug: "black-shapes", title: "Black Shapes", file: "black-shapes.md" },
    ],
  },
  {
    title: "Reading",
    pages: [
      { slug: "reading-state", title: "Reading state", file: "reading-state.md" },
      { slug: "geometry", title: "Geometry and rendering", file: "geometry.md" },
      { slug: "events", title: "Events", file: "events.md" },
      { slug: "errors", title: "Errors", file: "errors.md" },
    ],
  },
  {
    title: "Integrating",
    pages: [
      { slug: "integrating", title: "Building on Shapes", file: "integrating.md" },
      { slug: "interfaces", title: "Interfaces", file: "interfaces.md" },
      { slug: "indexer", title: "Indexer", file: "indexer.md" },
    ],
  },
];

/** Every page in nav order, flattened across sections. */
export const DOCS_PAGES: DocsPage[] = DOCS_NAV.flatMap((section) => section.pages);

export function pageBySlug(slug: string): DocsPage | undefined {
  return DOCS_PAGES.find((p) => p.slug === slug);
}

/** The page immediately before/after the given slug in nav order, or null at either end. */
export function docsNeighbors(slug: string): { prev: DocsPage | null; next: DocsPage | null } {
  const i = DOCS_PAGES.findIndex((p) => p.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return { prev: DOCS_PAGES[i - 1] ?? null, next: DOCS_PAGES[i + 1] ?? null };
}

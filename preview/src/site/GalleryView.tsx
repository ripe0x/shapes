import React from "react";
import {DENOMINATIONS} from "../chain/abi";
import {C} from "./theme";
import {Section, Art} from "./ui";
import type {SiteData, SiteToken} from "./data";
import {compactShapeTitle} from "./shapeTitle";
import {filterOwnedTokens} from "./MyShapesView";

export const BLACK_FILTER = -2;

/** Delay step between consecutive gallery cards in the reveal cascade, and the index cap it
 *  wraps at so a long grid's last row does not wait on its position. */
export const GALLERY_CASCADE_STEP_MS = 26;
export const GALLERY_CASCADE_CAP = 24;

/** Kept pure so the gallery's Black-Shape visibility is regression-testable without a DOM. */
export function filterGalleryTokens<T extends {di: number}>(tokens: T[], filter: number): T[] {
  if (filter === BLACK_FILTER) return tokens.filter((token) => token.di < 0);
  return filter < 0 ? tokens : tokens.filter((token) => token.di === filter);
}

/** Composes the denomination filter with the "My Shapes" owner filter, applied after it. Pure so
 *  the composition is regression-testable without a DOM. */
export function filterGallery<T extends {di: number; owner: string}>(
  tokens: T[],
  filter: number,
  ownerOnly: boolean,
  address: string | undefined,
): T[] {
  const byDenom = filterGalleryTokens(tokens, filter);
  return ownerOnly && address ? filterOwnedTokens(byDenom, address) : byDenom;
}

/** Gallery caption for a token's mint-origin count: "1 origin", "6 origins", or "10,000 origins,
 *  Complete" when every backing unit carries its own origin (the "Complete" trait). Pure. */
export function originsLabel(t: Pick<SiteToken, "originCount" | "meta">): string {
  const n = t.originCount;
  const complete = t.meta.attributes.some((a) => a.trait_type === "Complete" && a.value === "true");
  const base = `${n.toLocaleString("en-US")} origin${n === 1 ? "" : "s"}`;
  return complete ? `${base}, Complete` : base;
}

export function GalleryView({
  data,
  filter,
  setFilter,
  address,
  ownerOnly,
  setOwnerOnly,
  onOpenToken,
}: {
  data: SiteData | null;
  filter: number; // -1 = all, -2 = Black, else denomination index
  setFilter: (i: number) => void;
  /** Connected wallet address, if any; gates the "My Shapes" chip. */
  address: `0x${string}` | undefined;
  ownerOnly: boolean;
  setOwnerOnly: (v: boolean) => void;
  onOpenToken: (id: bigint) => void;
}) {
  const tokens = data?.tokens ?? [];
  const filtered = filterGallery(tokens, filter, ownerOnly, address);
  const chips = [
    {label: "All", i: -1},
    ...DENOMINATIONS.map((d, i) => ({label: d.label, i})),
    {label: "Black", i: BLACK_FILTER},
  ];

  return (
    <main>
      <Section title="GALLERY">
        <div style={{fontSize: 15}}>
          {data ? `${filtered.length} Shape${filtered.length === 1 ? "" : "s"}, newest first.` : "Reading the chain…"}
        </div>
        <div style={{marginTop: 20, display: "flex", flexWrap: "wrap", gap: 8}}>
          {chips.map((f) => {
            const on = filter === f.i;
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => setFilter(f.i)}
                style={{
                  border: `1px solid ${on ? C.ink : C.border}`,
                  background: on ? C.ink : "transparent",
                  color: on ? C.page : C.bodyDim,
                  padding: "5px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            );
          })}
          {address && (
            <button
              type="button"
              aria-pressed={ownerOnly}
              onClick={() => setOwnerOnly(!ownerOnly)}
              style={{
                border: `1px solid ${ownerOnly ? C.ink : C.border}`,
                background: ownerOnly ? C.ink : "transparent",
                color: ownerOnly ? C.page : C.bodyDim,
                padding: "5px 12px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              My Shapes
            </button>
          )}
        </div>
      </Section>

      <ShapeGrid tokens={filtered} ownerTokenId={data?.ownerToken ?? null} onOpenToken={onOpenToken} />
    </main>
  );
}

export function ShapeGrid({
  tokens,
  ownerTokenId,
  onOpenToken,
}: {
  tokens: SiteToken[];
  ownerTokenId: bigint | null;
  onOpenToken: (id: bigint) => void;
}) {
  // Cascade runs once per mount: armed before paint (useLayoutEffect, so there is no flash of the
  // plain grid on this above-the-fold view), then revealed once the grid enters the viewport. A
  // card that mounts afterward (a filter change, an owner-only toggle, a live refresh) is a fresh
  // DOM node and matches the same `.is-revealed .gallery-card` rule on its own first paint; a card
  // that stays mounted across such a change is not remounted and does not replay.
  const gridRef = React.useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = React.useState(false);
  React.useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || revealed || typeof IntersectionObserver === "undefined") return;
    grid.classList.add("is-armed");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      {rootMargin: "0px 0px -10% 0px"},
    );
    observer.observe(grid);
    return () => observer.disconnect();
  }, [revealed, tokens.length > 0]);

  return (
    <div ref={gridRef} className={`shape-token-grid gallery-grid${revealed ? " is-revealed" : ""}`}>
      {tokens.map((t, index) => (
        <button
          key={t.id.toString()}
          type="button"
          className="btn-ghost gallery-card"
          onClick={() => onOpenToken(t.id)}
          style={{
            display: "block",
            textAlign: "left",
            animationDelay: `${(index % GALLERY_CASCADE_CAP) * GALLERY_CASCADE_STEP_MS}ms`,
          }}
        >
          <Art src={t.image} alt={`Shape ${t.id}`} />
          <div
            className="gallery-card-meta"
            style={{
              marginTop: 11,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 11,
              color: C.muted,
            }}
          >
            <span>{compactShapeTitle(t.id, t.id === ownerTokenId)}</span>
            <span>{t.di >= 0 ? `${DENOMINATIONS[t.di].label} ETH` : "Black"}</span>
          </div>
          <div className="gallery-card-origins" style={{marginTop: 4, fontSize: 11, color: C.muted}}>
            {originsLabel(t)}
          </div>
        </button>
      ))}
    </div>
  );
}

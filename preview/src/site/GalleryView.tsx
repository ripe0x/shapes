import {DENOMINATIONS} from "../chain/abi";
import {C} from "./theme";
import {Section, Art} from "./ui";
import type {SiteData, SiteToken} from "./data";
import {compactShapeTitle} from "./shapeTitle";

export const BLACK_FILTER = -2;

/** Kept pure so the gallery's Black-Shape visibility is regression-testable without a DOM. */
export function filterGalleryTokens<T extends {di: number}>(tokens: T[], filter: number): T[] {
  if (filter === BLACK_FILTER) return tokens.filter((token) => token.di < 0);
  return filter < 0 ? tokens : tokens.filter((token) => token.di === filter);
}

export function GalleryView({
  data,
  filter,
  setFilter,
  onOpenToken,
}: {
  data: SiteData | null;
  filter: number; // -1 = all, -2 = Black, else denomination index
  setFilter: (i: number) => void;
  onOpenToken: (id: bigint) => void;
}) {
  const tokens = data?.tokens ?? [];
  const filtered = filterGalleryTokens(tokens, filter);
  const chips = [
    {label: "All", i: -1},
    ...DENOMINATIONS.map((d, i) => ({label: d.label, i})),
    {label: "Black", i: BLACK_FILTER},
  ];

  return (
    <main>
      <Section title="GALLERY">
        <div style={{fontSize: 15}}>
          {data ? `${filtered.length} Shapes, newest first.` : "Reading the chain…"}
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
        </div>
      </Section>

      <ShapeGrid tokens={filtered} onOpenToken={onOpenToken} />
    </main>
  );
}

export function ShapeGrid({
  tokens,
  onOpenToken,
}: {
  tokens: SiteToken[];
  onOpenToken: (id: bigint) => void;
}) {
  return (
    <div className="shape-token-grid">
      {tokens.map((t) => (
        <button
          key={t.id.toString()}
          type="button"
          className="btn-ghost"
          onClick={() => onOpenToken(t.id)}
          style={{display: "block", textAlign: "left"}}
        >
          <Art src={t.image} alt={`Shape ${t.id}`} />
          <div
            style={{
              marginTop: 11,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 11,
              color: C.muted,
            }}
          >
            <span>{compactShapeTitle(t.id)}</span>
            <span>{t.di >= 0 ? `${DENOMINATIONS[t.di].label} ETH` : "Black"}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

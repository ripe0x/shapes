import {DENOMINATIONS} from "../chain/abi";
import {C} from "./theme";
import {Section, Art} from "./ui";
import type {SiteData} from "./data";

export function GalleryView({
  data,
  filter,
  setFilter,
  onOpenToken,
}: {
  data: SiteData | null;
  filter: number; // -1 = all, else denomination index
  setFilter: (i: number) => void;
  onOpenToken: (id: bigint) => void;
}) {
  const tokens = data?.tokens ?? [];
  const filtered = filter < 0 ? tokens : tokens.filter((t) => t.di === filter);
  const chips = [{label: "All", i: -1}, ...DENOMINATIONS.map((d, i) => ({label: d.label, i}))];

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

      <div style={{padding: 48, display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "36px 28px"}}>
        {filtered.map((t) => (
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
              <span>#{t.id.toString()}</span>
              <span>{t.di >= 0 ? `${DENOMINATIONS[t.di].label} ETH` : ""}</span>
            </div>
          </button>
        ))}
      </div>
    </main>
  );
}

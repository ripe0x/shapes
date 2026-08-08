import { C, Label, Slider, Toggle, Button, mono } from "./ui";
import { CANONICAL_NUM, diffFromCanonical, toParams, type NumParams } from "./paramState";
import { worstCaseRatio } from "./containment";

export function Controls({
  n,
  set,
}: {
  n: NumParams;
  set: (patch: Partial<NumParams>) => void;
}) {
  const diffs = diffFromCanonical(n);
  const dirty = diffs.length > 0;

  // Containment is scale-free and exact, so one number covers every denomination at once.
  const worst = worstCaseRatio(toParams(n));
  const contained = worst <= 1;


  return (
    <div
      style={{
        border: `1px solid ${dirty ? C.warn : C.hair}`,
        borderRadius: 5,
        padding: 18,
        background: "#fff",
        marginBottom: 40,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 14,
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            ...mono,
            fontSize: 11,
            letterSpacing: "0.1em",
            color: dirty ? C.warn : C.ok,
            fontWeight: 600,
          }}
        >
          {dirty
            ? `PREVIEW OVERRIDE — ${diffs.length} parameter${diffs.length > 1 ? "s" : ""} differ from the committed renderer`
            : "COMMITTED VALUES — identical to src/ShapeRenderer.sol"}
        </div>
        <Button onClick={() => set(CANONICAL_NUM)} disabled={!dirty}>
          reset to committed
        </Button>
      </div>

      <div
        style={{
          ...mono,
          fontSize: 11,
          lineHeight: 1.6,
          marginBottom: 16,
          padding: "9px 12px",
          borderRadius: 4,
          background: contained ? "rgba(29,107,63,0.07)" : "rgba(168,48,15,0.09)",
          border: `1px solid ${contained ? "rgba(29,107,63,0.3)" : C.warn}`,
          color: contained ? C.ok : C.warn,
        }}
      >
        {contained ? (
          <>
            Every mark paints to exactly{" "}
            <strong>{(worst * 100).toFixed(0)}%</strong> of its half-cell of its half-cell —
            the same bound for every primitive at every denomination, solid or outlined, stroke
            and miter joins included.{" "}
            <span style={{ color: C.dim }}>
              Nothing can overflow: each footprint is solved backwards from that target rather
              than measured after the fact. 100% is edge to edge.
            </span>
          </>
        ) : (
          <>
            <strong>CELL FILL ABOVE 100%</strong> — marks would cross their cell boundary and
            collide with neighbours. Bring cell fill back to 1.00 or below.
          </>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          gap: "18px 28px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Label>size</Label>
          <Slider
            label="cell fill"
            value={n.fill}
            canonical={CANONICAL_NUM.fill}
            min={0.4}
            max={1}
            step={0.005}
            onChange={(v) => set({ fill: v })}
          />
          <div style={{ ...mono, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>
            a collection constant, not a per-card draw — every Shape reaches the same
            proportion of its cell, at every denomination. 1.00 is edge to edge.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Label>stroke</Label>
          <Slider
            label="wRatio"
            value={n.wRatio}
            canonical={CANONICAL_NUM.wRatio}
            min={0.01}
            max={0.4}
            step={0.005}
            onChange={(v) => set({ wRatio: v })}
          />
          <div style={{ ...mono, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>
            also a collection constant. Every outlined mark in the collection carries the same
            stroke in proportion to its cell, so weight never varies except with the grid.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Label>fill, drawn per card</Label>
          <Slider
            label="all-outline cards"
            value={n.pureOutlineChance}
            canonical={CANONICAL_NUM.pureOutlineChance}
            min={0}
            max={0.3}
            step={0.005}
            onChange={(v) => set({ pureOutlineChance: v })}
          />
          <Slider
            label="all-solid cards"
            value={n.pureSolidChance}
            canonical={CANONICAL_NUM.pureSolidChance}
            min={0}
            max={0.3}
            step={0.005}
            onChange={(v) => set({ pureSolidChance: v })}
          />
          <Slider
            label="band min"
            value={n.solidBandMin}
            canonical={CANONICAL_NUM.solidBandMin}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set({ solidBandMin: Math.min(v, n.solidBandMax) })}
          />
          <Slider
            label="band max"
            value={n.solidBandMax}
            canonical={CANONICAL_NUM.solidBandMax}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set({ solidBandMax: Math.max(v, n.solidBandMin) })}
          />
          <div style={{ ...mono, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>
            {(n.pureOutlineChance * 100).toFixed(1)}% of cards entirely outlined,{" "}
            {(n.pureSolidChance * 100).toFixed(1)}% entirely solid, the rest drawn from{" "}
            {n.solidBandMin.toFixed(2)}–{n.solidBandMax.toFixed(2)} — averaging{" "}
            {(
              (n.pureSolidChance +
                (1 - n.pureOutlineChance - n.pureSolidChance) *
                  ((n.solidBandMin + n.solidBandMax) / 2)) *
              100
            ).toFixed(0)}
            % solid modules overall
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Label>form</Label>
          <Slider
            label="triangle height"
            value={n.triHeight}
            canonical={CANONICAL_NUM.triHeight}
            min={0.5}
            max={1.2}
            step={0.001}
            onChange={(v) => set({ triHeight: v })}
          />
          <Toggle
            label="card type (preview only — not in the contract)"
            checked={n.showText}
            canonical={CANONICAL_NUM.showText}
            onChange={(v) => set({ showText: v, fieldCy: v ? 169 : 175 })}
          />
          <Slider
            label="field centre y"
            value={n.fieldCy}
            canonical={CANONICAL_NUM.fieldCy}
            min={150}
            max={200}
            step={1}
            onChange={(v) => set({ fieldCy: v })}
          />
          <Toggle
            label="half circle"
            checked={n.useHalf}
            canonical={CANONICAL_NUM.useHalf}
            onChange={(v) => set({ useHalf: v })}
          />
          <Toggle
            label="quarter circle"
            checked={n.useQuarter}
            canonical={CANONICAL_NUM.useQuarter}
            onChange={(v) => set({ useQuarter: v })}
          />
          <Toggle
            label="diamond"
            checked={n.useDiamond}
            canonical={CANONICAL_NUM.useDiamond}
            onChange={(v) => set({ useDiamond: v })}
          />
          <div style={{ ...mono, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>
            six primitives, each solid or outlined; triangle, half circle and quarter circle
            also take one of four rotations — 30 distinct module appearances
          </div>
        </div>
      </div>

      {dirty && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: `1px solid ${C.hair}`,
            ...mono,
            fontSize: 10.5,
            color: C.mid,
            lineHeight: 1.7,
          }}
        >
          <span style={{ color: C.warn }}>overridden: </span>
          {diffs.map((d, i) => (
            <span key={d.key}>
              {i > 0 && "   "}
              {d.key} {d.current}{" "}
              <span style={{ color: C.dim }}>(committed {d.committed})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

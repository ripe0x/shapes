import React from "react";
import { Card, C, Section, Button, NumberField, mono } from "./ui";
import { composeShape, renderShape } from "../canonical/render";
import { fmt } from "../canonical/wad";
import { DENOMINATIONS, GRIDS, LABELS } from "../canonical/denominations";
import type { Params } from "../canonical/params";
import { designPageSeeds, seedAt, type SeedMode } from "../seeds";
import { analyseBatch, buildBatch, type CollisionPair } from "../analysis";
import { withGridOverlay } from "./gridOverlay";
import { mintGene } from "../previewGene";
import type { Selection } from "./App";

export function Ladder({
  params,
  seedMode,
  seedStart,
  perRow,
  onSelect,
  setSeedStart,
  setPerRow,
  setSeedMode,
  showGrid,
  badgeOf,
}: {
  params: Params;
  seedMode: SeedMode;
  seedStart: bigint;
  perRow: number;
  onSelect: (s: Selection) => void;
  setSeedStart: (v: bigint) => void;
  setPerRow: (v: number) => void;
  setSeedMode: (m: SeedMode) => void;
  showGrid: boolean;
  badgeOf: (s: Selection) => number | null;
}) {
  const [designSeeds, setDesignSeeds] = React.useState(false);

  return (
    <>
      <Section
        title="LADDER"
        note="nine denominations · value sets the grammar, seed writes the sentence"
        right={
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <NumberField
              label="seed start"
              value={Number(seedStart)}
              min={0}
              step={1}
              onChange={(v) => setSeedStart(BigInt(Math.max(0, Math.floor(v))))}
            />
            <NumberField
              label="seeds / row"
              value={perRow}
              min={1}
              max={24}
              step={1}
              onChange={(v) => setPerRow(Math.min(24, Math.max(1, Math.floor(v))))}
              width={80}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                active={seedMode === "production" && !designSeeds}
                onClick={() => {
                  setDesignSeeds(false);
                  setSeedMode("production");
                }}
                title="keccak256(index) — matches how the contract derives seeds"
              >
                production seeds
              </Button>
              <Button
                active={designSeeds}
                onClick={() => setDesignSeeds(true)}
                title="the exact six seeds each band shows on the Claude Design page"
              >
                design page seeds
              </Button>
            </div>
          </div>
        }
      >
        <div
          style={{
            ...mono,
            fontSize: 10.5,
            color: C.mid,
            lineHeight: 1.6,
            marginBottom: 26,
            maxWidth: "72em",
          }}
        >
          {designSeeds
            ? "Showing the design page's own seeds, so this row can be compared against the reference directly."
            : "Seeds are keccak256(bytes32(index)), matching the contract. Consecutive raw integers would slide a window along one shared PRNG stream rather than sample the space — see SPEC.md D3d."}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {DENOMINATIONS.map((amount, di) => {
            const [cols, rows] = GRIDS[di];
            const seeds = designSeeds
              ? designPageSeeds(di).slice(0, perRow)
              : Array.from({ length: perRow }, (_, i) =>
                  seedAt(seedStart + BigInt(i), seedMode),
                );
            const cellSize = fmt(
              composeShape(seeds[0], amount, mintGene(seeds[0], amount), params).cell,
            );
            return (
              <div key={di} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 14,
                    borderTop: `1px solid ${C.line}`,
                    paddingTop: 10,
                  }}
                >
                  <span style={{ fontSize: 14, letterSpacing: "0.12em", fontWeight: 500 }}>
                    {LABELS[di]} ETH
                  </span>
                  <span style={{ ...mono, fontSize: 10.5, color: C.dim, letterSpacing: "0.06em" }}>
                    {cols}×{rows} · {cols * rows}{" "}
                    {cols * rows === 1 ? "module" : "modules"} · {cellSize}pt cell
                  </span>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${perRow}, 1fr)`,
                    gap: 16,
                  }}
                >
                  {seeds.map((seed, i) => {
                    const tokenId = BigInt(di * 1000 + i + 1);
                    return (
                      <Card
                        key={i}
                        svg={
                          showGrid
                            ? withGridOverlay(
                                renderShape(seed, amount, tokenId, mintGene(seed, amount), params),
                                seed,
                                amount,
                                params,
                              )
                            : renderShape(seed, amount, tokenId, mintGene(seed, amount), params)
                        }
                        caption={"#" + tokenId.toString()}
                        badge={badgeOf({ seed, amountWei: amount, tokenId })}
                        onClick={() => onSelect({ seed, amountWei: amount, tokenId })}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Sweep params={params} seedMode={seedMode} onSelect={onSelect} showGrid={showGrid} />
    </>
  );
}

/* ------------------------------------------------------------------ */

interface SweepRow {
  di: number;
  distinct: number;
  collisions: number;
  pairs: CollisionPair[];
  kind: Record<string, number>;
  solidPct: number;
  rot: Record<number, number>;
  rotTotal: number;
  moduleTotal: number;
}

function Sweep({
  params,
  seedMode,
  onSelect,
  showGrid,
}: {
  params: Params;
  seedMode: SeedMode;
  onSelect: (s: Selection) => void;
  showGrid: boolean;
}) {
  const [n, setN] = React.useState(500);
  const [rows, setRows] = React.useState<SweepRow[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const out: SweepRow[] = [];
      for (let di = 0; di < DENOMINATIONS.length; di++) {
        const amount = DENOMINATIONS[di];
        const cards = buildBatch(amount, 1n, n, params, seedMode);
        const st = analyseBatch(cards, amount, params);
        const rotatable = st.kindCounts.triangle + st.kindCounts.half;
        out.push({
          di,
          distinct: st.distinct,
          collisions: st.collisionPairs.reduce((a, p) => a + p.members.length - 1, 0),
          pairs: st.collisionPairs,
          kind: st.kindCounts as unknown as Record<string, number>,
          solidPct: (st.solid / st.moduleTotal) * 100,
          rot: {
            0: st.rotationCounts[0] - (st.moduleTotal - rotatable),
            90: st.rotationCounts[90],
            180: st.rotationCounts[180],
            270: st.rotationCounts[270],
          },
          rotTotal: rotatable,
          moduleTotal: st.moduleTotal,
        });
      }
      setRows(out);
      setBusy(false);
    }, 20);
  };

  const totalCollisions = rows?.reduce((a, r) => a + r.collisions, 0) ?? 0;

  return (
    <Section
      title="COLLISION SWEEP"
      note="exact geometry equality, token number excluded"
      right={
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
          <NumberField
            label="samples / band"
            value={n}
            min={10}
            max={5000}
            step={10}
            onChange={(v) => setN(Math.min(5000, Math.max(10, Math.floor(v))))}
          />
          <Button onClick={run} disabled={busy}>
            {busy ? "running…" : `run sweep (${n * 9} cards)`}
          </Button>
        </div>
      }
    >
      {!rows && (
        <div style={{ ...mono, fontSize: 11, color: C.dim }}>
          Not run yet. The design is not frozen until this passes at 500 samples
          for every denomination.
        </div>
      )}
      {rows && (
        <>
          <div
            style={{
              ...mono,
              fontSize: 12,
              marginBottom: 16,
              color: totalCollisions === 0 ? C.ok : C.warn,
              fontWeight: 600,
            }}
          >
            {totalCollisions === 0
              ? `PASS — 0 exact geometry collisions across ${n * 9} cards`
              : `${totalCollisions} EXACT COLLISION(S) across ${n * 9} cards — inspect below, do not silently retune`}
          </div>
          <table style={{ ...mono, fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: "right" }}>
                <th style={{ textAlign: "left", padding: "6px 10px" }}>band</th>
                <th style={{ textAlign: "left", padding: "6px 10px" }}>grid</th>
                <th style={{ padding: "6px 10px" }}>distinct</th>
                <th style={{ padding: "6px 10px" }}>collisions</th>
                <th style={{ padding: "6px 10px" }}>solid</th>
                <th style={{ padding: "6px 10px" }}>circle</th>
                <th style={{ padding: "6px 10px" }}>square</th>
                <th style={{ padding: "6px 10px" }}>tri</th>
                <th style={{ padding: "6px 10px" }}>half</th>
                <th style={{ padding: "6px 10px" }}>rot 0/90/180/270</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = (v: number) => ((v / r.moduleTotal) * 100).toFixed(1);
                const rp = (v: number) =>
                  r.rotTotal ? ((v / r.rotTotal) * 100).toFixed(0) : "—";
                return (
                  <tr key={r.di} style={{ borderTop: `1px solid ${C.hair}`, textAlign: "right" }}>
                    <td style={{ textAlign: "left", padding: "6px 10px" }}>
                      {LABELS[r.di]} ETH
                    </td>
                    <td style={{ textAlign: "left", padding: "6px 10px", color: C.dim }}>
                      {GRIDS[r.di][0]}×{GRIDS[r.di][1]}
                    </td>
                    <td style={{ padding: "6px 10px" }}>{r.distinct}</td>
                    <td
                      style={{
                        padding: "6px 10px",
                        color: r.collisions ? C.warn : C.ok,
                        fontWeight: r.collisions ? 700 : 400,
                      }}
                    >
                      {r.collisions}
                    </td>
                    <td style={{ padding: "6px 10px" }}>{r.solidPct.toFixed(1)}%</td>
                    <td style={{ padding: "6px 10px" }}>{pct(r.kind.circle)}%</td>
                    <td style={{ padding: "6px 10px" }}>{pct(r.kind.square)}%</td>
                    <td style={{ padding: "6px 10px" }}>{pct(r.kind.triangle)}%</td>
                    <td style={{ padding: "6px 10px" }}>{pct(r.kind.half)}%</td>
                    <td style={{ padding: "6px 10px", color: C.dim }}>
                      {rp(r.rot[0])}/{rp(r.rot[90])}/{rp(r.rot[180])}/{rp(r.rot[270])}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {rows.some((r) => r.pairs.length > 0) && (
            <div style={{ marginTop: 22 }}>
              <div
                style={{ ...mono, fontSize: 11, color: C.warn, marginBottom: 10, fontWeight: 600 }}
              >
                COLLIDING GROUPS — click a card to inspect
              </div>
              {rows.flatMap((r) =>
                r.pairs.map((p) => (
                  <div key={r.di + p.hash} style={{ marginBottom: 18 }}>
                    <div style={{ ...mono, fontSize: 10.5, color: C.mid, marginBottom: 6 }}>
                      {LABELS[r.di]} ETH · geometry {p.hash} · seeds{" "}
                      {p.members.map((m) => m.toString()).join(", ")}
                    </div>
                    <div style={{ display: "flex", gap: 12 }}>
                      {p.members.slice(0, 6).map((seed, i) => (
                        <Card
                          key={i}
                          width={130}
                          svg={
                            showGrid
                              ? withGridOverlay(
                                  renderShape(
                                    seed,
                                    DENOMINATIONS[r.di],
                                    BigInt(i + 1),
                                    mintGene(seed, DENOMINATIONS[r.di]),
                                    params,
                                  ),
                                  seed,
                                  DENOMINATIONS[r.di],
                                  params,
                                )
                              : renderShape(
                                  seed,
                                  DENOMINATIONS[r.di],
                                  BigInt(i + 1),
                                  mintGene(seed, DENOMINATIONS[r.di]),
                                  params,
                                )
                          }
                          caption={seed.toString().slice(0, 12)}
                          onClick={() =>
                            onSelect({
                              seed,
                              amountWei: DENOMINATIONS[r.di],
                              tokenId: BigInt(i + 1),
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )),
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

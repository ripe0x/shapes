import React from "react";
import { Card, C, Section, Button, NumberField, mono, Label } from "./ui";
import { renderShape } from "../canonical/render";
import { DENOMINATIONS, GRIDS, LABELS } from "../canonical/denominations";
import { KIND_ORDER, type Params } from "../canonical/params";
import type { SeedMode } from "../seeds";
import { analyseBatch, buildBatch } from "../analysis";
import {
  buildFixture,
  contactSheetPng,
  downloadBlob,
  downloadText,
  fixtureFilename,
  makeZip,
} from "./exporters";
import { withGridOverlay } from "./gridOverlay";
import type { Selection } from "./App";

const MAX = 500;

export function Batch({
  params,
  seedMode,
  onSelect,
  paramsAreCommitted,
  showGrid,
}: {
  params: Params;
  seedMode: SeedMode;
  onSelect: (s: Selection) => void;
  paramsAreCommitted: boolean;
  showGrid: boolean;
}) {
  const [di, setDi] = React.useState(3); // 1 ETH
  const [seedStart, setSeedStart] = React.useState(1n);
  const [count, setCount] = React.useState(60);
  const [busy, setBusy] = React.useState<string | null>(null);

  const amount = DENOMINATIONS[di];
  const cards = React.useMemo(
    () => buildBatch(amount, seedStart, count, params, seedMode),
    [amount, seedStart, count, params, seedMode],
  );
  const stats = React.useMemo(
    () => analyseBatch(cards, amount, params),
    [cards, amount, params],
  );

  const svgs = React.useMemo(
    () =>
      cards.map((c, i) =>
        renderShape(c.seed, amount, seedStart + BigInt(i), params),
      ),
    [cards, amount, seedStart, params],
  );

  // Overlay is display only: `svgs` stays canonical so exports are unaffected.
  const displaySvgs = React.useMemo(
    () =>
      showGrid
        ? svgs.map((s, i) => withGridOverlay(s, cards[i].seed, amount, params))
        : svgs,
    [svgs, cards, amount, params, showGrid],
  );

  const collisions = stats.collisionPairs.reduce(
    (a, p) => a + p.members.length - 1,
    0,
  );

  const exportSvgs = () => {
    downloadBlob(
      `shapes-${LABELS[di]}eth-${seedStart}-${count}.zip`,
      makeZip(
        cards.map((_c, i) => ({
          name: `shape-${LABELS[di].replace(".", "_")}eth-${(seedStart + BigInt(i)).toString()}.svg`,
          text: svgs[i],
        })),
      ),
    );
  };

  const exportSheet = async () => {
    setBusy("rendering contact sheet…");
    try {
      const cols = Math.min(10, Math.ceil(Math.sqrt(svgs.length)));
      const png = await contactSheetPng(svgs, cols, 250);
      downloadBlob(`shapes-contact-${LABELS[di]}eth-${seedStart}-${count}.png`, png);
    } finally {
      setBusy(null);
    }
  };

  const exportFixtures = () => {
    const fixtures = cards.map((c, i) =>
      buildFixture(c.seed, amount, seedStart + BigInt(i), params),
    );
    downloadText(
      `fixtures-${LABELS[di]}eth-${seedStart}-${count}.json`,
      JSON.stringify({ committedParams: paramsAreCommitted, fixtures }, null, 2),
      "application/json",
    );
  };

  return (
    <Section
      title="BATCH"
      note={`${LABELS[di]} ETH · ${GRIDS[di][0]}×${GRIDS[di][1]} · reproducible from the seed range`}
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
            label={`count (max ${MAX})`}
            value={count}
            min={1}
            max={MAX}
            step={1}
            onChange={(v) => setCount(Math.min(MAX, Math.max(1, Math.floor(v))))}
          />
        </div>
      }
    >
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
        {DENOMINATIONS.map((_, i) => (
          <Button key={i} active={i === di} onClick={() => setDi(i)}>
            {LABELS[i]} ETH
          </Button>
        ))}
      </div>

      {/* distribution readout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 20,
          padding: "16px 18px",
          border: `1px solid ${collisions ? C.warn : C.hair}`,
          borderRadius: 5,
          background: "#fff",
          marginBottom: 26,
        }}
      >
        <div>
          <Label>exact collisions</Label>
          <div
            style={{
              ...mono,
              fontSize: 20,
              color: collisions ? C.warn : C.ok,
              fontWeight: 600,
            }}
          >
            {collisions}
          </div>
          <div style={{ ...mono, fontSize: 10, color: C.dim, marginTop: 4 }}>
            {stats.distinct} distinct of {stats.count}
          </div>
        </div>
        <div>
          <Label>primitive frequency</Label>
          {KIND_ORDER.map((k) => (
            <div key={k} style={{ ...mono, fontSize: 11, color: C.mid }}>
              {k.padEnd(9)}{" "}
              {((stats.kindCounts[k] / stats.moduleTotal) * 100).toFixed(1)}%
            </div>
          ))}
        </div>
        <div>
          <Label>solid vs outline</Label>
          <div style={{ ...mono, fontSize: 11, color: C.mid }}>
            solid {((stats.solid / stats.moduleTotal) * 100).toFixed(1)}%
          </div>
          <div style={{ ...mono, fontSize: 11, color: C.mid }}>
            outline {((stats.outline / stats.moduleTotal) * 100).toFixed(1)}%
          </div>
          <div style={{ ...mono, fontSize: 10, color: C.dim, marginTop: 4 }}>
            {stats.pureSolidCards} all-solid ·{" "}
            {stats.pureOutlineCards} all-outline
          </div>
        </div>
        <div>
          <Label>rotation (tri + half)</Label>
          {(() => {
            const rotatable = stats.kindCounts.triangle + stats.kindCounts.half;
            const zero = stats.rotationCounts[0] - (stats.moduleTotal - rotatable);
            const vals: [number, number][] = [
              [0, zero],
              [90, stats.rotationCounts[90]],
              [180, stats.rotationCounts[180]],
              [270, stats.rotationCounts[270]],
            ];
            return vals.map(([deg, v]) => (
              <div key={deg} style={{ ...mono, fontSize: 11, color: C.mid }}>
                {String(deg).padStart(3)}° {rotatable ? ((v / rotatable) * 100).toFixed(1) : "0.0"}%
              </div>
            ));
          })()}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <Label>export</Label>
          <Button onClick={exportSvgs}>svg bundle (.zip)</Button>
          <Button onClick={exportSheet} disabled={busy !== null}>
            {busy ?? "contact sheet (.png)"}
          </Button>
          <Button onClick={exportFixtures}>fixture json</Button>
        </div>
      </div>

      {collisions > 0 && (
        <div
          style={{
            ...mono,
            fontSize: 11,
            color: C.warn,
            marginBottom: 18,
            lineHeight: 1.7,
          }}
        >
          {stats.collisionPairs.map((p) => (
            <div key={p.hash}>
              geometry {p.hash} shared by seeds{" "}
              {p.members.map((m) => m.toString().slice(0, 14)).join(", ")}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
          gap: 14,
        }}
      >
        {cards.map((c, i) => (
          <Card
            key={i}
            svg={displaySvgs[i]}
            caption={"#" + (seedStart + BigInt(i)).toString()}
            onClick={() =>
              onSelect({ seed: c.seed, amountWei: amount, tokenId: seedStart + BigInt(i) })
            }
          />
        ))}
      </div>

      <div style={{ ...mono, fontSize: 10, color: C.dim, marginTop: 14 }}>
        {fixtureFilename(buildFixture(cards[0].seed, amount, seedStart, params))} …
        and {count - 1} more in the bundle
      </div>
    </Section>
  );
}

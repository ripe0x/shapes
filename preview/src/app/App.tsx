import React from "react";
import { C, Button, mono } from "./ui";
import { Controls } from "./Controls";
import { Ladder } from "./Ladder";
import { Batch } from "./Batch";
import { Inspect } from "./Inspect";
import {
  CANONICAL_NUM,
  diffFromCanonical,
  mirrorIsExact,
  toParams,
  type NumParams,
} from "./paramState";
import type { SeedMode } from "../seeds";

export interface Selection {
  seed: bigint;
  amountWei: bigint;
  tokenId: bigint;
}

type View = "ladder" | "batch";

export function App() {
  const [view, setView] = React.useState<View>("ladder");
  const [n, setN] = React.useState<NumParams>(CANONICAL_NUM);
  const [seedMode, setSeedMode] = React.useState<SeedMode>("production");
  const [seedStart, setSeedStart] = React.useState(1n);
  const [perRow, setPerRow] = React.useState(6);
  const [sel, setSel] = React.useState<Selection | null>(null);
  const [showGrid, setShowGrid] = React.useState(false);

  const params = React.useMemo(() => toParams(n), [n]);
  const committed = diffFromCanonical(n).length === 0;
  const set = (patch: Partial<NumParams>) => setN((p) => ({ ...p, ...patch }));

  return (
    <div style={{ minHeight: "100vh", padding: "48px 40px 120px" }}>
      <div style={{ maxWidth: 1560, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 48,
            borderBottom: `1px solid ${C.line}`,
            paddingBottom: 18,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 42, letterSpacing: "0.22em", fontWeight: 500, lineHeight: 1 }}>
              SHAPES
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                maxWidth: 680,
                color: C.mid,
              }}
            >
              Generative preview harness for the canonical renderer. Everything
              on this page is produced by{" "}
              <code style={{ ...mono, fontSize: 12 }}>src/canonical/render.ts</code>
              , the exact-integer implementation that{" "}
              <code style={{ ...mono, fontSize: 12 }}>src/ShapeRenderer.sol</code>{" "}
              is ported from. No floating point, no Math.random.
            </div>
          </div>
          <div
            style={{
              ...mono,
              fontSize: 11,
              letterSpacing: "0.08em",
              color: C.dim,
              textAlign: "right",
              lineHeight: 1.7,
            }}
          >
            250 × 350 VIEWBOX
            <br />
            BLACK / WHITE
            <br />9 DENOMINATIONS · 25 → 1 MODULES
          </div>
        </header>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            paddingBottom: 34,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <Button active={view === "ladder"} onClick={() => setView("ladder")}>
              ladder
            </Button>
            <Button active={view === "batch"} onClick={() => setView("batch")}>
              batch
            </Button>
            <span style={{width: 14}} />
            <Button
              active={showGrid}
              onClick={() => setShowGrid((g) => !g)}
              title="Overlay the artwork field, the derived cell grid and the cell centres. Display only — never part of the rendered token."
            >
              grid overlay
            </Button>
          </div>
          <div
            style={{
              ...mono,
              fontSize: 10,
              letterSpacing: "0.1em",
              color: committed ? C.ok : C.warn,
            }}
          >
            {committed ? "RENDERING COMMITTED VALUES" : "RENDERING PREVIEW OVERRIDES"}
            {!mirrorIsExact() && (
              <span style={{ color: C.warn }}> · MIRROR MISMATCH — BUG</span>
            )}
          </div>
        </div>

        <Controls n={n} set={set} />

        {view === "ladder" ? (
          <Ladder
            params={params}
            seedMode={seedMode}
            setSeedMode={setSeedMode}
            seedStart={seedStart}
            setSeedStart={setSeedStart}
            perRow={perRow}
            setPerRow={setPerRow}
            onSelect={setSel}
            showGrid={showGrid}
          />
        ) : (
          <Batch
            params={params}
            seedMode={seedMode}
            onSelect={setSel}
            paramsAreCommitted={committed}
            showGrid={showGrid}
          />
        )}

        {sel && (
          <Inspect sel={sel} params={params} showGrid={showGrid} onClose={() => setSel(null)} />
        )}
      </div>
    </div>
  );
}

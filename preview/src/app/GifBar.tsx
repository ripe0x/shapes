import React from "react";
import { C, Button, NumberField, mono, forDisplay } from "./ui";
import { renderShape } from "../canonical/render";
import { LABELS } from "../canonical/denominations";
import { denominationIndex } from "../canonical/denominations";
import type { Params } from "../canonical/params";
import { buildGif } from "./gif";
import { downloadBlob } from "./exporters";
import { mintGene } from "../previewGene";
import type { Selection } from "./App";

const MAX_BYTES = 12 * 1024 * 1024;

function humanBytes(n: number) {
  return n < 1024 * 1024
    ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * The animation tray.
 *
 * Sits at the foot of the page whenever anything is selected, holding the frames in the order
 * they were picked. Frames are rendered from the current parameters, so an animation made
 * while overrides are active shows those overrides.
 */
export function GifBar({
  selection,
  params,
  remove,
  clear,
  reverse,
}: {
  selection: Selection[];
  params: Params;
  remove: (i: number) => void;
  clear: () => void;
  reverse: () => void;
}) {
  const [width, setWidth] = React.useState(700);
  const [levels, setLevels] = React.useState(32);
  const [delayMs, setDelayMs] = React.useState(250);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  if (selection.length === 0) return null;

  const exportGif = async () => {
    setResult(null);
    setBusy("rendering frames…");
    try {
      const svgs = selection.map((s) =>
        renderShape(s.seed, s.amountWei, s.tokenId, mintGene(s.seed, s.amountWei), params),
      );
      const out = await buildGif(svgs, {
        width,
        delayCs: Math.max(1, Math.round(delayMs / 10)),
        maxBytes: MAX_BYTES,
        levels,
        supersample: 2,
        onProgress: (done, total) => setBusy(`rendering frame ${done} of ${total}…`),
      });
      setBusy("encoding…");
      downloadBlob(
        `shapes-${out.frames}frames-${out.width}px.gif`,
        out.blob,
      );
      setResult(
        `${out.frames} frames · ${out.width}×${out.height} · ${levels} greys · ${humanBytes(out.bytes)}` +
          (out.scaledFrom
            ? ` · scaled down from ${out.scaledFrom}px to fit the 12 MB cap`
            : ""),
      );
    } catch (e) {
      setResult(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 40,
        marginTop: 40,
        background: "#fff",
        border: `1px solid ${C.ink}`,
        borderRadius: 6,
        padding: "14px 18px",
        boxShadow: "0 -6px 24px rgba(20,20,18,0.10)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div style={{ ...mono, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em" }}>
          ANIMATION · {selection.length} frame{selection.length === 1 ? "" : "s"}
        </div>
        <NumberField
          label="frame width px"
          value={width}
          min={100}
          max={1600}
          step={50}
          onChange={(v) => setWidth(Math.min(1600, Math.max(100, Math.round(v))))}
        />
        <NumberField
          label="greys"
          value={levels}
          min={2}
          max={256}
          step={2}
          onChange={(v) => setLevels(Math.min(256, Math.max(2, Math.round(v))))}
          width={70}
        />
        <NumberField
          label="delay ms"
          value={delayMs}
          min={20}
          max={2000}
          step={10}
          onChange={(v) => setDelayMs(Math.min(2000, Math.max(20, Math.round(v))))}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={exportGif} disabled={busy !== null} active>
            {busy ?? "export gif"}
          </Button>
          <Button onClick={reverse} disabled={busy !== null}>
            reverse
          </Button>
          <Button onClick={clear} disabled={busy !== null}>
            clear
          </Button>
        </div>
        <div style={{ ...mono, fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
          loops forever · max 12 MB, scaled down automatically if a selection exceeds it ·
          rendered at 2× and resampled, greys keep the edges smooth
        </div>
      </div>

      {result && (
        <div
          style={{
            ...mono,
            fontSize: 11,
            marginBottom: 10,
            color: result.startsWith("failed") ? C.warn : C.ok,
          }}
        >
          {result}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {selection.map((s, i) => {
          const di = denominationIndex(s.amountWei);
          return (
            <div key={i} style={{ flexShrink: 0, width: 56 }}>
              <div
                onClick={() => remove(i)}
                title={`frame ${i + 1} — click to remove`}
                style={{
                  aspectRatio: "2.5 / 3.5",
                  background: "#000",
                  borderRadius: 3,
                  overflow: "hidden",
                  cursor: "pointer",
                  lineHeight: 0,
                  position: "relative",
                }}
                dangerouslySetInnerHTML={{
                  __html: forDisplay(
                    renderShape(s.seed, s.amountWei, s.tokenId, mintGene(s.seed, s.amountWei), params),
                  ),
                }}
              />
              <div
                style={{
                  ...mono,
                  fontSize: 8,
                  color: C.dim,
                  textAlign: "center",
                  marginTop: 3,
                }}
              >
                {i + 1} · {LABELS[di]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

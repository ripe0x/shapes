import React from "react";
import { C, Button, mono, forDisplay } from "./ui";
import {
  composeShape,
  moduleGlyph,
  moduleSequence,
  renderShape,
  tokenMetadataJson,
  tokenURI,
} from "../canonical/render";
import { fmt } from "../canonical/wad";
import { LABELS } from "../canonical/denominations";
import type { Params } from "../canonical/params";
import { downloadText } from "./exporters";
import { shortHash } from "../analysis";
import { renderGeometry } from "../canonical/render";
import { withGridOverlay } from "./gridOverlay";
import { moduleExtent } from "./containment";
import { mintGene } from "../previewGene";
import type { Selection } from "./App";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "3px 0" }}>
      <span style={{ ...mono, fontSize: 10.5, color: C.dim, width: 116, flexShrink: 0 }}>
        {k}
      </span>
      <span style={{ ...mono, fontSize: 11, color: C.ink, wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

export function Inspect({
  sel,
  params,
  showGrid,
  onClose,
}: {
  sel: Selection;
  params: Params;
  showGrid: boolean;
  onClose: () => void;
}) {
  const { seed, amountWei, tokenId } = sel;
  const c = composeShape(seed, amountWei, mintGene(seed, amountWei), params);
  const svg = renderShape(seed, amountWei, tokenId, mintGene(seed, amountWei), params);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [overlay, setOverlay] = React.useState(showGrid);
  // The raw SVG shown and copied below is always canonical; the overlay is a display layer.
  const displaySvg = overlay ? withGridOverlay(svg, seed, amountWei, params) : svg;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      setCopied("clipboard blocked — use the download button");
      setTimeout(() => setCopied(null), 2400);
    }
  };

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,20,18,0.72)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 24px",
        overflow: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.bg,
          borderRadius: 6,
          padding: 28,
          maxWidth: 1080,
          width: "100%",
          display: "grid",
          gridTemplateColumns: "300px 1fr",
          gap: 32,
        }}
      >
        <div>
          <div
            style={{ background: "#000", borderRadius: 5, overflow: "hidden", lineHeight: 0 }}
            dangerouslySetInnerHTML={{ __html: forDisplay(displaySvg) }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Button active={overlay} onClick={() => setOverlay((o) => !o)}>
              grid overlay
            </Button>
            <Button onClick={() => copy("svg", svg)}>copy svg</Button>
            <Button
              onClick={() =>
                downloadText(`shape-${tokenId}.svg`, svg, "image/svg+xml")
              }
            >
              download
            </Button>
          </div>
        </div>

        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 18, letterSpacing: "0.1em", fontWeight: 500 }}>
              SHAPE #{tokenId.toString()}
            </div>
            <Button onClick={onClose}>close (esc)</Button>
          </div>

          <Row k="eth value" v={`${LABELS[c.denomIndex]} ETH`} />
          <Row k="amount (wei)" v={amountWei.toString()} />
          <Row k="token id" v={tokenId.toString()} />
          <Row k="seed" v={"0x" + seed.toString(16).padStart(64, "0")} />
          <Row k="stream seed" v={"0x" + (seed & 0xffffffffn).toString(16).padStart(8, "0")} />
          <Row k="grid" v={`${c.cols} × ${c.rows} — ${c.cols * c.rows} modules`} />
          <Row k="cell" v={fmt(c.cell)} />
          <Row k="cell fill" v={fmt(c.fill)} />
          <Row k="painted extent" v={`${fmt(c.target)} of ${fmt(c.cell / 2n)} half-cell`} />
          <Row k="wRatio" v={fmt(c.wRatio)} />
          <Row k="stroke" v={fmt(c.weight)} />
          <Row k="draws consumed" v={c.draws} />
          <Row
            k="geometry hash"
            v={shortHash(renderGeometry(seed, amountWei, mintGene(seed, amountWei), params))}
          />
          <Row
            k="modules"
            v={<span style={{ fontSize: 15, letterSpacing: "0.18em" }}>{moduleSequence(c)}</span>}
          />

          <div style={{ marginTop: 18 }}>
            <div style={{ ...mono, fontSize: 10, color: C.dim, marginBottom: 6 }}>
              MODULE SEQUENCE
            </div>
            <table style={{ ...mono, fontSize: 10.5, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: C.dim }}>
                  {["#", "glyph", "kind", "fill", "rot", "cx", "cy", "size", "extent"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "3px 10px 3px 0" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.modules.map((m) => (
                  <tr key={m.index} style={{ borderTop: `1px solid ${C.hair}` }}>
                    <td style={{ padding: "3px 10px 3px 0", color: C.dim }}>{m.index}</td>
                    <td style={{ padding: "3px 10px 3px 0", fontSize: 13 }}>{moduleGlyph(m)}</td>
                    <td style={{ padding: "3px 10px 3px 0" }}>{m.kind}</td>
                    <td style={{ padding: "3px 10px 3px 0" }}>
                      {m.solid ? "solid" : "outline"}
                    </td>
                    <td style={{ padding: "3px 10px 3px 0" }}>{m.rot}°</td>
                    <td style={{ padding: "3px 10px 3px 0" }}>{fmt(m.cx)}</td>
                    <td style={{ padding: "3px 10px 3px 0" }}>{fmt(m.cy)}</td>
                    <td style={{ padding: "3px 10px 3px 0" }}>{fmt(m.size)}</td>
                    <td style={{ padding: "3px 10px 3px 0" }}>
                      {(moduleExtent(m, c.cell, params).ratio * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 18 }}>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 6,
                flexWrap: "wrap",
              }}
            >
              <span style={{ ...mono, fontSize: 10, color: C.dim }}>RAW SVG</span>
              <Button onClick={() => copy("svg", svg)}>copy</Button>
              <Button
                onClick={() =>
                  copy(
                    "metadata",
                    tokenMetadataJson(
                      seed,
                      amountWei,
                      tokenId,
                      1n,
                      false,
                      mintGene(seed, amountWei),
                      0n,
                      undefined,
                      undefined,
                      params,
                    ),
                  )
                }
              >
                copy metadata json
              </Button>
              <Button
                onClick={() => copy("tokenURI", tokenURI(seed, amountWei, tokenId, 1n, false, mintGene(seed, amountWei), 0n, params))}
              >
                copy tokenURI
              </Button>
              {copied && (
                <span style={{ ...mono, fontSize: 10, color: C.ok }}>{copied} copied</span>
              )}
            </div>
            <textarea
              readOnly
              value={svg}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                ...mono,
                fontSize: 10,
                width: "100%",
                height: 150,
                padding: 10,
                border: `1px solid ${C.hair}`,
                borderRadius: 4,
                background: "#fff",
                resize: "vertical",
                lineHeight: 1.5,
              }}
            />
            <div style={{ ...mono, fontSize: 10, color: C.dim, marginTop: 4 }}>
              {svg.length} bytes
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

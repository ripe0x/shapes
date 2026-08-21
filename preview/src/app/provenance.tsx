import React from "react";
import { C, mono, forDisplay } from "./ui";
import { WAD } from "../canonical/wad";
import { svgFromComposition, type Composition } from "../canonical/render";
import type { Params } from "../canonical/params";
import { decodeModuleByte } from "../canonical/moduleCodec";
import type { ComposeTraceCell, SplitTraceCell } from "../canonical/sampling";

/**
 * Shared per-cell provenance UI: the cell-overlay grid, the per-cell detail panel, donor color
 * assignment, and the helpers that derive per-cell display info from a trace. Used by the DNA
 * sandbox tab (Dna.tsx) and by the DNA section in the card detail modal (Inspect.tsx), so both
 * read the same cell in the same way.
 */

const DONOR_COLORS = [
  "#e63946",
  "#457b9d",
  "#2a9d8f",
  "#e9c46a",
  "#8338ec",
  "#ff6d00",
  "#06d6a0",
  "#ef476f",
  "#118ab2",
  "#ffb703",
];

export function donorColor(i: number): string {
  return DONOR_COLORS[i % DONOR_COLORS.length];
}

export function byteHex(b: number): string {
  return "0x" + b.toString(16).padStart(2, "0");
}

/** WAD bigint to a display float. Display/layout only, never fed back into the renderer. */
function toFloat(w: bigint): number {
  return Number(w) / Number(WAD);
}

export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "2px 0" }}>
      <span style={{ ...mono, fontSize: 10, color: C.dim, width: 128, flexShrink: 0 }}>{k}</span>
      <span style={{ ...mono, fontSize: 10.5, color: C.ink, wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cell-overlay grid
 * ------------------------------------------------------------------ */

export function GridOverlayCells({
  cols,
  rows,
  cell,
  x0,
  y0,
  cellStyle,
  onEnter,
  onLeave,
  onClickCell,
}: {
  cols: number;
  rows: number;
  cell: bigint;
  x0: bigint;
  y0: bigint;
  cellStyle: (j: number) => React.CSSProperties | undefined;
  onEnter?: (j: number) => void;
  onLeave?: () => void;
  onClickCell?: (j: number) => void;
}) {
  const leftPct = (toFloat(x0) / 250) * 100;
  const topPct = (toFloat(y0) / 350) * 100;
  const widthPct = ((toFloat(cell) * cols) / 250) * 100;
  const heightPct = ((toFloat(cell) * rows) / 350) * 100;
  return (
    <div
      onMouseLeave={onLeave}
      style={{
        position: "absolute",
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          width: "100%",
          height: "100%",
        }}
      >
        {Array.from({ length: cols * rows }, (_, j) => (
          <div
            key={j}
            onMouseEnter={() => onEnter?.(j)}
            onClick={() => onClickCell?.(j)}
            style={{ boxSizing: "border-box", cursor: onClickCell ? "pointer" : "default", ...cellStyle(j) }}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Provenance card: a rendered composition with a per-cell overlay grid
 * ------------------------------------------------------------------ */

export function ProvenanceCard({
  composition,
  tokenId = 0n,
  params,
  width = 200,
  label,
  cellStyle,
  onEnter,
  onLeave,
  onClickCell,
}: {
  composition: Composition;
  tokenId?: bigint;
  params: Params;
  width?: number;
  label?: React.ReactNode;
  cellStyle: (j: number) => React.CSSProperties | undefined;
  onEnter?: (j: number) => void;
  onLeave?: () => void;
  onClickCell?: (j: number) => void;
}) {
  const svg = React.useMemo(
    () => svgFromComposition(composition, tokenId, params, false),
    [composition, tokenId, params],
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "2.5 / 3.5",
          background: "#000",
          borderRadius: 5,
          overflow: "hidden",
          lineHeight: 0,
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: forDisplay(svg) }} />
        <GridOverlayCells
          cols={composition.cols}
          rows={composition.rows}
          cell={composition.cell}
          x0={composition.x0}
          y0={composition.y0}
          cellStyle={cellStyle}
          onEnter={onEnter}
          onLeave={onLeave}
          onClickCell={onClickCell}
        />
      </div>
      {label !== undefined && (
        <div style={{ ...mono, fontSize: 9, letterSpacing: "0.06em", color: C.dim, textAlign: "center" }}>
          {label}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Per-cell detail panel
 * ------------------------------------------------------------------ */

export function DetailPanel({
  label,
  moduleIndex,
  byte,
  color,
}: {
  label: string;
  moduleIndex: number;
  byte: number;
  color?: string;
}) {
  const decoded = decodeModuleByte(byte);
  return (
    <div style={{ border: `1px solid ${C.hair}`, borderRadius: 5, padding: 12, minWidth: 220 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {color && <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />}
        <span style={{ ...mono, fontSize: 11, fontWeight: 600 }}>{label}</span>
      </div>
      <Row k="source module #" v={moduleIndex} />
      <Row k="byte" v={byteHex(byte)} />
      <Row k="kind" v={decoded.kind} />
      <Row k="solid" v={decoded.solid ? "solid" : "outline"} />
      <Row k="rotation" v={`${decoded.rot}°`} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Hover/pin state for a single card's active cell
 * ------------------------------------------------------------------ */

/** Hover-or-pinned selection for one card: hover takes precedence, a click toggles a pin that
 *  persists after the pointer leaves. Reused wherever a single card needs one active cell. */
export function useActiveCell() {
  const [hover, setHover] = React.useState<number | null>(null);
  const [pinned, setPinned] = React.useState<number | null>(null);
  const active = hover ?? pinned;
  return {
    active,
    onEnter: (j: number) => setHover(j),
    onLeave: () => setHover(null),
    onClickCell: (j: number) => setPinned((cur) => (cur === j ? null : j)),
  };
}

/* ------------------------------------------------------------------ *
 * Per-cell provenance derivation: seed-derived vs. sampled (compose/split)
 * ------------------------------------------------------------------ */

export interface ComposeProvenanceInfo {
  type: "compose";
  trace: ComposeTraceCell[];
  /** Canonical donor order labels: index 0 is the survivor, 1.. are burns ascending by token id. */
  donorLabels: string[];
  /** Canonical-order aligned with `donorLabels`. */
  donorMaterialized: boolean[];
}

export interface SplitProvenanceInfo {
  type: "split";
  trace: SplitTraceCell[];
}

export type ProvenanceInfo = ComposeProvenanceInfo | SplitProvenanceInfo;

/** One cell's display detail, independent of whether it came from a seed-derived card or a
 *  sampled (compose/split) one. */
export interface CellDetail {
  label: string;
  moduleIndex: number;
  byte: number;
  color?: string;
}

/**
 * Per-cell detail for cell `j`. Without `provenance`, the card is seed-derived (grammar v1):
 * the module byte comes straight from `bytes[j]` and there is no donor to name or tint.
 * With `provenance`, the byte and its source donor/module index come from the trace.
 */
export function cellDetailAt(j: number, bytes: Uint8Array, provenance?: ProvenanceInfo): CellDetail {
  if (!provenance) {
    return { label: `module #${j}`, moduleIndex: j, byte: bytes[j] };
  }
  if (provenance.type === "compose") {
    const cell = provenance.trace[j];
    return {
      label: provenance.donorLabels[cell.donorIndex] ?? cell.donorId,
      moduleIndex: cell.moduleIndex,
      byte: cell.byte,
      color: donorColor(cell.donorIndex),
    };
  }
  const cell = provenance.trace[j];
  return { label: "parent", moduleIndex: cell.moduleIndex, byte: cell.byte, color: C.warn };
}

/**
 * Cell background/outline for cell `j`: donor-tinted for compose provenance, a single warn-color
 * highlight for split provenance (one donor, nothing to distinguish by color), and a neutral
 * highlight on the active cell only for a seed-derived card (no donor tinting).
 */
export function cellStyleAt(
  j: number,
  active: number | null,
  provenance?: ProvenanceInfo,
): React.CSSProperties | undefined {
  const isActive = active === j;
  if (!provenance) {
    if (!isActive) return undefined;
    return { outline: `2px solid ${C.ink}`, outlineOffset: -1, background: `${C.ink}22` };
  }
  if (provenance.type === "compose") {
    const color = donorColor(provenance.trace[j].donorIndex);
    return {
      background: `${color}4d`,
      outline: `${isActive ? 2 : 1}px solid ${color}${isActive ? "" : "55"}`,
      outlineOffset: -1,
    };
  }
  if (!isActive) return undefined;
  return { outline: `2px solid ${C.warn}`, outlineOffset: -1, background: `${C.warn}33` };
}

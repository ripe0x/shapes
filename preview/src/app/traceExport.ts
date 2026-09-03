/**
 * Trace export: the artwork with its cell-overlay grid, composed into one SVG document and
 * downloadable as SVG or a rasterized PNG. Shared by the playground's cell explorers
 * (play/PlayApp.tsx) and the token page's DNA panel (site/TokenView.tsx), which both draw the
 * same per-cell donor tint over the card art (see provenance.tsx's `GridOverlayCells`) and want
 * the identical image as a file.
 *
 * `TraceGeometry` is the minimal grid shape both callers already have: `Composition`
 * (canonical/render.ts, playground) and `CardGeometry` (canonical/render.ts, DNA) both carry
 * cols/rows/cell/x0/y0, so this module imports neither and takes no page-specific type.
 */

import { WAD } from "../canonical/wad";
import { downloadBlob, downloadSvg, rasterizeSvgToPng } from "./exporters";

export interface TraceGeometry {
  cols: number;
  rows: number;
  cell: bigint;
  x0: bigint;
  y0: bigint;
}

/** The artwork's raster size, matching `svgFromComposition`'s own `width="2000" height="2800"`
 *  at `viewBox="0 0 250 350"`. */
const RASTER_W = 2000;
const RASTER_H = 2800;

/** WAD bigint to a float in the artwork's own viewBox units (0..250, 0..350). Overlay geometry
 *  only, never fed back into the renderer. */
function toFloat(w: bigint): number {
  return Number(w) / Number(WAD);
}

/** One `<rect>` per cell `colorForCell` assigns a color to, positioned in the artwork's own
 *  viewBox units, at the same alpha (`4d`, ~30%) `cellStyleAt`'s non-active fill uses on screen.
 *  A cell `colorForCell` returns undefined for (no provenance, e.g. a seed-derived card) is left
 *  untinted rather than drawn in a default color. */
function overlayMarkup(geometry: TraceGeometry, colorForCell: (j: number) => string | undefined): string {
  const x0 = toFloat(geometry.x0);
  const y0 = toFloat(geometry.y0);
  const cell = toFloat(geometry.cell);
  let out = "";
  for (let j = 0; j < geometry.cols * geometry.rows; j++) {
    const color = colorForCell(j);
    if (!color) continue;
    const col = j % geometry.cols;
    const row = Math.floor(j / geometry.cols);
    out += `<rect x="${x0 + col * cell}" y="${y0 + row * cell}" width="${cell}" height="${cell}" fill="${color}4d"/>`;
  }
  return out;
}

/** `artworkSvg` (a full `<svg>...</svg>` string) with the cell overlay inserted before its
 *  closing tag, producing one self-contained SVG document at the artwork's own size. */
export function buildTraceSvg(
  artworkSvg: string,
  geometry: TraceGeometry,
  colorForCell: (j: number) => string | undefined,
): string {
  const closeTag = artworkSvg.lastIndexOf("</svg>");
  if (closeTag === -1) return artworkSvg;
  return artworkSvg.slice(0, closeTag) + overlayMarkup(geometry, colorForCell) + artworkSvg.slice(closeTag);
}

/** A `data:image/svg+xml;base64,...` URI (the tokenURI image field; see `site/art.ts`'s
 *  `localArt`) back to its raw SVG text. Byte-safe: `atob` alone maps each byte to a code unit
 *  and would garble multi-byte UTF-8 in the module glyphs. */
export function svgFromDataUri(uri: string): string {
  const bytes = Uint8Array.from(atob(uri.replace(/^data:image\/svg\+xml;base64,/, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** `<base>-trace.<ext>`: the naming convention every trace download follows, alongside
 *  `exportFilename`'s card/square/ladder/gif names (`play/exports.ts`). */
export function traceFilename(ext: "png" | "svg", base: string): string {
  return `${base}-trace.${ext}`;
}

/** Download the traced artwork as one SVG document. */
export function downloadTraceSvg(
  artworkSvg: string,
  geometry: TraceGeometry,
  colorForCell: (j: number) => string | undefined,
  base: string,
): void {
  downloadSvg(traceFilename("svg", base), buildTraceSvg(artworkSvg, geometry, colorForCell));
}

/** Download the traced artwork rasterized to PNG at its native 2000x2800 size. */
export async function downloadTracePng(
  artworkSvg: string,
  geometry: TraceGeometry,
  colorForCell: (j: number) => string | undefined,
  base: string,
): Promise<void> {
  const svg = buildTraceSvg(artworkSvg, geometry, colorForCell);
  const blob = await rasterizeSvgToPng(svg, RASTER_W, RASTER_H);
  downloadBlob(traceFilename("png", base), blob);
}

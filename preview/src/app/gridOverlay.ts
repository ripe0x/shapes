/**
 * Display-only grid overlay.
 *
 * Draws the artwork field, the derived cell grid and the cell centres on top of a rendered
 * card so the geometry can be checked by eye: that every cell is filled, that modules sit on
 * their centres, and that nothing escapes its cell.
 *
 * This never touches the canonical renderer. The markup is injected into a copy of the SVG for
 * screen display only and is absent from fixtures, exports and anything the chain sees.
 */

import { composeShape } from "../canonical/render";
import { fmt } from "../canonical/wad";
import { CANONICAL, FIELD, type Params } from "../canonical/params";
import { moduleExtent } from "./containment";

const FIELD_COLOR = "#00e5ff";
const GRID_COLOR = "#ff2d55";
const CENTRE_COLOR = "#ffd60a";
const ESCAPE_COLOR = "#ff9500";

export function gridOverlay(
  seed: bigint,
  amountWei: bigint,
  p?: Params,
): string {
  const c = composeShape(seed, amountWei, p);
  const { cols, rows, cell, x0, y0 } = c;

  let out = `<g id="grid-overlay" fill="none" stroke-width="0.4" opacity="0.85">`;

  // artwork field: fixed at every denomination
  out +=
    `<rect x="${fmt(FIELD.cx - FIELD.w / 2n)}" y="${fmt((p ?? CANONICAL).fieldCy - FIELD.h / 2n)}"` +
    ` width="${fmt(FIELD.w)}" height="${fmt(FIELD.h)}"` +
    ` stroke="${FIELD_COLOR}" stroke-dasharray="3 3" opacity="0.55"/>`;

  // grid outline
  const gw = BigInt(cols) * cell;
  const gh = BigInt(rows) * cell;
  out +=
    `<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(gw)}" height="${fmt(gh)}"` +
    ` stroke="${GRID_COLOR}" stroke-width="0.7"/>`;

  // interior cell divisions
  for (let i = 1; i < cols; i++) {
    const x = fmt(x0 + BigInt(i) * cell);
    out += `<line x1="${x}" y1="${fmt(y0)}" x2="${x}" y2="${fmt(y0 + gh)}" stroke="${GRID_COLOR}"/>`;
  }
  for (let j = 1; j < rows; j++) {
    const y = fmt(y0 + BigInt(j) * cell);
    out += `<line x1="${fmt(x0)}" y1="${y}" x2="${fmt(x0 + gw)}" y2="${y}" stroke="${GRID_COLOR}"/>`;
  }

  // painted bounds of any module that leaves its cell — stroke and miter joins included
  const wad = (v: number) => BigInt(Math.round(v * 1e6)) * 10n ** 12n;
  for (const m of c.modules) {
    const e = moduleExtent(m, cell, p ?? CANONICAL);
    if (!e.escapes) continue;
    const x = m.cx - wad(e.x);
    const y = m.cy - wad(e.up);
    out +=
      `<rect x="${fmt(x)}" y="${fmt(y)}"` +
      ` width="${fmt(wad(e.x) * 2n)}" height="${fmt(wad(e.up) + wad(e.down))}"` +
      ` stroke="${ESCAPE_COLOR}" stroke-width="0.9"/>`;
  }

  // cell centres
  for (const m of c.modules) {
    const cx = fmt(m.cx);
    const cy = fmt(m.cy);
    const t = fmt(cell / 22n);
    out +=
      `<path d="M${cx},${fmt(m.cy - cell / 22n)} V${fmt(m.cy + cell / 22n)}` +
      ` M${fmt(m.cx - cell / 22n)},${cy} H${fmt(m.cx + cell / 22n)}"` +
      ` stroke="${CENTRE_COLOR}" stroke-width="0.5" opacity="0.9"/>`;
    void t;
  }

  out += `</g>`;
  return out;
}

/** Insert overlay markup into a rendered SVG, for display only. */
export function withGridOverlay(
  svg: string,
  seed: bigint,
  amountWei: bigint,
  p?: Params,
): string {
  return svg.replace("</svg>", gridOverlay(seed, amountWei, p) + "</svg>");
}

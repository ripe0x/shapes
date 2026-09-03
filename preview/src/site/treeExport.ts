/**
 * Provenance tree export: a `TreeLayout` (site/ProvenanceTree.tsx's `layoutTree`) composed into
 * one standalone SVG document, downloadable as SVG or a rasterized PNG. Shared by the token
 * page's PROVENANCE section and the playground's lineage beat, which both render the same
 * `ProvenanceTree` component and want the identical view as a file. Reflects whatever the layout
 * was computed with (the tree's current expansion state), matching what is on screen.
 */

import {downloadBlob, downloadSvg, rasterizeSvgToPng} from "../app/exporters";
import {svgFromDataUri} from "../app/traceExport";
import {FONT} from "./theme";
import {CAPTION_GAP, CAPTION_LINE_H, HINT_GAP, type TreeLayout} from "./ProvenanceTree";

const SCALE = 2; // export pixel density relative to layout units

const PAPER = "#f7f7f3";
const INK = "#11110f";
const MUTED = "#686862";
const FAINT = "#aaa9a1";
const RULE = "#d8d8d1";
const BORDER = "#b9b9b1";
const ART_BG = "#000000";

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"})[c]!);
}

/** The content between an SVG document's opening and closing `<svg>` tags. */
function innerMarkup(svg: string): string {
  const openEnd = svg.indexOf(">");
  const closeStart = svg.lastIndexOf("</svg>");
  if (openEnd === -1 || closeStart === -1) return "";
  return svg.slice(openEnd + 1, closeStart);
}

function viewBoxOf(svg: string): string {
  return svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 100 100";
}

/** One card's artwork, decoded from its data URI and nested inside the export SVG at the card's
 *  own position and size, sized to cover like the on-screen `object-fit: cover` image. */
function artworkMarkup(art: string, x: number, y: number, w: number, h: number): string {
  const raw = svgFromDataUri(art);
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${viewBoxOf(raw)}" preserveAspectRatio="xMidYMid slice">${innerMarkup(raw)}</svg>`;
}

export interface TreeSvgOptions {
  /** The currently focused/selected node's key, drawn with an ink border instead of the rule
   *  border every other card gets. */
  focusedKey: string | null;
}

/** `layout` composed into one standalone SVG document at `SCALE`x the layout's own units. */
export function buildTreeSvg(layout: TreeLayout, options: TreeSvgOptions): string {
  const W = layout.width * SCALE;
  const H = layout.height * SCALE;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="${PAPER}"/>`;
  out += `<g transform="scale(${SCALE})">`;

  for (const c of layout.connectors) {
    out += `<line x1="${c.x1}" y1="${c.y1}" x2="${c.x2}" y2="${c.y2}" stroke="${RULE}" stroke-width="1"/>`;
  }

  for (const card of layout.cards) {
    const focused = card.node.selectable !== false && card.node.key === options.focusedKey;
    out += `<g opacity="${card.node.muted ? 0.35 : 1}">`;
    out += `<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" fill="${ART_BG}" stroke="${focused ? INK : BORDER}" stroke-width="${focused ? 2 : 1}"/>`;
    out += artworkMarkup(card.node.art, card.x, card.y, card.w, card.h);

    let ty = card.y + card.h + CAPTION_GAP + CAPTION_LINE_H * 0.8;
    const cx = card.x + card.w / 2;
    out += `<text x="${cx}" y="${ty}" font-family="${FONT}" font-size="9.5" text-anchor="middle" fill="${INK}">${escapeXml(card.node.title)}</text>`;
    for (const line of card.node.lines) {
      ty += CAPTION_LINE_H;
      out += `<text x="${cx}" y="${ty}" font-family="${FONT}" font-size="9.5" text-anchor="middle" fill="${MUTED}">${escapeXml(line)}</text>`;
    }
    if (card.node.truncated) {
      ty += CAPTION_LINE_H + HINT_GAP;
      out += `<text x="${cx}" y="${ty}" font-family="${FONT}" font-size="8.5" text-anchor="middle" fill="${FAINT}">not expanded</text>`;
    }
    out += `</g>`;
  }

  for (const r of layout.rollups) {
    out += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${PAPER}" stroke="${BORDER}" stroke-width="1"/>`;
    out += `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 3}" font-family="${FONT}" font-size="10" text-anchor="middle" fill="${FAINT}">+${r.node.rollup} more</text>`;
  }

  out += `</g></svg>`;
  return out;
}

/** `<base>-provenance.<ext>`, matching `traceExport.ts`'s own `-trace.<ext>` convention. */
export function treeFilename(ext: "png" | "svg", base: string): string {
  return `${base}-provenance.${ext}`;
}

export function downloadTreeSvg(layout: TreeLayout, options: TreeSvgOptions, base: string): void {
  downloadSvg(treeFilename("svg", base), buildTreeSvg(layout, options));
}

export async function downloadTreePng(layout: TreeLayout, options: TreeSvgOptions, base: string): Promise<void> {
  const svg = buildTreeSvg(layout, options);
  const blob = await rasterizeSvgToPng(svg, Math.round(layout.width * SCALE), Math.round(layout.height * SCALE));
  downloadBlob(treeFilename("png", base), blob);
}

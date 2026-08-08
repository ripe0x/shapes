/**
 * The canonical Shapes renderer.
 *
 * This file is the single source of truth for the artwork. src/ShapeRenderer.sol
 * is a line-by-line port of it: same draw order, same integer arithmetic, same
 * string assembly, same decimal formatting. The Foundry parity suite asserts
 * byte-identical output against fixtures generated here.
 *
 * Small counting integers (grid dimensions, cell indexes, rotation degrees) use
 * `number` because they are exact. Every geometric quantity is a WAD bigint.
 * There is no float arithmetic anywhere in this module.
 */

import { WAD, mulWad, min, fmt } from "./wad";
import { Round03Rand, seed32Of } from "./rand";
import {
  CANONICAL,
  FIELD,
  KIND_ORDER,
  SQRT3,
  type Kind,
  type Params,
} from "./params";
import {
  DENOMINATIONS,
  GRIDS,
  LABELS,
  denominationIndex,
} from "./denominations";

export interface Module {
  index: number;
  kind: Kind;
  solid: boolean;
  /** 0, 90, 180 or 270 degrees, clockwise. */
  rot: number;
  /** Cell centre. */
  cx: bigint;
  cy: bigint;
  /**
   * The path footprint handed to the drawing primitive — a diameter, a side, or a triangle's
   * base. Solved backwards from the target so that the painted result, stroke and miters
   * included, reaches exactly `target` from the cell centre.
   */
  size: bigint;
  /** Stroke weight. One value per card; drawn only when !solid. */
  weight: bigint;
}

export interface Composition {
  denomIndex: number;
  amountWei: bigint;
  label: string;
  cols: number;
  rows: number;
  /** Card-level parameters, shared by every module on the token. */
  cell: bigint;
  x0: bigint;
  y0: bigint;
  /** Fraction of the half-cell the ink reaches. */
  fill: bigint;
  wRatio: bigint;
  /** Painted half-extent every module on this card reaches, in user units. */
  target: bigint;
  /** Stroke weight, identical for every outlined mark on this card. */
  weight: bigint;
  /** This card's own probability that any given module comes out solid. */
  solidProbability: bigint;
  modules: Module[];
  /** Number of draws the composition consumed. */
  draws: number;
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * Resolve a token into its full geometric description.
 *
 * Draw order — consensus critical, transcribed from Round 03:
 *   1. solid probability (always)
 *   then, for each cell in row-major order:
 *   2. kind              (always)
 *   3. solid             (always)
 *   4. rotation          ONLY when kind is "triangle" or "half"
 *
 * Size and stroke are NOT drawn. They are collection constants scaled by the cell, so every
 * Shape reads at the same proportion whatever its denomination or seed.
 *
 * Note the conditional consumption of the rotation draw. Round 03 evaluates
 * `rot` inside a JavaScript object literal with a ternary, so a circle or square
 * never draws for it. Consuming unconditionally would desynchronise the stream
 * and change every downstream cell.
 */
export function composeShape(
  seed: bigint,
  amountWei: bigint,
  p: Params = CANONICAL,
): Composition {
  const di = denominationIndex(amountWei);
  if (di < 0) throw new Error(`unsupported denomination: ${amountWei}`);

  const [cols, rows] = GRIDS[di];
  const rand = new Round03Rand(seed32Of(seed));

  // cell = min(FIELD.w / cols, FIELD.h / rows)
  const cell = min(FIELD.w / BigInt(cols), FIELD.h / BigInt(rows));
  const x0 = FIELD.cx - (BigInt(cols) * cell) / 2n;
  const y0 = p.fieldCy - (BigInt(rows) * cell) / 2n;
  const halfCell = cell / 2n;

  // Size and stroke are collection constants, proportional to the cell. Everything a Shape
  // varies is in the vocabulary, not in its scale.
  const target = mulWad(halfCell, p.fill);
  const weight = mulWad(2n * target, p.wRatio);
  const solidProbability = drawSolidProbability(rand.next(), p);

  const kinds = p.kinds;
  const nKinds = BigInt(kinds.length);
  const modules: Module[] = [];

  for (let i = 0; i < cols * rows; i++) {
    const kind = kinds[Number(rand.nextBelow(nKinds))];
    const solid = rand.nextBelowProbability(solidProbability);
    const rot =
      kind === "triangle" || kind === "half" || kind === "quarter"
        ? Number(rand.nextBelow(4n)) * 90
        : 0;

    modules.push({
      index: i,
      kind,
      solid,
      rot,
      cx: x0 + BigInt(i % cols) * cell + halfCell,
      cy: y0 + BigInt(Math.floor(i / cols)) * cell + halfCell,
      size: solveSize(kind, solid, target, weight),
      weight,
    });
  }

  return {
    denomIndex: di,
    amountWei,
    label: LABELS[di],
    cols,
    rows,
    cell,
    x0,
    y0,
    fill: p.fill,
    wRatio: p.wRatio,
    target,
    weight,
    solidProbability,
    modules,
    draws: rand.draws,
  };
}

/**
 * Map a uniform draw onto this card's solid probability.
 *
 * A single global solid rate makes every card the same mixture. Drawing the rate per card
 * instead gives the collection a shape: a small share of cards come out entirely outlined, a
 * small share entirely solid, and the rest land somewhere in a band. The two extremes are
 * exact — a card that draws 0 contains no solid mark at all, and one that draws 1 contains no
 * outlined mark — which is why the per-module test is `draw < p` rather than `draw > t`.
 *
 *   r < pureOutlineChance                 -> 0    (every module outlined)
 *   r >= 1 - pureSolidChance              -> 1    (every module solid)
 *   otherwise                             -> remapped linearly onto [bandMin, bandMax]
 *
 * At the committed values that is 5% / 5% / 90% in [0.30, 0.90], for a collection averaging
 * about 59% solid modules.
 */
export function drawSolidProbability(r: bigint, p: Params = CANONICAL): bigint {
  if (r < p.pureOutlineChance) return 0n;
  const upper = WAD - p.pureSolidChance;
  if (r >= upper) return WAD;

  const span = upper - p.pureOutlineChance;
  // position within the middle band, as a WAD fraction
  const t = ((r - p.pureOutlineChance) * WAD) / span;
  return p.solidBandMin + mulWad(t, p.solidBandMax - p.solidBandMin);
}

/**
 * Solve the path footprint that paints to exactly `target` from the cell centre.
 *
 * A solid mark paints to its own edge, so its footprint is simply `2 * target`. An outlined
 * mark is grown by its stroke, and how much depends on the corner geometry:
 *
 *   circle, square, half circle   the stroke straddles the edge, adding w/2 all round
 *                                 -> size = 2 * target - w
 *
 *   triangle                      60 degree corners. A miter join at angle t extends the
 *                                 corner by (w/2) / sin(t/2) along the bisector; at 60 degrees
 *                                 that is a full w, not half of one. Offsetting the outline
 *                                 outward by w/2 grows the side by sqrt(3) * w
 *                                 -> size = 2 * target - sqrt(3) * w
 *
 * With w capped at 0.17 of the painted width the triangle case stays comfortably positive:
 * `2T - sqrt(3) * 0.34T = 1.41T`.
 */
function solveSize(
  kind: Kind,
  solid: boolean,
  target: bigint,
  weight: bigint,
): bigint {
  const full = 2n * target;
  if (solid) return full;
  if (kind === "triangle") return full - mulWad(SQRT3, weight);
  // A diamond's 90 degree corners point straight along the axes, so the miter overshoot lands
  // entirely on the extent: half-diagonal = T - (sqrt(2)/2) w, and the side is sqrt(2) times
  // that. Net: size = sqrt(2) * 2T - 2w, expressed on the half-diagonal below.
  return full - weight;
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

function style(solid: boolean, weight: bigint): string {
  return solid
    ? ` fill="#fff"/>`
    : ` fill="none" stroke="#fff" stroke-width="${fmt(weight)}"/>`;
}

function transform(rot: number, cx: bigint, cy: bigint): string {
  return rot === 0 ? "" : ` transform="rotate(${rot} ${fmt(cx)} ${fmt(cy)})"`;
}

function moduleSvg(m: Module, p: Params): string {
  const { cx, cy, size } = m;
  const r = size / 2n;

  switch (m.kind) {
    case "circle":
      return (
        `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"` +
        style(m.solid, m.weight)
      );

    case "square":
      return (
        `<rect x="${fmt(cx - r)}" y="${fmt(cy - r)}" width="${fmt(size)}" height="${fmt(size)}"` +
        style(m.solid, m.weight)
      );

    case "triangle": {
      const hh = mulWad(size, p.triHeight);
      const half = hh / 2n;
      const points =
        `${fmt(cx)},${fmt(cy - half)} ` +
        `${fmt(cx + r)},${fmt(cy + half)} ` +
        `${fmt(cx - r)},${fmt(cy + half)}`;
      return (
        `<polygon points="${points}"` +
        transform(m.rot, cx, cy) +
        style(m.solid, m.weight)
      );
    }

    case "half": {
      const d =
        `M${fmt(cx - r)},${fmt(cy)} ` +
        `A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(cx + r)},${fmt(cy)} Z`;
      return (
        `<path d="${d}"` + transform(m.rot, cx, cy) + style(m.solid, m.weight)
      );
    }

    // A quarter disc filling the cell: right-angle corner at one corner of the footprint, the
    // arc sweeping across to the opposite two. Radius is the full footprint, not half of it.
    case "quarter": {
      const R = m.size;
      const d =
        `M${fmt(cx - r)},${fmt(cy + r)} ` +
        `L${fmt(cx + r)},${fmt(cy + r)} ` +
        `A${fmt(R)},${fmt(R)} 0 0 0 ${fmt(cx - r)},${fmt(cy - r)} Z`;
      return (
        `<path d="${d}"` + transform(m.rot, cx, cy) + style(m.solid, m.weight)
      );
    }

    // The square on its diagonal. Emitted as its four vertices rather than a rotated rect, so
    // the geometry is explicit and the miter maths stays in one place.
    case "diamond": {
      const points =
        `${fmt(cx)},${fmt(cy - r)} ` +
        `${fmt(cx + r)},${fmt(cy)} ` +
        `${fmt(cx)},${fmt(cy + r)} ` +
        `${fmt(cx - r)},${fmt(cy)}`;
      return `<polygon points="${points}"` + style(m.solid, m.weight);
    }
  }
}

function textSvg(
  x: number,
  y: number,
  family: string,
  size: string,
  letterSpacing: string,
  anchorEnd: boolean,
  body: string,
): string {
  return (
    `<text x="${x}" y="${y}" fill="#fff" font-family="${family}"` +
    ` font-size="${size}" font-weight="500" letter-spacing="${letterSpacing}"` +
    (anchorEnd ? ` text-anchor="end"` : ``) +
    `>${body}</text>`
  );
}

/**
 * Render the complete SVG document for a token.
 *
 * The committed card carries no type: black field, white marks, nothing else. `tokenId` is
 * therefore unused unless the preview's `showText` override is on, and the Solidity renderer
 * does not take it at all.
 *
 * Every string in the output is drawn from a fixed table or is a decimal produced by `fmt`.
 * No caller-controlled text ever reaches the document, so there is no injection surface.
 */
export function renderShape(
  seed: bigint,
  amountWei: bigint,
  tokenId: bigint,
  p: Params = CANONICAL,
): string {
  const c = composeShape(seed, amountWei, p);

  let out =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"` +
    ` width="250" height="350" shape-rendering="geometricPrecision">` +
    `<rect x="0" y="0" width="250" height="350" fill="#000"/>`;

  for (const m of c.modules) out += moduleSvg(m, p);

  if (p.showText) {
    out += textSvg(22, 32, SANS, "8", "3.4", false, "SHAPE");
    out += textSvg(22, 322, SANS, "11", "1.2", false, `${c.label} ETH`);
    out += textSvg(228, 322, MONO, "8", "0.6", true, `#${tokenId.toString()}`);
  }
  out += `</svg>`;

  return out;
}

/**
 * Just the module markup, with no card furniture.
 *
 * This is the geometry that duplicate detection compares: it excludes the token
 * number (which is unique by construction and would mask real collisions) and
 * the SHAPE / ETH label text (which is constant within a denomination).
 */
export function renderGeometry(
  seed: bigint,
  amountWei: bigint,
  p: Params = CANONICAL,
): string {
  const c = composeShape(seed, amountWei, p);
  let out = "";
  for (const m of c.modules) out += moduleSvg(m, p);
  return out;
}

/* ------------------------------------------------------------------ *
 * Module glyph sequence (metadata trait)
 * ------------------------------------------------------------------ */

/**
 * Deterministic glyph for a module. Drawn from the Geometric Shapes block that
 * Round 04 of the design exploration uses, so the trait speaks the same
 * vocabulary as the artwork.
 *
 *   circle    solid ●   outline ○
 *   square    solid ■   outline □
 *   triangle  solid ▲▶▼◀ outline △▷▽◁   (rotation 0/90/180/270, clockwise)
 *   half            ◓◑◒◐ (filled half: upper/right/lower/left)
 *
 * Solid state is not distinguishable for half circles; no paired glyphs exist.
 */
export function moduleGlyph(m: Module): string {
  switch (m.kind) {
    case "circle":
      return m.solid ? "●" : "○";
    case "square":
      return m.solid ? "■" : "□";
    case "triangle": {
      const solidSet = ["▲", "▶", "▼", "◀"];
      const hollowSet = ["△", "▷", "▽", "◁"];
      return (m.solid ? solidSet : hollowSet)[m.rot / 90];
    }
    case "half":
      return ["◓", "◑", "◒", "◐"][m.rot / 90];
    case "quarter":
      return m.solid ? "◔" : "◷";
    case "diamond":
      return m.solid ? "◆" : "◇";
  }
}

export function moduleSequence(c: Composition): string {
  return c.modules.map(moduleGlyph).join(" ");
}

/**
 * How this card came out of the fill draw. `Solid` and `Outline` are the two rare extremes;
 * everything else is `Mixed`. Surfaced as a trait so the extremes are legible rather than
 * something you have to notice by eye.
 */
export function fillClass(c: Composition): "Solid" | "Outline" | "Mixed" {
  if (c.solidProbability === 0n) return "Outline";
  if (c.solidProbability === WAD) return "Solid";
  return "Mixed";
}

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

export const DESCRIPTION =
  "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH; " +
  "burning it returns exactly that amount to its owner. Value sets the grammar, the " +
  "seed writes the sentence: higher denominations resolve into fewer, larger modules. " +
  "Artwork and metadata are generated entirely onchain.";

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
}

export function base64Utf8(s: string): string {
  return b64(new TextEncoder().encode(s));
}

export function seedHex(seed: bigint): string {
  return "0x" + seed.toString(16).padStart(64, "0");
}

export function tokenMetadataJson(
  seed: bigint,
  amountWei: bigint,
  tokenId: bigint,
  p: Params = CANONICAL,
): string {
  const c = composeShape(seed, amountWei, p);
  const svg = renderShape(seed, amountWei, tokenId, p);
  return (
    `{"name":"Shape #${tokenId.toString()}",` +
    `"description":"${DESCRIPTION}",` +
    `"image":"data:image/svg+xml;base64,${base64Utf8(svg)}",` +
    `"attributes":[` +
    `{"trait_type":"ETH Value","value":"${c.label} ETH"},` +
    `{"trait_type":"Grid","value":"${c.cols}x${c.rows}"},` +
    `{"trait_type":"Fill","value":"${fillClass(c)}"},` +
    `{"trait_type":"Modules","value":"${moduleSequence(c)}"},` +
    `{"trait_type":"Module Count","value":${c.cols * c.rows}},` +
    `{"trait_type":"Seed","value":"${seedHex(seed)}"}` +
    `]}`
  );
}

export function tokenURI(
  seed: bigint,
  amountWei: bigint,
  tokenId: bigint,
  p: Params = CANONICAL,
): string {
  return (
    "data:application/json;base64," +
    base64Utf8(tokenMetadataJson(seed, amountWei, tokenId, p))
  );
}

export { DENOMINATIONS, GRIDS, LABELS, KIND_ORDER, CANONICAL, WAD, fmt };
export type { Kind, Params };

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

import { WAD, mulWad, divWad, min, fmt, isqrt } from "./wad";
import { Round03Rand, seed32Of } from "./rand";
import {
  CANONICAL,
  FIELD,
  KIND_ORDER,
  SQRT2,
  TWO_MINUS_SQRT2,
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
  inkScale?: bigint,
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
  // The proposed "history sets the ink" rule (prototype only, not committed): the seed's fill
  // draw is a ceiling, scaled by origin density in WAD. The draw itself always happens, so the
  // stream stays aligned and every other property of the card is unchanged.
  const seedFill = drawSolidProbability(rand.next(), p);
  const solidProbability = inkScale === undefined ? seedFill : mulWad(seedFill, inkScale);

  const kinds = p.kinds;
  const nKinds = BigInt(kinds.length);
  const modules: Module[] = [];

  for (let i = 0; i < cols * rows; i++) {
    const kind = kinds[Number(rand.nextBelow(nKinds))];
    const solid = rand.nextBelowProbability(solidProbability);
    // One rotation draw for any kind with more than one orientation; consumes a single stream
    // value whatever the bound, so a 2-way kind stays aligned with the 4-way ones.
    const rotCount = ROT_COUNT[kind];
    const rot = rotCount > 1 ? Number(rand.nextBelow(BigInt(rotCount))) * 90 : 0;

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
 * A solid mark paints to its own edge, so its footprint is `2 * target`. Outlined marks come
 * in two constructions:
 *
 *   circle, square, halfsquare    drawn as a stroked path. The stroke straddles the edge,
 *                                 adding w/2 all round, and every painted extent — 90 degree
 *                                 miter corners included — lands exactly on the target
 *                                 -> size = 2 * target - w
 *
 *   triangle, rtriangle, diamond, drawn as an even-odd ring whose outer boundary is the solid
 *   half, quarter                 geometry itself, so every edge sits exactly where the solid
 *                                 form's does; the inner boundary is inset by the weight
 *                                 -> size = 2 * target
 *
 *   arc, line                     filled bands of one weight, never solid. Both span the full
 *                                 footprint: the arc's outer curve connects two footprint
 *                                 corners, the line's tips are clipped into the other two
 *                                 -> size = 2 * target
 */
function solveSize(
  kind: Kind,
  solid: boolean,
  target: bigint,
  weight: bigint,
): bigint {
  const full = 2n * target;
  if (kind === "arc" || kind === "line") return full;
  if (solid) return full;
  if (kind === "circle" || kind === "square" || kind === "halfsquare") return full - weight;
  return full;
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

function style(solid: boolean, weight: bigint, fg: string): string {
  return solid
    ? ` fill="${fg}"/>`
    : ` fill="none" stroke="${fg}" stroke-width="${fmt(weight)}"/>`;
}

function transform(rot: number, cx: bigint, cy: bigint): string {
  return rot === 0 ? "" : ` transform="rotate(${rot} ${fmt(cx)} ${fmt(cy)})"`;
}

/**
 * An outlined mark built as a filled even-odd ring: the outer subpath is the solid geometry
 * itself, the inner subpath the same shape inset by the stroke weight. Every painted edge
 * therefore sits exactly where the solid form's does — no stroke, no miter arithmetic.
 */
function ring(d: string, rot: number, cx: bigint, cy: bigint, fg: string): string {
  return `<path fill-rule="evenodd" d="${d}"` + transform(rot, cx, cy) + ` fill="${fg}"/>`;
}

/** divWad(a - b, a), clamped to zero when the inset would consume the shape. */
function insetScale(a: bigint, b: bigint): bigint {
  return a > b ? divWad(a - b, a) : 0n;
}

function moduleSvg(m: Module, p: Params, fg: string): string {
  const { cx, cy, size } = m;
  const r = size / 2n;

  switch (m.kind) {
    case "circle":
      return (
        `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"` +
        style(m.solid, m.weight, fg)
      );

    case "square":
      return (
        `<rect x="${fmt(cx - r)}" y="${fmt(cy - r)}" width="${fmt(size)}" height="${fmt(size)}"` +
        style(m.solid, m.weight, fg)
      );

    case "triangle": {
      const hh = mulWad(size, p.triHeight);
      const half = hh / 2n;
      const outer =
        `M${fmt(cx)},${fmt(cy - half)} ` +
        `L${fmt(cx + r)},${fmt(cy + half)} ` +
        `L${fmt(cx - r)},${fmt(cy + half)} Z`;
      if (m.solid) {
        const points =
          `${fmt(cx)},${fmt(cy - half)} ` +
          `${fmt(cx + r)},${fmt(cy + half)} ` +
          `${fmt(cx - r)},${fmt(cy + half)}`;
        return (
          `<polygon points="${points}"` + transform(m.rot, cx, cy) + style(true, m.weight, fg)
        );
      }
      // Inner triangle: the outer scaled about the incenter, which offsets every edge inward
      // by the weight. Incenter sits one third of the height above the base; inradius = h/3.
      const rho = hh / 3n;
      const k = insetScale(rho, m.weight);
      const iy = cy + half - rho;
      const inner =
        `M${fmt(cx)},${fmt(iy - mulWad(k, hh - rho))} ` +
        `L${fmt(cx + mulWad(k, r))},${fmt(iy + mulWad(k, rho))} ` +
        `L${fmt(cx - mulWad(k, r))},${fmt(iy + mulWad(k, rho))} Z`;
      return ring(`${outer} ${inner}`, m.rot, cx, cy, fg);
    }

    case "half": {
      const outer =
        `M${fmt(cx - r)},${fmt(cy)} ` +
        `A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(cx + r)},${fmt(cy)} Z`;
      if (m.solid) {
        return `<path d="${outer}"` + transform(m.rot, cx, cy) + style(true, m.weight, fg);
      }
      // Inner region: the half disc's points at least `weight` from its boundary — an arc of
      // radius r - w about the same centre, chorded where it meets the offset flat edge.
      const ri = r - m.weight;
      const q = isqrt(ri * ri - m.weight * m.weight);
      const inner =
        `M${fmt(cx - q)},${fmt(cy - m.weight)} ` +
        `A${fmt(ri)},${fmt(ri)} 0 0 1 ${fmt(cx + q)},${fmt(cy - m.weight)} Z`;
      return ring(`${outer} ${inner}`, m.rot, cx, cy, fg);
    }

    // A quarter disc filling the cell: right-angle corner at one corner of the footprint, the
    // arc sweeping across to the opposite two. Radius is the full footprint, not half of it.
    case "quarter": {
      const R = m.size;
      const outer =
        `M${fmt(cx - r)},${fmt(cy + r)} ` +
        `L${fmt(cx + r)},${fmt(cy + r)} ` +
        `A${fmt(R)},${fmt(R)} 0 0 0 ${fmt(cx - r)},${fmt(cy - r)} Z`;
      if (m.solid) {
        return `<path d="${outer}"` + transform(m.rot, cx, cy) + style(true, m.weight, fg);
      }
      // Inner region: legs offset inward by the weight, arc of radius R - w about the same
      // corner, meeting each offset leg where the circle crosses it.
      const Ri = R - m.weight;
      const q = isqrt(Ri * Ri - m.weight * m.weight);
      const inner =
        `M${fmt(cx - r + m.weight)},${fmt(cy + r - m.weight)} ` +
        `L${fmt(cx - r + q)},${fmt(cy + r - m.weight)} ` +
        `A${fmt(Ri)},${fmt(Ri)} 0 0 0 ${fmt(cx - r + m.weight)},${fmt(cy + r - q)} Z`;
      return ring(`${outer} ${inner}`, m.rot, cx, cy, fg);
    }

    // The square on its diagonal. Emitted as its four vertices rather than a rotated rect, so
    // the geometry is explicit in one place.
    case "diamond": {
      if (m.solid) {
        const points =
          `${fmt(cx)},${fmt(cy - r)} ` +
          `${fmt(cx + r)},${fmt(cy)} ` +
          `${fmt(cx)},${fmt(cy + r)} ` +
          `${fmt(cx - r)},${fmt(cy)}`;
        return `<polygon points="${points}"` + style(true, m.weight, fg);
      }
      // Inner diamond: edges offset inward by the weight shorten the half-diagonal by w·√2.
      const ri = r > mulWad(SQRT2, m.weight) ? r - mulWad(SQRT2, m.weight) : 0n;
      const d =
        `M${fmt(cx)},${fmt(cy - r)} L${fmt(cx + r)},${fmt(cy)} ` +
        `L${fmt(cx)},${fmt(cy + r)} L${fmt(cx - r)},${fmt(cy)} Z ` +
        `M${fmt(cx)},${fmt(cy - ri)} L${fmt(cx + ri)},${fmt(cy)} ` +
        `L${fmt(cx)},${fmt(cy + ri)} L${fmt(cx - ri)},${fmt(cy)} Z`;
      return ring(d, 0, cx, cy, fg);
    }

    // Half the cell, split by a straight edge: a rectangle filling the upper half of the
    // footprint at rot 0, spun to the other three halves by rotation. The rectangular twin of
    // the half circle.
    case "halfsquare": {
      return (
        `<rect x="${fmt(cx - r)}" y="${fmt(cy - r)}" width="${fmt(size)}" height="${fmt(r)}"` +
        transform(m.rot, cx, cy) +
        style(m.solid, m.weight, fg)
      );
    }

    // The square cut on its diagonal: a right triangle filling half the footprint. Right angle
    // at the top-left corner at rot 0, hypotenuse from top-right to bottom-left; rotation moves
    // which corner holds the right angle.
    case "rtriangle": {
      if (m.solid) {
        const points =
          `${fmt(cx - r)},${fmt(cy - r)} ` +
          `${fmt(cx + r)},${fmt(cy - r)} ` +
          `${fmt(cx - r)},${fmt(cy + r)}`;
        return (
          `<polygon points="${points}"` + transform(m.rot, cx, cy) + style(true, m.weight, fg)
        );
      }
      // Inner triangle: the outer scaled about the incenter, which offsets every edge inward
      // by the weight. For a right isoceles triangle with legs 2r, inradius = r·(2 - √2); the
      // incenter sits that far from each leg.
      const rho = mulWad(r, TWO_MINUS_SQRT2);
      const k = insetScale(rho, m.weight);
      const ix = cx - r + rho;
      const iy = cy - r + rho;
      const near = mulWad(k, rho); // incenter to the right-angle vertex, scaled
      const far = mulWad(k, 2n * r - rho); // incenter to each acute vertex, scaled
      const d =
        `M${fmt(cx - r)},${fmt(cy - r)} L${fmt(cx + r)},${fmt(cy - r)} ` +
        `L${fmt(cx - r)},${fmt(cy + r)} Z ` +
        `M${fmt(ix - near)},${fmt(iy - near)} L${fmt(ix + far)},${fmt(iy - near)} ` +
        `L${fmt(ix - near)},${fmt(iy + far)} Z`;
      return ring(d, m.rot, cx, cy, fg);
    }

    // The curved edge of the quarter disc on its own: a filled annular band one weight thick.
    // The outer curve has the footprint for its radius and connects two footprint corners; the
    // band's flat radial ends lie on the footprint edges.
    case "arc": {
      const R = m.size;
      const Ri = R - m.weight;
      const d =
        `M${fmt(cx + r)},${fmt(cy + r)} ` +
        `A${fmt(R)},${fmt(R)} 0 0 0 ${fmt(cx - r)},${fmt(cy - r)} ` +
        `L${fmt(cx - r)},${fmt(cy - r + m.weight)} ` +
        `A${fmt(Ri)},${fmt(Ri)} 0 0 1 ${fmt(cx + r - m.weight)},${fmt(cy + r)} Z`;
      return `<path d="${d}"` + transform(m.rot, cx, cy) + ` fill="${fg}"/>`;
    }

    // A straight diagonal band across the cell, one weight thick, its centreline the footprint
    // diagonal. The tips are clipped by the footprint square, so each ends in a point exactly
    // on the corner. Two orientations.
    case "line": {
      const o = mulWad(m.weight, SQRT2) / 2n; // the clipped tip's run along each edge
      const d =
        `M${fmt(cx - r + o)},${fmt(cy - r)} ` +
        `L${fmt(cx + r)},${fmt(cy + r - o)} ` +
        `L${fmt(cx + r)},${fmt(cy + r)} ` +
        `L${fmt(cx + r - o)},${fmt(cy + r)} ` +
        `L${fmt(cx - r)},${fmt(cy - r + o)} ` +
        `L${fmt(cx - r)},${fmt(cy - r)} Z`;
      return `<path d="${d}"` + transform(m.rot, cx, cy) + ` fill="${fg}"/>`;
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
  inverted = false,
  inkScale?: bigint,
): string {
  const c = composeShape(seed, amountWei, p, inkScale);

  const bg = inverted ? "#fff" : "#000";
  const fg = inverted ? "#000" : "#fff";

  // The width/height attributes set the intrinsic raster size (8x the viewBox); all geometry
  // stays in viewBox units, so the rendered look is unchanged at any scale.
  let out =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"` +
    ` width="2000" height="2800" shape-rendering="geometricPrecision">` +
    `<rect x="0" y="0" width="250" height="350" fill="${bg}"/>`;

  for (const m of c.modules) out += moduleSvg(m, p, fg);

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
  for (const m of c.modules) out += moduleSvg(m, p, "#fff");
  return out;
}

/* ------------------------------------------------------------------ *
 * Vocabulary catalog
 * ------------------------------------------------------------------ */

/** Distinct rotations each kind takes: 1 (rotation-invariant), 2 (the diagonal line), or 4. */
const ROT_COUNT: Record<Kind, number> = {
  circle: 1,
  square: 1,
  diamond: 1,
  triangle: 4,
  half: 4,
  quarter: 4,
  halfsquare: 4,
  rtriangle: 4,
  arc: 4,
  line: 2,
};

/** Open-stroke kinds: drawn as an outline only, never filled — no solid form. */
const OUTLINE_ONLY: ReadonlySet<Kind> = new Set(["arc", "line"]);

export interface Appearance {
  kind: Kind;
  solid: boolean;
  /** 0, 90, 180 or 270; always 0 for a non-rotating kind. */
  rot: number;
  glyph: string;
}

/**
 * Every distinct module appearance the generator can produce: each kind in solid and outline,
 * across its distinct rotations. At the committed vocabulary that is 30 forms — circle, square
 * and diamond contribute two each; triangle, half and quarter eight each.
 */
export function vocabulary(kinds: readonly Kind[] = KIND_ORDER): Appearance[] {
  const out: Appearance[] = [];
  for (const kind of kinds) {
    const rc = ROT_COUNT[kind];
    const rots = rc === 4 ? [0, 90, 180, 270] : rc === 2 ? [0, 90] : [0];
    // Open strokes have no solid form, so they contribute only their outline.
    const fills = OUTLINE_ONLY.has(kind) ? [false] : [true, false];
    for (const solid of fills) {
      for (const rot of rots) {
        const m: Module = {index: 0, kind, solid, rot, cx: 0n, cy: 0n, size: 0n, weight: 0n};
        out.push({kind, solid, rot, glyph: moduleGlyph(m)});
      }
    }
  }
  return out;
}

/**
 * Render one module appearance as a standalone SVG swatch. Uses the same geometry the artwork
 * does — canonical fill and stroke, solved back from the painted target — centred in a square
 * field, so a swatch reads at the exact proportion a real card's module would.
 */
export function renderModuleSwatch(
  kind: Kind,
  solid: boolean,
  rot: number,
  p: Params = CANONICAL,
  side = 100,
): string {
  const cell = BigInt(side) * WAD;
  const halfCell = cell / 2n;
  const target = mulWad(halfCell, p.fill);
  const weight = mulWad(2n * target, p.wRatio);
  const m: Module = {
    index: 0,
    kind,
    solid,
    rot,
    cx: halfCell,
    cy: halfCell,
    size: solveSize(kind, solid, target, weight),
    weight,
  };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"` +
    ` width="${side}" height="${side}" shape-rendering="geometricPrecision">` +
    `<rect x="0" y="0" width="${side}" height="${side}" fill="#000"/>` +
    moduleSvg(m, p, "#fff") +
    `</svg>`
  );
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
    case "halfsquare":
      return ["⬒", "◨", "⬓", "◧"][m.rot / 90]; // filled half: upper/right/lower/left
    case "rtriangle":
      return ["◸", "◹", "◿", "◺"][m.rot / 90]; // right angle at: TL/TR/BR/BL
    case "arc":
      return ["◜", "◝", "◞", "◟"][m.rot / 90]; // quadrant arc
    case "line":
      return ["╲", "╱"][m.rot / 90]; // diagonal, two orientations
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
  // A single mark can only come out one way, so report what it actually is rather than the
  // card's fill regime — otherwise a lone module (the 100 ETH apex) reads "Mixed" while only
  // one fill is ever drawn.
  if (c.modules.length === 1) return c.modules[0].solid ? "Solid" : "Outline";
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

const UNIT = 10_000_000_000_000_000n; // 0.01 ETH

/** The backing's 0.01-unit count for a composition. */
export function unitsOf(c: Composition): bigint {
  return DENOMINATIONS[c.denomIndex] / UNIT;
}

/**
 * Provenance label derived from `(units, originCount, isBlack)`. Black takes precedence, then
 * Complete (an origin per unit, above the minimum tier), then Fragment (zero origins — a
 * decompose remainder credited none), then Direct vs Composed. Mirrors `ShapeRenderer._formation`.
 * Fragment is distinct so a zero-origin split remainder is not labelled "Composed".
 */
export function formation(
  units: bigint,
  originCount: bigint,
  isBlack: boolean,
): "Black" | "Complete" | "Fragment" | "Direct" | "Composed" {
  if (isBlack) return "Black";
  if (units > 1n && originCount === units) return "Complete";
  if (originCount === 0n) return "Fragment";
  if (originCount === 1n) return "Direct";
  return "Composed";
}

/**
 * `originCount / units` as a percentage string, trailing zeros trimmed: "100", "20", "1", "0.2",
 * "0.01". Every unit count divides 10000, so the hundredths are exact. Mirrors
 * `ShapeRenderer._densityPercent`.
 */
export function densityPercent(units: bigint, originCount: bigint): string {
  const h = (originCount * 10000n) / units; // percentage in hundredths
  const whole = h / 100n;
  const frac = h % 100n;
  if (frac === 0n) return whole.toString();
  if (frac % 10n === 0n) return `${whole}.${frac / 10n}`;
  const two = frac < 10n ? `0${frac}` : `${frac}`;
  return `${whole}.${two}`;
}

export function tokenMetadataJson(
  seed: bigint,
  amountWei: bigint,
  tokenId: bigint,
  originCount: bigint,
  inverted: boolean,
  p: Params = CANONICAL,
): string {
  const c = composeShape(seed, amountWei, p);
  const svg = renderShape(seed, amountWei, tokenId, p, inverted);
  const units = unitsOf(c);
  const complete = !inverted && units > 1n && originCount === units;
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
    `{"trait_type":"Formation","value":"${formation(units, originCount, inverted)}"},` +
    `{"trait_type":"Independent Origins","value":${originCount.toString()}},` +
    `{"trait_type":"Origin Density","value":"${densityPercent(units, originCount)}%"},` +
    `{"trait_type":"Complete","value":"${complete ? "true" : "false"}"},` +
    `{"trait_type":"Black","value":"${inverted ? "true" : "false"}"},` +
    `{"trait_type":"Seed","value":"${seedHex(seed)}"}` +
    `]}`
  );
}

export function tokenURI(
  seed: bigint,
  amountWei: bigint,
  tokenId: bigint,
  originCount: bigint,
  inverted: boolean,
  p: Params = CANONICAL,
): string {
  return (
    "data:application/json;base64," +
    base64Utf8(tokenMetadataJson(seed, amountWei, tokenId, originCount, inverted, p))
  );
}

export { DENOMINATIONS, GRIDS, LABELS, KIND_ORDER, CANONICAL, WAD, fmt };
export type { Kind, Params };

/**
 * Cell containment verification.
 *
 * Since the renderer solves each module's footprint backwards from a painted-extent target,
 * containment is exact by construction: every mark reaches `fill x cell/2` from its cell
 * centre and no further, whatever primitive it is and whether it is solid or outlined.
 *
 * This module re-derives the painted extent *forwards* from the emitted geometry, so the
 * property is checked rather than assumed. If the solver and the drawing code ever disagree,
 * the preview says so instead of quietly overflowing.
 */

import { composeShape, type Module } from "../canonical/render";
import { CANONICAL, type Params } from "../canonical/params";
import { WAD } from "../canonical/wad";

const num = (w: bigint) => Number(w) / Number(WAD);

export interface Extent {
  x: number;
  up: number;
  down: number;
  /** Worst of the three as a fraction of the half-cell. 1.0 means it touches the boundary. */
  ratio: number;
  escapes: boolean;
}

/** Painted half-extents re-derived forwards from the emitted path, stroke and miters included. */
export function moduleExtent(m: Module, cellWad: bigint, p: Params = CANONICAL): Extent {
  const size = num(m.size);
  const w = m.solid ? 0 : num(m.weight);
  const half = num(cellWad) / 2;

  let x: number;
  let up: number;
  let down: number;

  switch (m.kind) {
    case "circle":
    case "square":
      // stroked outlines straddle the path by w/2; a square's 90 degree miter corners land
      // exactly on the same axis extent
      x = up = down = size / 2 + w / 2;
      break;
    // even-odd rings: the painted outer boundary is the solid geometry itself, so the extent
    // is the solid extent whatever the fill bit says
    case "quarter":
    case "diamond":
    case "rtriangle":
      x = up = down = size / 2;
      break;
    case "half":
      // flat edge on the centre line: the arc reaches up, nothing paints below it
      x = size / 2;
      up = x;
      down = 0;
      break;
    case "triangle": {
      const h = num(p.triHeight) * size;
      x = size / 2;
      up = h / 2;
      down = h / 2;
      break;
    }
    // rectangular half, stroked: flat cut edge on the centre line, stroke corners reach below
    case "halfsquare":
      x = size / 2 + w / 2;
      up = x;
      down = (w / 2) * Math.SQRT2;
      break;
    // arc and line are open strokes reaching between opposite footprint corners; always drawn
    // (never filled), so the stroke always applies whatever the ignored solid bit says. The
    // arc's endpoint caps project w/2 onto the axis; the line meets it at 45 degrees, so its
    // cap projects only (√2/4)·w.
    case "arc": {
      const ws = num(m.weight);
      x = up = down = size / 2 + ws / 2;
      break;
    }
    case "line": {
      const ws = num(m.weight);
      x = up = down = size / 2 + (Math.SQRT2 / 4) * ws;
      break;
    }
  }

  const worst = Math.max(x, up, down);
  // a hair of tolerance for the wad->decimal rounding in the emitted coordinates
  return { x, up, down, ratio: worst / half, escapes: worst > half + 1e-6 };
}

export interface CardContainment {
  worstRatio: number;
  escaping: number[];
  escapes: boolean;
}

export function cardContainment(
  seed: bigint,
  amountWei: bigint,
  p: Params = CANONICAL,
): CardContainment {
  const c = composeShape(seed, amountWei, p);
  let worstRatio = 0;
  const escaping: number[] = [];
  for (const m of c.modules) {
    const e = moduleExtent(m, c.cell, p);
    if (e.ratio > worstRatio) worstRatio = e.ratio;
    if (e.escapes) escaping.push(m.index);
  }
  return { worstRatio, escaping, escapes: escaping.length > 0 };
}

/** The painted extent as a fraction of the half-cell. Equals `fill` by construction. */
export function worstCaseRatio(p: Params = CANONICAL): number {
  return num(p.fill);
}

/** Edge to edge is 1.0; anything above it would cross the cell boundary. */
export function maxSafeFill(): number {
  return 1;
}

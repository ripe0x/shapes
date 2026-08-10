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
const SQRT3_2 = 0.8660254037844386;

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
    // a quarter disc's three corners are all 90 degrees, so its axis extent matches a square's
    case "quarter":
    // a diamond's corners point along the axes; a 90 degree miter reaches (w/2)*sqrt(2) along
    // the bisector, whose axis component is exactly w/2
    case "diamond":
      x = up = down = size / 2 + w / 2;
      break;
    case "half":
      // flat edge on the centre line: the arc reaches up, the stroke corners reach down
      x = size / 2 + w / 2;
      up = x;
      down = (w / 2) * Math.SQRT2;
      break;
    case "triangle": {
      const h = num(p.triHeight) * size;
      x = size / 2 + SQRT3_2 * w;
      up = h / 2 + w;
      down = h / 2 + w / 2;
      break;
    }
    // rectangular half: flat cut edge on the centre line (like the half circle), the outer
    // corners are 90 degrees so they add nothing past the straight edges
    case "halfsquare":
      x = size / 2 + w / 2;
      up = x;
      down = (w / 2) * Math.SQRT2;
      break;
    // right triangle: two 45 degree acute corners whose miter reaches (1+sqrt2)/2 * w along the
    // axis, further than any straight edge
    case "rtriangle": {
      const miter = ((1 + Math.SQRT2) / 2) * w;
      x = size / 2 + miter;
      up = size / 2 + w / 2;
      down = size / 2 + miter;
      break;
    }
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

/**
 * Round 03 design constants.
 *
 * `CANONICAL` is the frozen set that the Solidity renderer hard-codes. The preview harness may
 * override any of these to explore the design space, but anything other than CANONICAL is a
 * preview-only experiment and is labelled as such in the UI.
 *
 * ---- what is actually controlled ----
 *
 * The controlled quantity is the **painted half-extent**: the distance from the cell centre to
 * the furthest ink, stroke and miter joins included. Every module on a card is solved backwards
 * so this lands on exactly one target, `fill x cell/2`.
 *
 * The earlier model controlled the nominal path size and let the stroke add on top, so the real
 * footprint drifted by primitive and by fill state — an outlined square reached further than a
 * solid one, a triangle's 60 degree miters reached further still, and nothing quite touched the
 * same bound. Solving for the painted extent removes all of it: containment is exact by
 * construction rather than a headroom argument, and every mark on a card reaches the same
 * distance from its cell centre.
 */

import {WAD} from "./wad";

export type Kind =
  | "circle"
  | "square"
  | "triangle"
  | "half"
  | "quarter"
  | "diamond"
  | "halfsquare"
  | "rtriangle"
  | "arc"
  | "line";

/**
 * Draw order for kind selection. Round 03 selects with
 * `KINDS[Math.floor(rand() * KINDS.length)]`, so this order is consensus-critical: changing it
 * changes every token.
 *
 * There is deliberately no `ring`. A ring is a circle with a heavier stroke, and carrying it as
 * its own primitive meant one mark on a card ignored the card's stroke weight in favour of a
 * hard-coded 0.22 x d — between 1.3x and 2.2x heavier than the outlined circle beside it, for
 * no reason a viewer could infer. Fill is the only bit that separates a circle from a ring, and
 * `solid` already carries it.
 */
export const KIND_ORDER: readonly Kind[] = [
  "circle",
  "square",
  "triangle",
  "half",
  // `quarter` continues the circle-division series (full, half, quarter) and is the only form
  // combining a hard right angle with an arc. `diamond` is the square on its diagonal.
  "quarter",
  "diamond",
  // `halfsquare` is the rectangular twin of `half`: half the cell, split by a straight edge.
  // `rtriangle` is the square cut on its diagonal — a right triangle filling half the cell.
  "halfsquare",
  "rtriangle",
  // `arc` is the curved edge of the quarter disc alone, with no straight radii, and `line` is
  // the cell diagonal. Both are open strokes: outline only, never filled.
  "arc",
  "line",
];

/** The primitives the Solidity renderer implements. */
export const COMMITTED_KINDS: readonly Kind[] = KIND_ORDER;

export interface Params {
  /**
   * Fraction of the half-cell the painted mark reaches. A collection constant, not a draw:
   * every Shape at every denomination uses this same proportion, so size reads consistently
   * across the collection and scales only with the cell. 1.0 is edge to edge — the ink touches
   * the cell boundary exactly and never crosses it.
   */
  fill: bigint;
  /** Stroke weight as a fraction of the mark's painted width. Also a collection constant. */
  wRatio: bigint;
  /** 0.866 — equilateral triangle height as a fraction of its side. */
  triHeight: bigint;
  /**
   * How solid a card is, is itself drawn per card rather than fixed for the collection.
   * A small share of cards come out entirely outlined, a small share entirely solid, and the
   * rest land somewhere in a band. See `drawSolidProbability`.
   */
  pureOutlineChance: bigint;
  pureSolidChance: bigint;
  solidBandMin: bigint;
  solidBandMax: bigint;
  /** Active vocabulary, a subset of KIND_ORDER in KIND_ORDER sequence. */
  kinds: readonly Kind[];
  /**
   * Draw the three text elements: SHAPE, the ETH label, the token number.
   *
   * OFF in the committed set — a Shape is artwork only. This flag exists so the preview can
   * show the typographic variant for comparison; the Solidity renderer implements the
   * text-free path alone and emits no text at all.
   */
  showText: boolean;
  /** Vertical centre of the artwork field. 175 is the card's true centre. */
  fieldCy: bigint;
}

const wad = (n: string): bigint => {
  const [i, f = ""] = n.split(".");
  return BigInt(i) * WAD + BigInt((f + "0".repeat(18)).slice(0, 18));
};

export const CANONICAL: Params = Object.freeze({
  fill: wad("0.83"),
  wRatio: wad("0.14"),
  triHeight: wad("0.866"),
  pureOutlineChance: wad("0.05"),
  pureSolidChance: wad("0.05"),
  solidBandMin: wad("0.30"),
  solidBandMax: wad("0.90"),
  kinds: COMMITTED_KINDS,
  showText: false,
  fieldCy: 175n * WAD,
}) as Params;

/** √3 in WAD, used to invert a triangle's 60 degree miter overshoot. */
export const SQRT3 = 1_732_050_807_568_877_293n;

/** √2 in WAD, and 1 + √2, used to invert 90 and 45 degree miter overshoots. */
export const SQRT2 = 1_414_213_562_373_095_048n;
export const ONE_PLUS_SQRT2 = 2_414_213_562_373_095_048n;

/** Artwork field. Fixed for every denomination. */
export const FIELD = Object.freeze({
  w: 198n * WAD,
  h: 230n * WAD,
  cx: 125n * WAD,
  cy: 169n * WAD,
});

export const CANVAS_W = 250n;
export const CANVAS_H = 350n;

export function paramsEqualCanonical(p: Params): boolean {
  return (
    p.fill === CANONICAL.fill &&
    p.wRatio === CANONICAL.wRatio &&
    p.triHeight === CANONICAL.triHeight &&
    p.pureOutlineChance === CANONICAL.pureOutlineChance &&
    p.pureSolidChance === CANONICAL.pureSolidChance &&
    p.solidBandMin === CANONICAL.solidBandMin &&
    p.solidBandMax === CANONICAL.solidBandMax &&
    p.showText === CANONICAL.showText &&
    p.fieldCy === CANONICAL.fieldCy &&
    p.kinds.length === CANONICAL.kinds.length &&
    p.kinds.every((k, i) => k === CANONICAL.kinds[i])
  );
}

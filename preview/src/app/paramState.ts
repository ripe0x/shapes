/**
 * Editable mirror of the canonical render parameters.
 *
 * The UI edits plain numbers; this converts them to the WAD bigints the canonical renderer
 * consumes, at a fixed 1e-9 quantisation so a value typed into the UI maps to exactly one WAD
 * value. Every canonical constant is exact at that quantisation, so `toParams(CANONICAL_NUM)`
 * is bit-identical to `CANONICAL`.
 */

import { CANONICAL, KIND_ORDER, type Kind, type Params } from "../canonical/params";

export interface NumParams {
  /** Fraction of the half-cell the ink reaches. Constant across the collection. */
  fill: number;
  /** Stroke weight as a fraction of the mark's painted width. Constant across the collection. */
  wRatio: number;
  triHeight: number;
  /** Share of cards that come out entirely outlined. */
  pureOutlineChance: number;
  /** Share of cards that come out entirely solid. */
  pureSolidChance: number;
  /** The band every other card's solid rate is drawn from. */
  solidBandMin: number;
  solidBandMax: number;
  useHalf: boolean;
  useQuarter: boolean;
  useDiamond: boolean;
  /** Draw SHAPE, the ETH label and the token number. */
  showText: boolean;
  /** Vertical centre of the artwork field. 169 with type, 175 is the card centre. */
  fieldCy: number;
}

export const CANONICAL_NUM: NumParams = {
  fill: 0.83,
  wRatio: 0.14,
  triHeight: 0.866,
  pureOutlineChance: 0.05,
  pureSolidChance: 0.05,
  solidBandMin: 0.3,
  solidBandMax: 0.9,
  useHalf: true,
  useQuarter: true,
  useDiamond: true,
  showText: false,
  fieldCy: 175,
};

/** Quantise to 1e-9 then scale to WAD. Deterministic for any UI input. */
export function toWad(x: number): bigint {
  return BigInt(Math.round(x * 1e9)) * 1_000_000_000n;
}

export function toParams(n: NumParams): Params {
  const kinds: Kind[] = KIND_ORDER.filter(
    (k) =>
      (k !== "half" || n.useHalf) &&
      (k !== "quarter" || n.useQuarter) &&
      (k !== "diamond" || n.useDiamond),
  );
  return {
    fill: toWad(n.fill),
    wRatio: toWad(n.wRatio),
    triHeight: toWad(n.triHeight),
    pureOutlineChance: toWad(n.pureOutlineChance),
    pureSolidChance: toWad(n.pureSolidChance),
    solidBandMin: toWad(Math.min(n.solidBandMin, n.solidBandMax)),
    solidBandMax: toWad(Math.max(n.solidBandMin, n.solidBandMax)),
    kinds,
    showText: n.showText,
    fieldCy: BigInt(Math.round(n.fieldCy * 1e6)) * 10n ** 12n,
  };
}

export interface Diff {
  key: string;
  current: string;
  committed: string;
}

/** Which parameters differ from the values the Solidity renderer hard-codes. */
export function diffFromCanonical(n: NumParams): Diff[] {
  const out: Diff[] = [];
  for (const k of Object.keys(CANONICAL_NUM) as (keyof NumParams)[]) {
    if (n[k] !== CANONICAL_NUM[k]) {
      out.push({ key: k, current: String(n[k]), committed: String(CANONICAL_NUM[k]) });
    }
  }
  return out;
}

/** Sanity check that the numeric mirror reproduces the frozen constants. */
export function mirrorIsExact(): boolean {
  const p = toParams(CANONICAL_NUM);
  return (
    p.fill === CANONICAL.fill &&
    p.wRatio === CANONICAL.wRatio &&
    p.triHeight === CANONICAL.triHeight &&
    p.pureOutlineChance === CANONICAL.pureOutlineChance &&
    p.pureSolidChance === CANONICAL.pureSolidChance &&
    p.solidBandMin === CANONICAL.solidBandMin &&
    p.solidBandMax === CANONICAL.solidBandMax
  );
}

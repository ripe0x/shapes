/**
 * The nine canonical Shape denominations and the grid each one maps to.
 * These are permanent protocol rules, mirrored in src/lib/Denominations.sol and asserted equal
 * by the parity suite.
 *
 * The amounts, their unit and their labels come from the ladder table in ./ladders/mainnet, which
 * mirrors ladders/mainnet/Ladder.sol. Everything else in this file is unit-relative.
 */

import * as ladder from "./ladders/mainnet";

export const DENOMINATIONS: readonly bigint[] = ladder.AMOUNTS;

/** [cols, rows] per denomination index. */
export const GRIDS: readonly (readonly [number, number])[] = [
  [5, 5], // index 0 -> 25 modules
  [4, 5], // index 1 -> 20
  [4, 4], // index 2 -> 16
  [3, 4], // index 3 -> 12
  [3, 3], // index 4 ->  9
  [2, 3], // index 5 ->  6
  [2, 2], // index 6 ->  4
  [1, 2], // index 7 ->  2
  [1, 1], // index 8 ->  1
];

/** Exact display strings. No trailing zeros, by construction. */
export const LABELS: readonly string[] = ladder.LABELS;

/** Index of a supported denomination, or -1. */
export function denominationIndex(amountWei: bigint): number {
  for (let i = 0; i < DENOMINATIONS.length; i++) {
    if (DENOMINATIONS[i] === amountWei) return i;
  }
  return -1;
}

export function isSupportedDenomination(amountWei: bigint): boolean {
  return denominationIndex(amountWei) >= 0;
}

export function gridForAmount(amountWei: bigint): readonly [number, number] {
  const i = denominationIndex(amountWei);
  if (i < 0) throw new Error(`unsupported denomination: ${amountWei}`);
  return GRIDS[i];
}

export function moduleCountForAmount(amountWei: bigint): number {
  const [c, r] = gridForAmount(amountWei);
  return c * r;
}

/** The minimum denomination, in wei. Every denomination is a whole multiple of it. Mirrors
 *  Denominations.sol UNIT. */
export const UNIT = ladder.UNIT;

/** Backing amount for a denomination index, in UNIT multiples. Mirrors
 *  Denominations.sol unitsAt. */
export function unitsAt(index: number): bigint {
  return DENOMINATIONS[index] / UNIT;
}

/** Grid cell count for a denomination index. Mirrors Denominations.sol gridAt (cols * rows). */
export function cellCountAt(index: number): number {
  const [c, r] = GRIDS[index];
  return c * r;
}

export function labelForAmount(amountWei: bigint): string {
  const i = denominationIndex(amountWei);
  if (i < 0) throw new Error(`unsupported denomination: ${amountWei}`);
  return LABELS[i];
}

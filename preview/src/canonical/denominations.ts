/**
 * The nine canonical Shape denominations and the grid each one maps to.
 * These are permanent protocol rules. The table is duplicated verbatim in
 * src/lib/Denominations.sol.
 */

// TESTNET SCALE (sepolia-scaled branch): 100x smaller than the mainnet ladder so the whole system
// is exercisable with faucet ETH — top is 1 ETH, not 100. Mirrors src/lib/Denominations.sol on this
// branch. Restore the mainnet ladder before any mainnet deploy.
export const DENOMINATIONS: readonly bigint[] = [
  100_000_000_000_000n, //   0.0001 ETH
  500_000_000_000_000n, //   0.0005 ETH
  1_000_000_000_000_000n, //  0.001  ETH
  5_000_000_000_000_000n, //  0.005  ETH
  10_000_000_000_000_000n, //  0.01  ETH
  50_000_000_000_000_000n, //  0.05  ETH
  100_000_000_000_000_000n, // 0.1   ETH
  500_000_000_000_000_000n, // 0.5   ETH
  1_000_000_000_000_000_000n, // 1   ETH
];

/** [cols, rows] per denomination index. */
export const GRIDS: readonly (readonly [number, number])[] = [
  [5, 5], // 0.01 -> 25 modules
  [4, 5], // 0.05 -> 20
  [4, 4], // 0.1  -> 16
  [3, 4], // 0.5  -> 12
  [3, 3], // 1    ->  9
  [2, 3], // 5    ->  6
  [2, 2], // 10   ->  4
  [1, 2], // 50   ->  2
  [1, 1], // 100  ->  1
];

/** Exact display strings. No trailing zeros, by construction. */
export const LABELS: readonly string[] = [
  "0.0001",
  "0.0005",
  "0.001",
  "0.005",
  "0.01",
  "0.05",
  "0.1",
  "0.5",
  "1",
];

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
export const UNIT = 100_000_000_000_000n; // 0.0001 ETH (testnet scale)

/** Backing amount for a denomination index, in UNIT (0.01 ETH) multiples. Mirrors
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

/**
 * Canonical fixed-point arithmetic for the Shapes renderer.
 *
 * Every geometric quantity in the canonical renderer is a non-negative integer
 * in WAD units (1e18 = 1.0). All operations floor. Solidity performs the exact
 * same integer operations in the exact same order, so the TypeScript and
 * Solidity renderers agree bit-for-bit by construction rather than by luck.
 *
 * NOTHING in this file (or anything it is used by) may use the JavaScript
 * `number` type. Doubles are not reproducible in the EVM.
 */

export const WAD = 1_000_000_000_000_000_000n; // 1e18

/** Number of fractional decimal digits emitted into SVG coordinates. */
export const OUTPUT_DECIMALS = 6n;

/** 1e18 / 1e6 = 1e12 — one unit in the last emitted place. */
const ULP = 1_000_000_000_000n; // 10 ** (18 - 6)

/** a * b / 1e18, flooring. Both operands must be non-negative. */
export function mulWad(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/** a * 1e18 / b, flooring. */
export function divWad(a: bigint, b: bigint): bigint {
  return (a * WAD) / b;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Canonical decimal formatter.
 *
 * Emits a WAD value with at most OUTPUT_DECIMALS fractional digits, rounding
 * half away from zero, with trailing fractional zeros stripped and no trailing
 * decimal point. This is the single place where geometry becomes text, and it
 * is the reason the two implementations can be compared byte-for-byte.
 *
 *   0                      -> "0"
 *   1_000_000_000_000_000_000 -> "1"
 *   66_421_875_000_000_000_000 -> "66.421875"
 *   -3_500_000_000_000_000n    -> "-0.0035"
 */
export function fmt(v: bigint): string {
  let neg = false;
  let a = v;
  if (a < 0n) {
    neg = true;
    a = -a;
  }
  // round half up at the 6th decimal
  const q = (a + ULP / 2n) / ULP; // integer count of 1e-6 units
  const intPart = q / 1_000_000n;
  let frac = (q % 1_000_000n).toString().padStart(6, "0");
  while (frac.length > 0 && frac.endsWith("0")) frac = frac.slice(0, -1);
  const body = frac.length === 0 ? intPart.toString() : `${intPart}.${frac}`;
  if (body === "0") return "0"; // never emit "-0"
  return neg ? `-${body}` : body;
}

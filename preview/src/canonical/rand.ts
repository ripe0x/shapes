/**
 * The Round 03 deterministic random stream.
 *
 * This is a direct, exact-integer transcription of the PRNG in the Claude
 * Design "Shapes Explorations" Round 03 source:
 *
 *   const rng = seed => {
 *     let a = (seed * 1831565813 + 0x6D2B79F5) >>> 0;
 *     return () => {
 *       a = (a + 0x6D2B79F5) >>> 0;
 *       let x = Math.imul(a ^ (a >>> 15), 1 | a);
 *       x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
 *       return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
 *     };
 *   };
 *
 * Two things are pinned down here that the JavaScript original leaves loose:
 *
 * 1. SEEDING IS EXACT 32-BIT INTEGER ARITHMETIC.
 *    `seed * 1831565813` in JavaScript is a float64 multiply. For seeds above
 *    ~2^22 the product exceeds Number.MAX_SAFE_INTEGER and silently loses low
 *    bits, so the original is not reproducible for large seeds. We define the
 *    canonical seeding as (seed * 1831565813 + 0x6D2B79F5) mod 2^32 computed in
 *    exact integer arithmetic. For every seed the design page actually uses
 *    (1007..2528) the two agree exactly, so Round 03's rendered cards are
 *    reproduced unchanged.
 *
 * 2. DRAWS ARE CONSUMED AS EXACT 32-BIT INTEGERS, NOT FLOATS.
 *    The original returns u32 / 2^32. We keep the u32 and convert to a WAD
 *    fraction with a single flooring divide, so there is no float anywhere.
 *
 * Every operation below is mod 2^32, which is what the JavaScript bitwise
 * operators and Math.imul already implement.
 */

import { WAD } from "./wad";

const M32 = 0xffffffffn;
const TWO32 = 0x100000000n;

/** (a * b) mod 2^32 — the semantics of Math.imul. */
function imul(a: bigint, b: bigint): bigint {
  return (a * b) & M32;
}

export class Round03Rand {
  private a: bigint;
  /** Number of draws taken. Useful for the preview inspector. */
  public draws = 0;

  constructor(seed32: bigint) {
    this.a = (seed32 * 1831565813n + 0x6d2b79f5n) & M32;
  }

  /** Next raw draw, a uniform uint32. */
  nextU32(): bigint {
    this.draws++;
    this.a = (this.a + 0x6d2b79f5n) & M32;
    const a = this.a;
    let x = imul(a ^ (a >> 15n), 1n | a);
    x = ((x + imul(x ^ (x >> 7n), 61n | x)) & M32) ^ x;
    return (x ^ (x >> 14n)) & M32;
  }

  /**
   * Next draw as a WAD fraction in [0, 1).
   * Equivalent to the original's `u32 / 4294967296`, floored to 1e-18.
   */
  next(): bigint {
    return (this.nextU32() * WAD) / TWO32;
  }

  /**
   * Next draw reduced to an integer in [0, n).
   * Equivalent to `Math.floor(rand() * n)` without float rounding: computed
   * directly on the u32 so the bucket edges are exact.
   */
  nextBelow(n: bigint): bigint {
    return (this.nextU32() * n) / TWO32;
  }

  /**
   * True when the next draw falls below `pWad` — i.e. an event of probability exactly `pWad`.
   *
   * Stated this way round rather than as `rand() > threshold` so the endpoints are exact:
   * `p = 0` is never true and `p = 1` is always true, because a draw lies in [0, 1). That
   * matters once the probability itself is drawn per card and is allowed to reach 0 and 1 —
   * a card that says "all solid" must contain no outlined mark at all.
   */
  nextBelowProbability(pWad: bigint): boolean {
    return this.nextU32() * WAD < pWad * TWO32;
  }
}

/**
 * Fold the stored bytes32 token seed into the 32-bit seed the Round 03 stream
 * consumes. The stream's state is 32 bits wide; that is a property of the
 * preserved Round 03 algorithm, not of the token. The full bytes32 remains
 * stored on chain as the token's provenance.
 */
export function seed32Of(seed: bigint): bigint {
  return seed & M32;
}

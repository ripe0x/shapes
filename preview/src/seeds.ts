/**
 * Seed generation for the preview harness.
 *
 * This matters more than it looks. Round 03's PRNG is counter-based: the state
 * advances by 0x6D2B79F5 every draw, and the seeding step multiplies by the
 * *same* constant, so
 *
 *     a(seed, draw) = 0x6D2B79F5 * (seed + draw + 1)  (mod 2^32)
 *
 * Every seed is therefore a window into one shared 2^32-long stream. Rendering
 * a batch from consecutive integer seeds does not sample the design space — it
 * slides a window along a single sequence, producing visibly related cards and
 * an invalid collision test.
 *
 * On chain this never arises: token seeds are keccak256 outputs, so their low
 * 32 bits are uniformly distributed and windows only overlap by coincidence.
 * The preview must emulate that, so `productionSeed` hashes the index exactly
 * the way the contract hashes a batch root with a token id.
 *
 * `rawSeed` is offered for one purpose: reproducing the design page's own cards,
 * which use small consecutive-ish integers.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export type SeedMode = "production" | "raw";

function toBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function toBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

/** keccak256(bytes32(index)) — a realistic, well-mixed token seed. */
export function productionSeed(index: bigint): bigint {
  return toBigInt(keccak_256(toBytes32(index)));
}

/** The index itself, for reproducing the design page. */
export function rawSeed(index: bigint): bigint {
  return index;
}

export function seedAt(index: bigint, mode: SeedMode): bigint {
  return mode === "production" ? productionSeed(index) : rawSeed(index);
}

/**
 * The six seeds the design page shows per band, so the ladder view can be
 * compared against the reference directly.
 *   base = 1000 + bandIndex * 613;  seeds = base + i * 137 + 7
 */
export function designPageSeeds(bandIndex: number): bigint[] {
  const base = 1000 + bandIndex * 613;
  return Array.from({ length: 6 }, (_, i) => BigInt(base + i * 137 + 7));
}

import {renderShape} from "../canonical/render";

/**
 * Render a Shape locally from the canonical renderer — the same code the contract ports — as a
 * data URI. Used for sample previews and for recomposition previews, where the token does not
 * exist yet; artwork is a pure function of (seed, denomination), so these match what the chain
 * would serve.
 */
export function localArt(seed: bigint, amountWei: bigint): string {
  return `data:image/svg+xml;base64,${btoa(renderShape(seed, amountWei, 0n))}`;
}

/**
 * Deterministic seed stream for the sample previews on the mint screen. Not the chain's seed
 * derivation — real seeds are assigned at mint. splitmix64-style mix over a 256-bit lane.
 */
export function sampleSeed(n: number): bigint {
  const MASK = (1n << 256n) - 1n;
  let x = (BigInt(n) * 0x9e3779b97f4a7c15n + 0x243f6a8885a308d3n) & MASK;
  x ^= x >> 29n;
  x = (x * 0xbf58476d1ce4e5b9n) & MASK;
  x ^= x >> 32n;
  x = (x * 0x94d049bb133111ebn) & MASK;
  x ^= x >> 31n;
  return x;
}

import {hexToBytes} from "viem";
import {CANONICAL} from "../canonical/params";
import {DENOMINATIONS} from "../canonical/denominations";
import {renderShape} from "../canonical/render";
import {renderSampledShape} from "../canonical/sampling";

/**
 * Render a Shape locally from the canonical renderer (the code the contract ports) as a data
 * URI. `inkGene` is the token's ink state, which the artwork depends on alongside seed and
 * denomination; the caller supplies the exact gene the chain assigns the token being drawn
 * (`mintGene` for a fresh mint, the parent's gene for a split child, the stored gene for a
 * live token), so the preview matches what the chain serves.
 */
export function localArt(seed: bigint, amountWei: bigint, inkGene: number): string {
  return `data:image/svg+xml;base64,${btoa(renderShape(seed, amountWei, 0n, inkGene))}`;
}

/** The fields the renderer needs for one token, as the indexer stores them. */
export interface ArtToken {
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  /** Materialized module geometry (grammar v2). Null means the geometry derives from the seed. */
  modules: `0x${string}` | null;
  /** A Black Shape draws inverted. */
  isBlack: boolean;
}

/**
 * Render a token from stored state as a data URI, taking the materialized geometry when the token
 * has any and deriving it from the seed otherwise. Geometry is denomination-indexed and identical
 * on both ladders, so a token drawn this way matches what the chain serves for either build.
 */
export function tokenArt(t: ArtToken): string {
  const svg = t.modules
    ? renderSampledShape(hexToBytes(t.modules), t.denomIndex, 0n, t.inkGene, CANONICAL, t.isBlack)
    : renderShape(t.seed, DENOMINATIONS[t.denomIndex], 0n, t.inkGene, CANONICAL, t.isBlack);
  return `data:image/svg+xml;base64,${btoa(svg)}`;
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

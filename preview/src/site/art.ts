import {hexToBytes} from "viem";
import {CANONICAL} from "shapes-render/params";
import {DENOMINATIONS} from "shapes-render/denominations";
import {renderShape} from "shapes-render/render";
import {renderSampledShape} from "shapes-render/sampling";

export {localArt, sampleSeed} from "./mintArt";

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

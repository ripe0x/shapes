/**
 * Adapts an indexer token row into the canonical renderer, with no chain read.
 *
 * `effectiveModuleBytes` already implements the two geometry sources a row can carry: stored
 * module bytes for a composed, split or decomposed token, or the seed's grammar v1 expression at
 * the row's own denomination and ink gene for a plain mint. `renderShapeSvg` picks the source and
 * renders through the same `composeSampledShape` + `svgFromComposition` path either way, so the
 * output matches `Shapes.effectiveModulesOf` plus `svg(tokenId)` byte for byte.
 */

import { hexToBytes } from "viem";
import { CANONICAL, svgFromComposition } from "./render.ts";
import { composeSampledShape, effectiveModuleBytes, type SampleDonor } from "./sampling.ts";
import { DENOMINATIONS, LABELS } from "./denominations.ts";

/** The fields a rendered token needs, matching the indexer's `token` table row shape. */
export interface ShapeRenderState {
  tokenId: bigint;
  seed: `0x${string}`;
  denomIndex: number;
  inkGene: number;
  /** Materialized module bytes, hex-encoded. Absent or empty means seed-derived geometry. */
  modules?: `0x${string}` | null;
  isBlack: boolean;
}

/** Renders the exact SVG document the contract's `svg(tokenId)` returns for this row. */
export function renderShapeSvg(state: ShapeRenderState): string {
  requireDenomIndex(state.denomIndex);
  const donor: SampleDonor = {
    seed: BigInt(state.seed),
    denomIndex: state.denomIndex,
    inkGene: state.inkGene,
    modules: state.modules && state.modules !== "0x" ? hexToBytes(state.modules) : undefined,
  };
  const bytes = effectiveModuleBytes(donor);
  const composition = composeSampledShape(bytes, state.denomIndex, state.inkGene);
  return svgFromComposition(composition, state.tokenId, CANONICAL, state.isBlack);
}

/** The denomination label ("0.01 ETH", ...) for a row's `denomIndex`. */
export function denominationLabel(denomIndex: number): string {
  requireDenomIndex(denomIndex);
  return `${LABELS[denomIndex]} ETH`;
}

function requireDenomIndex(denomIndex: number): void {
  if (!Number.isInteger(denomIndex) || denomIndex < 0 || denomIndex >= DENOMINATIONS.length) {
    throw new Error(`denomIndex out of range 0..${DENOMINATIONS.length - 1}: ${denomIndex}`);
  }
}

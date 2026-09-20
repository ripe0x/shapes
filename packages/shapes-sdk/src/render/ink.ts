/**
 * Ink Genes — canonical TypeScript reference.
 *
 * This file is the single source of truth for gene assignment. `src/lib/InkGenes.sol` is a
 * direct port of it: same constant tables, same hashing, same integer arithmetic. The parity
 * suite asserts the two agree byte for byte, the same way `denominations.ts` and
 * `Denominations.sol` are kept in lockstep.
 *
 * See INK_GENES_IMPL_SPEC.md for the pinned formulas this file implements, and
 * INK_GENES_DRAFT.md for the design rationale.
 *
 * All hashing is `keccak256` over `abi.encodePacked` with the exact argument types Solidity
 * would use. `encodePacked`/`keccak256` here come from viem, the same helper
 * `decomposeSeed.ts` uses for the same reason: byte-for-byte identical encoding to Solidity is
 * required, not merely similar.
 */

import { encodePacked, keccak256 } from "viem";

export const GENE_COUNT = 7;

export const VOID = 0;
export const FAINT = 1;
export const SPARSE = 2;
export const MURK = 3;
export const DENSE = 4;
export const RICH = 5;
export const SOLID = 6;

const WAD = 1_000_000_000_000_000_000n;

/** Rendered solid probability per gene, WAD (1e18). Mirrors `InkGenes.geneProbabilityAt`. */
export const GENE_PROBABILITY: readonly bigint[] = [
  0n, // Void
  (WAD * 15n) / 100n, // Faint
  (WAD * 35n) / 100n, // Sparse
  (WAD * 50n) / 100n, // Murk
  (WAD * 65n) / 100n, // Dense
  (WAD * 85n) / 100n, // Rich
  WAD, // Solid
];

/** Gene names, for the metadata trait. Mirrors `InkGenes.geneNameAt`. */
export const GENE_NAMES: readonly string[] = [
  "Void",
  "Faint",
  "Sparse",
  "Murk",
  "Dense",
  "Rich",
  "Solid",
];

/** `{gene, units}` over the multiset a compose pools together. Documentary only: `geneAtCompose`
 *  takes the pool statistics (`best`, `worst`, `center`) as scalars, already reduced from this
 *  shape, the same way `InkGenes.InkInput` is declared but not consumed as an array on chain
 *  (the compose loop folds inline over live storage). Kept here so a caller reducing a pool in
 *  TypeScript has a named shape to reduce from. */
export interface InkInput {
  gene: number;
  units: bigint;
}

function seedHex(v: bigint): `0x${string}` {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

/** keccak256(abi.encodePacked(...)), reduced to a uint256 bigint. */
function packedKeccakUint(
  types: readonly string[],
  values: readonly unknown[],
): bigint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return BigInt(keccak256(encodePacked(types as any, values as any)));
}

/**
 * Gene assigned at mint: a pure function of the token's seed and denomination tier. Mirrors
 * `InkGenes.geneAtMint`.
 *
 *   r = uint256(keccak256(abi.encodePacked("ink:mint", seed))) % 100
 *
 * Dust (denomIndex 0) draws the full seven-gene lottery; every other direct mint draws only
 * the narrow {Sparse, Murk, Dense} band. The extremes (Void, Faint, Rich, Solid) enter the
 * population only through a dust mint (INK_GENES_DRAFT.md §2).
 */
export function geneAtMint(seed: bigint, denomIndex: number): number {
  const r =
    packedKeccakUint(["string", "bytes32"], ["ink:mint", seedHex(seed)]) %
    100n;

  if (denomIndex === 0) {
    if (r < 3n) return VOID;
    if (r < 10n) return FAINT;
    if (r < 25n) return SPARSE;
    if (r < 75n) return MURK;
    if (r < 90n) return DENSE;
    if (r < 97n) return RICH;
    return SOLID;
  }

  if (r < 20n) return SPARSE;
  if (r < 80n) return MURK;
  return DENSE;
}

/**
 * Units-weighted mean gene over the multiset {survivor + all burns}, rounded half up. Mirrors
 * `InkGenes.center` (impl spec §2.3).
 *
 *   center = (2*sumW + U) / (2*U)      // integer division
 *
 * `sumW = Σ gene_i × units_i`, `U = Σ units_i`, both accumulated by the caller over the pool.
 */
export function centerGene(sumW: bigint, unitsTotal: bigint): number {
  return Number((2n * sumW + unitsTotal) / (2n * unitsTotal));
}

/**
 * The per-tier compose walk. Mirrors `InkGenes.geneAtCompose`.
 *
 * `burnSeedFold` is the XOR of every burned token's `uint256(seed)`, so the order `burnIds`
 * arrive in cannot affect the result — XOR is commutative and associative, so any permutation
 * folds to the same value. Fresh entropy is forbidden: `R` and every per-tier roll are pure
 * functions of the arguments alone.
 */
export function geneAtCompose(
  survivorSeed: bigint,
  burnSeedFold: bigint,
  survivorGene: number,
  oldIndex: number,
  newIndex: number,
  best: number,
  worst: number,
  center: number,
): number {
  const R = packedKeccakUint(
    ["string", "bytes32", "uint256", "uint8"],
    ["ink:compose", seedHex(survivorSeed), burnSeedFold, newIndex],
  );
  const Rhex = seedHex(R);

  let g = survivorGene;
  const T = newIndex - oldIndex; // always >= 1
  for (let k = 1; k <= T; k++) {
    const roll = packedKeccakUint(["bytes32", "uint256"], [Rhex, BigInt(k)]) % 100n;
    const target = roll < 70n ? center : roll < 90n ? best : worst;
    if (g < target) g += 1;
    else if (g > target) g -= 1;
    // equal: unchanged
  }
  return g;
}

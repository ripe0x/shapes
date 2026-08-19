/**
 * Preview-only ink-gene helpers.
 *
 * The canonical renderer (`canonical/render.ts`) requires an explicit `inkGene` for every card,
 * because a Shape's ink is on-chain state, not a pure function of its seed. Each preview must
 * therefore supply the exact gene the chain would assign the token it is drawing:
 *
 *   - a freshly minted card       -> `mintGene(seed, amountWei)`   (geneAtMint)
 *   - a split child preview       -> the parent token's gene       (split copies it verbatim)
 *   - a compose result preview    -> the walked gene               (mirror compose's pool + walk)
 *   - a live/historical token     -> its stored gene, read from the tokenURI "Ink" trait
 *
 * These helpers cover the first and last cases. The middle two are computed at their call sites.
 */

import { geneAtMint, GENE_NAMES } from "./canonical/ink";
import { denominationIndex } from "./canonical/denominations";

/** The gene the chain assigns a freshly minted card at (seed, denomination). */
export function mintGene(seed: bigint, amountWei: bigint): number {
  return geneAtMint(seed, denominationIndex(amountWei));
}

/** Gene index from an on-chain "Ink" trait value (a gene name). Throws on an unknown name. */
export function geneIndexOfName(name: string): number {
  const i = GENE_NAMES.indexOf(name);
  if (i < 0) throw new Error(`unknown ink gene name: ${name}`);
  return i;
}

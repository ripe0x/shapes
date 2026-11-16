/** Mirrors ShapePacks._pop: a claimant keeps the remaining Shapes until the last claim. */
export function afterPackClaim(
  packId: bigint,
  claimant: `0x${string}`,
  current: bigint,
  claimed: number,
): {claimant: `0x${string}` | null; remainingCount: bigint} {
  const remainingCount = current - BigInt(claimed);
  if (claimed === 0 || remainingCount < 0n) {
    throw new Error(`Shapes indexer: Pack ${packId} claim count exceeds its remaining contents`);
  }
  return {claimant: remainingCount === 0n ? null : claimant, remainingCount};
}

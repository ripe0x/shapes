// The nine backing denominations, in wei, indexed 0..8. Mirrors src/lib/Denominations.sol and
// preview/src/chain/abi.ts's DENOMINATIONS. Index in storage is the denomination, not the wei
// amount, so an out-of-ladder backing value is unrepresentable in the contract; the indexer
// mirrors the same ladder to turn a decoded `denomIndex` back into wei and vice versa.
export const DENOMINATIONS_WEI: readonly bigint[] = [
  10_000_000_000_000_000n, // 0.01 ETH
  50_000_000_000_000_000n, // 0.05 ETH
  100_000_000_000_000_000n, // 0.1 ETH
  500_000_000_000_000_000n, // 0.5 ETH
  1_000_000_000_000_000_000n, // 1 ETH
  5_000_000_000_000_000_000n, // 5 ETH
  10_000_000_000_000_000_000n, // 10 ETH
  50_000_000_000_000_000_000n, // 50 ETH
  100_000_000_000_000_000_000n, // 100 ETH
];

// Wei amount for a denomination index. Throws on an index outside 0..8, since that indicates a
// decoding bug rather than a valid contract state.
export function backingForDenomIndex(denomIndex: number): bigint {
  const wei = DENOMINATIONS_WEI[denomIndex];
  if (wei === undefined) {
    throw new Error(`Shapes indexer: denomination index ${denomIndex} is out of range 0..8`);
  }
  return wei;
}

// Denomination index for a wei amount, or -1 if it does not land on the ladder.
export function denomIndexOfWei(amountWei: bigint): number {
  return DENOMINATIONS_WEI.findIndex((wei) => wei === amountWei);
}

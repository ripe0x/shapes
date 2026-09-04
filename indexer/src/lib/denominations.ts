// The nine backing denominations, in wei, indexed 0..8. Compiled into the deployed contract and
// immutable there; mirrors ladders/mainnet/Ladder.sol.
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

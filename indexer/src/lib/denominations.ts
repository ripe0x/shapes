// The nine backing denominations, in wei, indexed 0..8. The deployed contract selects one ladder
// at compile time, so the indexer must be told which immutable ladder that address uses.
export const MAINNET_DENOMINATIONS_WEI: readonly bigint[] = [
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

export const TESTNET_DENOMINATIONS_WEI: readonly bigint[] = [
  100_000_000_000_000n, // 0.0001 ETH
  500_000_000_000_000n, // 0.0005 ETH
  1_000_000_000_000_000n, // 0.001 ETH
  5_000_000_000_000_000n, // 0.005 ETH
  10_000_000_000_000_000n, // 0.01 ETH
  50_000_000_000_000_000n, // 0.05 ETH
  100_000_000_000_000_000n, // 0.1 ETH
  500_000_000_000_000_000n, // 0.5 ETH
  1_000_000_000_000_000_000n, // 1 ETH
];

export function denominationsForLadder(ladder: string | undefined): readonly bigint[] {
  if (ladder === undefined || ladder === "mainnet") return MAINNET_DENOMINATIONS_WEI;
  if (ladder === "testnet") return TESTNET_DENOMINATIONS_WEI;
  throw new Error(`Shapes indexer: unsupported SHAPES_LADDER ${ladder}`);
}

export const DENOMINATIONS_WEI = denominationsForLadder(process.env.SHAPES_LADDER);

// Wei amount for a denomination index. Throws on an index outside 0..8, since that indicates a
// decoding bug rather than a valid contract state.
export function backingForDenomIndex(
  denomIndex: number,
  denominations: readonly bigint[] = DENOMINATIONS_WEI,
): bigint {
  const wei = denominations[denomIndex];
  if (wei === undefined) {
    throw new Error(`Shapes indexer: denomination index ${denomIndex} is out of range 0..8`);
  }
  return wei;
}

// Denomination index for a wei amount, or -1 if it does not land on the ladder.
export function denomIndexOfWei(
  amountWei: bigint,
  denominations: readonly bigint[] = DENOMINATIONS_WEI,
): number {
  return denominations.findIndex((wei) => wei === amountWei);
}

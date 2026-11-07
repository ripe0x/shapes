/**
 * The mainnet denomination ladder: nine backing amounts and their display strings.
 * Mirrors ladders/mainnet/Ladder.sol, and the parity suite asserts the two agree.
 */

export const AMOUNTS: readonly bigint[] = [
  10_000_000_000_000_000n, //     0.01 ETH
  50_000_000_000_000_000n, //     0.05 ETH
  100_000_000_000_000_000n, //    0.1  ETH
  500_000_000_000_000_000n, //    0.5  ETH
  1_000_000_000_000_000_000n, //    1  ETH
  5_000_000_000_000_000_000n, //    5  ETH
  10_000_000_000_000_000_000n, //  10  ETH
  50_000_000_000_000_000_000n, //  50  ETH
  100_000_000_000_000_000_000n, // 100 ETH
];

export const LABELS: readonly string[] = ["0.01", "0.05", "0.1", "0.5", "1", "5", "10", "50", "100"];

export const UNIT = 10_000_000_000_000_000n; // 0.01 ETH

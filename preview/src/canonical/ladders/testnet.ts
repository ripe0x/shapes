/**
 * The testnet denomination ladder: the mainnet amounts scaled down 100x, which puts the apex
 * within reach of faucet ETH. Mirrors ladders/testnet/Ladder.sol.
 */

export const AMOUNTS: readonly bigint[] = [
  100_000_000_000_000n, //       0.0001 ETH
  500_000_000_000_000n, //       0.0005 ETH
  1_000_000_000_000_000n, //     0.001  ETH
  5_000_000_000_000_000n, //     0.005  ETH
  10_000_000_000_000_000n, //    0.01   ETH
  50_000_000_000_000_000n, //    0.05   ETH
  100_000_000_000_000_000n, //   0.1    ETH
  500_000_000_000_000_000n, //   0.5    ETH
  1_000_000_000_000_000_000n, // 1      ETH
];

export const LABELS: readonly string[] = [
  "0.0001",
  "0.0005",
  "0.001",
  "0.005",
  "0.01",
  "0.05",
  "0.1",
  "0.5",
  "1",
];

export const UNIT = 100_000_000_000_000n; // 0.0001 ETH

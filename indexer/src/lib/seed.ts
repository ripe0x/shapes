import { encodePacked, keccak256 } from "viem";

// Derives a decompose child's seed the same way Shapes.sol does in `decompose`:
// `keccak256(abi.encodePacked(parentSeed, i))`, where `i` is the child's position (uint256) in
// the output list. Deterministic from the parent seed alone, so a child's seed is predictable
// a claimed child set with no per-child storage on chain.
export function childSeedOf(parentSeed: `0x${string}`, index: number): `0x${string}` {
  return keccak256(encodePacked(["bytes32", "uint256"], [parentSeed, BigInt(index)]));
}

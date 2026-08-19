import {encodePacked, keccak256} from "viem";

/**
 * The seed a split assigns to its i-th child: `keccak256(abi.encodePacked(parentSeed, i))`,
 * mirroring `Shapes.split`. No block data enters, so the whole split tree is fixed the
 * moment the parent exists and the frontend can preview a split's children before their token
 * ids are known. Parity with the Solidity derivation is asserted in test/Parity.t.sol against
 * fixtures generated from this function.
 */
export function splitChildSeed(parentSeed: bigint, index: number | bigint): bigint {
  const seedHex = `0x${parentSeed.toString(16).padStart(64, "0")}` as `0x${string}`;
  const packed = encodePacked(["bytes32", "uint256"], [seedHex, BigInt(index)]);
  return BigInt(keccak256(packed));
}

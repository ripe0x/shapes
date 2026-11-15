import { parseAbi } from "viem";

// Lifecycle events from the verified ShapePacks contract on mainnet. PackUnsealed also fires
// inside open/redeem; the later claim event replaces its feed row in those transactions.
export const shapePacksAbi = parseAbi([
  "event PackCreated(uint256 indexed packId, address indexed creator, address indexed to, uint256[] shapeIds, uint256 pulledCount, uint256 valueWei)",
  "event PackExtended(uint256 indexed packId, address indexed by, uint256[] shapeIds, uint256 pulledCount, uint256 addedValueWei, uint256 valueWei)",
  "event PackMerged(uint256 indexed targetPackId, uint256 indexed sourcePackId, address indexed by, uint256[] shapeIds, uint256 addedValueWei, uint256 valueWei)",
  "event PackUnsealed(uint256 indexed packId, address indexed owner, address indexed claimant, uint256 count)",
  "event ShapesClaimed(uint256 indexed packId, address indexed to, uint256[] shapeIds)",
  "event EthClaimed(uint256 indexed packId, address indexed recipient, uint256[] shapeIds, uint256 valueWei)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

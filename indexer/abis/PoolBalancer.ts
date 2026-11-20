import { parseAbi } from "viem";

// Events from the verified BalancerFactory and PoolBalancer contracts on mainnet
// (github.com/ripe0x/shapes-pool-balancer, src/). Only the events the pool dashboard reads.
export const balancerFactoryAbi = parseAbi([
  "event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)",
  "event DefaultPolicyChanged(address indexed previousPolicy, address indexed newPolicy)",
]);

export const poolBalancerAbi = parseAbi([
  "event CreatorTransferred(address indexed oldCreator, address indexed newCreator)",
  "event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)",
  "event Deposited(address indexed from, uint256 amount)",
  "event SurplusClaimed(address indexed to, uint256 amount)",
  "event ProceedsCollected(uint256 amount)",
  "event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed)",
  "event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost)",
  "event CuratedListed(uint256 indexed listingId, address indexed collection, uint256 tokenId, uint256 base, uint256 price)",
  "event CuratedRepriced(uint256 indexed listingId, uint256 base, uint256 price)",
]);

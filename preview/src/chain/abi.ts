import {parseAbi} from "viem";

// The subset of the Shapes ERC721 the chain tester calls. Human-readable form; viem parses it
// to the full ABI at import.
export const shapesAbi = parseAbi([
  "function mint(uint256 amountWei, address to) payable returns (uint256 tokenId)",
  "function mintBatch(uint256 amountWei, uint256 quantity, address to) payable returns (uint256 firstTokenId)",
  "function redeem(uint256 tokenId)",
  "function redeemBatch(uint256[] tokenIds) returns (uint256 totalWei)",
  "function compose(uint256 survivorId, uint256[] burnIds) returns (uint256)",
  "function decompose(uint256 tokenId, uint8[] outDenoms) returns (uint256[] newIds)",
  "function blacken(uint256 tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function seedOf(uint256 tokenId) view returns (bytes32)",
  "function originCountOf(uint256 tokenId) view returns (uint256)",
  "function isComplete(uint256 tokenId) view returns (bool)",
  "function isBlack(uint256 tokenId) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function redeemableBacking() view returns (uint256)",
  "function sacrificedBacking() view returns (uint256)",
  "function blackCount() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function mintFeeFor(uint256 amountWei) view returns (uint256)",
  "event ShapeMinted(uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount)",
  "event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei)",
  "event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 newDenomIndex, uint32 originCount)",
  "event Decomposed(uint256 indexed tokenId, uint256[] newIds, uint8[] outDenoms, uint32[] originCounts)",
  "event Blackened(uint256 indexed tokenId, uint256 sacrificedWei)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export interface Deployment {
  rpc: string;
  chainId: number;
  shapes: `0x${string}`;
  renderer: `0x${string}`;
  feeBps: string;
}

// The nine denominations, in wei, with their display labels. Mirrors src/lib/Denominations.sol.
export const DENOMINATIONS: {label: string; wei: bigint}[] = [
  {label: "0.01", wei: 10_000_000_000_000_000n},
  {label: "0.05", wei: 50_000_000_000_000_000n},
  {label: "0.1", wei: 100_000_000_000_000_000n},
  {label: "0.5", wei: 500_000_000_000_000_000n},
  {label: "1", wei: 1_000_000_000_000_000_000n},
  {label: "5", wei: 5_000_000_000_000_000_000n},
  {label: "10", wei: 10_000_000_000_000_000_000n},
  {label: "50", wei: 50_000_000_000_000_000_000n},
  {label: "100", wei: 100_000_000_000_000_000_000n},
];

// Index of a supported denomination amount, or -1.
export function denomIndexOf(wei: bigint): number {
  return DENOMINATIONS.findIndex((d) => d.wei === wei);
}

export function denomLabel(wei: bigint): string {
  const i = denomIndexOf(wei);
  return i < 0 ? `${wei} wei` : DENOMINATIONS[i].label;
}

import {parseAbi} from "viem";

// The subset of the Shapes ERC721 the chain tester calls. Human-readable form; viem parses it
// to the full ABI at import.
export const shapesAbi = parseAbi([
  "function mint(uint256 amountWei, address to) payable returns (uint256 tokenId)",
  "function mintBatch(uint256 amountWei, uint256 quantity, address to) payable returns (uint256 firstTokenId)",
  "function redeem(uint256 tokenId)",
  "function redeemBatch(uint256[] tokenIds) returns (uint256 totalWei)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function seedOf(uint256 tokenId) view returns (bytes32)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function totalBacking() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function mintFeeFor(uint256 amountWei) view returns (uint256)",
  "event ShapeMinted(uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed)",
  "event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei)",
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

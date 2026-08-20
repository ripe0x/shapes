import {parseAbi} from "viem";

// The subset of the Shapes ERC721 the chain tester calls. Human-readable form; viem parses it
// to the full ABI at import.
export const shapesAbi = parseAbi([
  "struct ComposeCall { uint256 survivorId; uint256[] burnIds; }",
  "struct ShapeChildPreview { bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; uint256 faceValueWei; }",
  "struct ShapeRevivalPreview { uint256 tokenId; bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; uint256 faceValueWei; }",
  "function mint(uint256 amountWei) payable returns (uint256 tokenId)",
  "function mintTo(uint256 amountWei, address to) payable returns (uint256 tokenId)",
  "function mintBatch(uint256 amountWei, uint256 quantity) payable returns (uint256 firstTokenId)",
  "function mintBatchTo(uint256 amountWei, uint256 quantity, address to) payable returns (uint256 firstTokenId)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function redeem(uint256 tokenId)",
  "function redeemBatch(uint256[] tokenIds) returns (uint256 totalWei)",
  "function compose(uint256 survivorId, uint256[] burnIds) returns (uint256 outId)",
  "function composeMany(ComposeCall[] calls) returns (uint256[] outIds)",
  "function decompose(uint256 survivorId) returns (uint256[] restoredIds)",
  "function decomposeTo(uint256 survivorId, address recipient) returns (uint256[] restoredIds)",
  "function decomposeMany(uint256[] survivorIds) returns (uint256[][] restoredIds)",
  "function decomposeManyTo(uint256[] survivorIds, address recipient) returns (uint256[][] restoredIds)",
  "function split(uint256 tokenId, uint8[] outDenoms) returns (uint256[] newIds)",
  "function splitTo(uint256 tokenId, uint8[] outDenoms, address recipient) returns (uint256[] newIds)",
  "function composeDepth(uint256 survivorId) view returns (uint256)",
  "function previewSplit(uint256 tokenId, uint8[] outDenoms) view returns (ShapeChildPreview[] children)",
  "function previewDecompose(uint256 survivorId) view returns (ShapeRevivalPreview[] inputs)",
  "function sacrifice(uint256 tokenId)",
  "function burn(uint256 tokenId)",
  "function valueOf(uint256 tokenId) view returns (uint256)",
  "function positionResolver() view returns (address)",
  "function positionResolverLocked() view returns (bool)",
  "function setPositionResolver(address resolver)",
  "function lockPositionResolver()",
  "function positionOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function unicodeCard(uint256 tokenId) view returns (string)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function seedOf(uint256 tokenId) view returns (bytes32)",
  "function originCountOf(uint256 tokenId) view returns (uint256)",
  "function inkGeneOf(uint256 tokenId) view returns (uint8)",
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
  "event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount)",
  "event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint32 originCount)",
  "event Decomposed(uint256 indexed survivorId, uint256[] restoredIds, uint8 survivorDenomIndex, uint32 survivorOriginCount)",
  "event Split(uint256 indexed tokenId, bytes32 indexed parentSeed, uint256[] newIds, uint8[] outDenoms, uint32[] originCounts)",
  "event ShapeRevived(uint256 indexed survivorId, uint256 indexed revivedId)",
  "event Blackened(uint256 indexed tokenId, uint256 sacrificedWei)",
  "event PositionResolverSet(address indexed resolver)",
  "event PositionResolverLocked(address indexed resolver)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  // Custom errors from IShapes.sol, so a revert decodes to a named error instead of raw bytes.
  "error UnsupportedDenomination(uint256 amountWei)",
  "error IncorrectPayment(uint256 expected, uint256 provided)",
  "error ZeroQuantity()",
  "error NotShapeOwner(uint256 tokenId, address caller)",
  "error EthTransferFailed(address to, uint256 amountWei)",
  "error MintFeeTransferFailed(address recipient, uint256 amountWei)",
  "error DirectDepositRejected()",
  "error SelfCustodyRejected(uint256 tokenId)",
  "error RendererIsLocked()",
  "error TokenIsBlack(uint256 tokenId)",
  "error InvalidPositionResolver()",
  "error PositionResolverIsLocked()",
  "error EmptyRecomposition()",
  "error CannotComposeWithSelf(uint256 tokenId)",
  "error SplitMismatch(uint256 inputBacking, uint256 outputSum)",
  "error NoComposeRecord(uint256 survivorId)",
  "error NotApexComplete(uint256 tokenId)",
]);

export interface Deployment {
  rpc: string;
  chainId: number;
  shapes: `0x${string}`;
  renderer: `0x${string}`;
  collection?: `0x${string}`;
  auctionHouse?: `0x${string}`;
  feeBps: string;
  /** Block the contract was deployed at. Log scans start here; a public RPC rejects a scan from
   *  block 0 as too wide. Omitted on a local dev chain, where the whole range is tiny. */
  fromBlock?: number;
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

/** The auction house surface the site drives: opening state, bidding, and the two pulls. */
export const auctionHouseAbi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function auctions(uint256 auctionId) view returns ((address seller, address nft, uint256 tokenId, uint64 endTime, uint64 duration, uint32 extensionWindow, uint16 minIncrementBps, uint64 reserveUnits, uint64 highestUnits, address highestBidder, bool settled))",
  "function bidUnits(uint256 auctionId, address bidder) view returns (uint64)",
  "function escrowedCards(uint256 auctionId, address bidder) view returns (uint256[])",
  "function minimumBid(uint256 auctionId) view returns (uint64)",
  "function cardsFor(uint256 backingWei) pure returns (uint256[9])",
  "function bid(uint256 auctionId, uint256[] cardIds, uint256 ethBackingWei) payable",
  "function withdraw(uint256 auctionId)",
  "function settle(uint256 auctionId)",
  "function claimProceeds(uint256 auctionId)",
  "error AuctionNotFound(uint256 auctionId)",
  "error AuctionOver(uint256 auctionId)",
  "error AuctionStillRunning(uint256 auctionId)",
  "error AuctionAlreadySettled(uint256 auctionId)",
  "error InvalidAuction()",
  "error EmptyBid()",
  "error WorthlessCard(uint256 tokenId)",
  "error TooManyCards(uint256 provided)",
  "error NotAUnitMultiple(uint256 backingWei)",
  "error IncorrectPayment(uint256 expected, uint256 provided)",
  "error BidTooLow(uint64 provided, uint64 required)",
  "error NothingToWithdraw(uint256 auctionId, address bidder)",
  "error UnsolicitedToken(address from)",
]);

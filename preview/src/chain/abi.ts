import {parseAbi} from "viem";
import {DENOMINATIONS as CANONICAL_AMOUNTS, LABELS as CANONICAL_LABELS} from "../canonical/denominations";

// The subset of the Shapes ERC721 the chain tester calls. Human-readable form; viem parses it
// to the full ABI at import. `shapeState`, `previewCompose`, `previewSplit`, `unicodeCard`,
// `composeRecordAt`, `splitOriginOf`, `exists`, `positionOf` and the raw denomination-grid/
// support lookups moved to `ShapeLens` (see `shapeLensAbi` below) and are not declared here.
export const shapesAbi = parseAbi([
  "struct ComposeCall { uint256 survivorId; uint256[] burnIds; }",
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
  "function sacrifice(uint256 tokenId)",
  "function burn(uint256 tokenId)",
  "function valueOf(uint256 tokenId) view returns (uint256)",
  "function denomIndexOf(uint256 tokenId) view returns (uint8)",
  "function isComplete(uint256 tokenId) view returns (bool)",
  "function childSeed(bytes32 parentSeed, uint256 childIndex) pure returns (bytes32)",
  "function denominationAt(uint8 index) pure returns (uint256)",
  "function denominationCount() pure returns (uint8)",
  "function unit() pure returns (uint256)",
  "function owner() view returns (address)",
  "function artist() view returns (address)",
  "function artistReleaseHash() view returns (bytes32)",
  "function artistSignature() view returns (bytes)",
  "function artistAttestationDigest(bytes32 releaseHash) view returns (bytes32)",
  "function attestArtist(bytes32 releaseHash, bytes signature)",
  "function admin() view returns (address)",
  "function transferAdmin(address newAdmin)",
  "function renounceAdmin()",
  "function feeRecipient() view returns (address)",
  "function setFeeRecipient(address newRecipient)",
  "function positions() view returns (address target, bool locked)",
  "function market() view returns (address target, bool locked)",
  "function setPointer(uint8 pointer, address target)",
  "function lockPointer(uint8 pointer)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function seedOf(uint256 tokenId) view returns (bytes32)",
  "function originCountOf(uint256 tokenId) view returns (uint256)",
  "function inkGeneOf(uint256 tokenId) view returns (uint8)",
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
  "event PositionsSet(address indexed positions)",
  "event PositionsLocked(address indexed positions)",
  "event MarketSet(address indexed market)",
  "event MarketLocked(address indexed market)",
  "event AdminTransferred(address indexed previousAdmin, address indexed newAdmin)",
  "event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient)",
  "event ArtistAttested(address indexed artist, bytes32 indexed releaseHash, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  // Custom errors from IShapes.sol, so a revert decodes to a named error instead of raw bytes.
  "error UnsupportedDenomination(uint256 amountWei)",
  "error IncorrectPayment(uint256 expected, uint256 provided)",
  "error ZeroQuantity()",
  "error ArtistAlreadyAttested()",
  "error InvalidArtistReleaseHash()",
  "error InvalidArtistSignature()",
  "error NotShapeOwner(uint256 tokenId, address caller)",
  "error EthTransferFailed(address to, uint256 amountWei)",
  "error MintFeeTransferFailed(address recipient, uint256 amountWei)",
  "error DirectDepositRejected()",
  "error SelfCustodyRejected(uint256 tokenId)",
  "error RendererIsLocked()",
  "error TokenIsBlack(uint256 tokenId)",
  "error InvalidPointerTarget()",
  "error PointerIsLocked()",
  "error InvalidPointer()",
  "error AdminInvalidFeeRecipient(address recipient)",
  "error EmptyRecomposition()",
  "error CannotComposeWithSelf(uint256 tokenId)",
  "error SplitMismatch(uint256 inputBacking, uint256 outputSum)",
  "error NoComposeRecord(uint256 survivorId)",
  "error NotApexComplete(uint256 tokenId)",
  "error ComposeRecordOutOfRange(uint256 survivorId, uint256 depth, uint256 depthAvailable)",
  "error NotASplitChild(uint256 tokenId)",
  "error DuplicateComposeInput(uint256 tokenId)",
]);

// ShapeLens: the read-only periphery holding `shapeState`, `previewCompose`, `previewSplit`,
// `unicodeCard`, `composeRecordAt` and `splitOriginOf`, moved off `Shapes` to keep the token's
// runtime bytecode under the EIP-170 size limit. Deployed separately; see `Deployment.lens`.
export const shapeLensAbi = parseAbi([
  "struct ShapeChildPreview { bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; uint256 faceValueWei; }",
  "struct ShapeState { bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bool isBlack; uint8 formation; uint256 faceValueWei; uint256 redeemableValueWei; bytes modules; }",
  "struct ComposeInputView { uint256 id; bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bytes modules; }",
  "struct ComposeRecordView { uint8 survivorDenominationIndex; uint32 survivorOriginCount; uint8 survivorInkGene; bytes survivorModules; ComposeInputView[] inputs; }",
  "function previewCompose(uint256 survivorId, uint256[] burnIds) view returns (ShapeState result)",
  "function previewSplit(uint256 tokenId, uint8[] outDenoms) view returns (ShapeChildPreview[] children)",
  "function shapeState(uint256 tokenId) view returns (ShapeState)",
  "function unicodeCard(uint256 tokenId) view returns (string)",
  "function composeRecordAt(uint256 survivorId, uint256 depth) view returns (ComposeRecordView)",
  "function splitOriginOf(uint256 childId) view returns (bytes32 parentSeed, uint256 parentId, uint8 parentDenomIndex, uint8 originDenomIndex, uint8 parentInkGene, bytes parentModules, uint256 childIndex)",
  "function exists(uint256 tokenId) view returns (bool)",
  "function positionOf(uint256 tokenId) view returns (address)",
  "function isSupportedDenomination(uint256 amountWei) pure returns (bool)",
  "function gridForAmount(uint256 amountWei) pure returns (uint256 cols, uint256 rows)",
  "function modulesForAmount(uint256 amountWei) pure returns (uint256)",
  // Custom errors, from IShapes.sol, that previewCompose/previewSplit/composeRecordAt apply the
  // same validation as the mutating calls and revert with, so a revert decodes to a named error.
  "error CannotComposeWithSelf(uint256 tokenId)",
  "error ComposeRecordOutOfRange(uint256 survivorId, uint256 depth, uint256 depthAvailable)",
  "error DenominationIndexOutOfRange(uint256 index)",
  "error DuplicateComposeInput(uint256 tokenId)",
  "error EmptyRecomposition()",
  "error SplitMismatch(uint256 inputBacking, uint256 outputSum)",
  "error TokenIsBlack(uint256 tokenId)",
  "error UnsupportedDenomination(uint256 amountWei)",
]);

export interface Deployment {
  rpc: string;
  chainId: number;
  shapes: `0x${string}`;
  /** Optional Ponder GraphQL origin. When healthy and within the site's freshness budget,
   *  gallery rows come from this indexer while chain reads remain the correctness fallback. */
  indexerUrl?: string;
  /** Permanent deployer attribution. Optional while deployment metadata still targets a
   *  pre-attribution contract; the site also attempts to read it directly from Shapes. */
  artist?: `0x${string}`;
  /** ShapeLens: the read-only periphery contract. The DNA/provenance section and other
   *  lens-backed reads have nothing to call without it; see the per-call fallbacks in
   *  `site/dna.ts` and `site/TokenView.tsx` for what happens when it is absent from
   *  `deployment.json` (a stale file from before the lens split). */
  lens: `0x${string}`;
  renderer: `0x${string}`;
  collection?: `0x${string}`;
  auctionHouse?: `0x${string}`;
  feeBps: string;
  /** Block the contract was deployed at. Log scans start here; a public RPC rejects a scan from
   *  block 0 as too wide. Omitted on a local dev chain, where the whole range is tiny. */
  fromBlock?: number;
}

// The nine denominations, in wei, with their display labels. Derived from the canonical table so
// the two cannot drift; that table is ladder-selected at build time and parity-tested against
// src/lib/Denominations.sol.
export const DENOMINATIONS: {label: string; wei: bigint}[] = CANONICAL_AMOUNTS.map((wei, i) => ({
  label: CANONICAL_LABELS[i],
  wei,
}));

// Index of a supported denomination amount, or -1.
export function denomIndexOf(wei: bigint): number {
  return DENOMINATIONS.findIndex((d) => d.wei === wei);
}

export function denomLabel(wei: bigint): string {
  const i = denomIndexOf(wei);
  return i < 0 ? `${wei} wei` : DENOMINATIONS[i].label;
}

/** The auction house surface the site drives: opening state, bidding, and the two pulls. */
// `Auction` gained `nft` (the lot's collection, now a parameter rather than fixed to Shapes) and
// `lotClaimed` (set only by `claimLot`; `settle`/`cancelAuction` record the outcome and move
// nothing). `settle` no longer transfers the lot itself: `claimLot` is the sole delivery path,
// callable by the winner once settled or by the seller once cancelled unsold.
export const auctionHouseAbi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function auctions(uint256 auctionId) view returns ((address seller, address nft, uint256 tokenId, uint64 endTime, uint64 duration, uint32 extensionWindow, uint16 minIncrementBps, uint64 reserveUnits, uint64 highestUnits, address highestBidder, bool settled, bool lotClaimed))",
  "function bidUnits(uint256 auctionId, address bidder) view returns (uint64)",
  "function escrowedCards(uint256 auctionId, address bidder) view returns (uint256[])",
  "function minimumBid(uint256 auctionId) view returns (uint64)",
  "function cardsFor(uint256 backingWei) pure returns (uint256[9])",
  "function getAuctionFor(address nft, uint256 tokenId) view returns (bool exists, uint256 auctionId)",
  "function hasAuctionFor(address nft, uint256 tokenId) view returns (bool)",
  "function createAuction(address nft, uint256 tokenId, uint64 duration, uint64 reserveUnits, uint16 minIncrementBps, uint32 extensionWindow) returns (uint256 auctionId)",
  "function cancelAuction(uint256 auctionId)",
  "function bid(uint256 auctionId, uint256[] cardIds, uint256 ethBackingWei) payable",
  "function settle(uint256 auctionId)",
  "function claimLot(uint256 auctionId)",
  "function withdraw(uint256 auctionId)",
  "function claimProceeds(uint256 auctionId)",
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, address indexed nft, uint256 tokenId, uint64 duration, uint64 reserveUnits)",
  "event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint64 units, uint64 endTime)",
  "event BidCardsMinted(uint256 indexed auctionId, address indexed bidder, uint256 backingWei)",
  "event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint64 units)",
  "event AuctionCancelled(uint256 indexed auctionId)",
  "event LotClaimed(uint256 indexed auctionId, address indexed to)",
  "event BidWithdrawn(uint256 indexed auctionId, address indexed bidder, uint256 cardCount)",
  "event ProceedsClaimed(uint256 indexed auctionId, address indexed seller, uint256 cardCount)",
  "error AuctionNotFound(uint256 auctionId)",
  "error AuctionOver(uint256 auctionId)",
  "error AuctionStillRunning(uint256 auctionId)",
  "error AuctionAlreadySettled(uint256 auctionId)",
  "error InvalidAuction()",
  "error DurationOutOfRange()",
  "error ExtensionWindowTooLong()",
  "error LotNotReceived()",
  "error LotHasNoCode(address nft)",
  "error LotNotERC721(address nft)",
  "error NotTokenOwnerOrApproved(address nft, uint256 tokenId, address caller)",
  "error AuctionAlreadyExistsForToken(address nft, uint256 tokenId)",
  "error LotAlreadyClaimed(uint256 auctionId)",
  "error NotLotRecipient(uint256 auctionId, address caller)",
  "error SellerCannotBid()",
  "error EmptyBid()",
  "error WorthlessCard(uint256 tokenId)",
  "error TooManyCards(uint256 provided)",
  "error NotAUnitMultiple(uint256 backingWei)",
  "error IncorrectPayment(uint256 expected, uint256 provided)",
  "error BidTooLow(uint64 provided, uint64 required)",
  "error NothingToWithdraw(uint256 auctionId, address bidder)",
  "error UnsolicitedToken(address from)",
]);

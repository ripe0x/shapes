import {parseAbi} from "viem";
import {DENOMINATIONS as CANONICAL_AMOUNTS, LABELS as CANONICAL_LABELS} from "../canonical/denominations";

// The subset of the Shapes ERC721 the chain tester and the site call. Human-readable form; viem
// parses it to the full ABI at import. Every protocol action, view and preview is on this one
// contract, so there is no second address to configure.
export const shapesAbi = parseAbi([
  "struct ComposeCall { uint256 survivorId; uint256[] burnIds; }",
  "function mint(uint256 amountWei) payable returns (uint256 tokenId)",
  "function mintTo(uint256 amountWei, address to) payable returns (uint256 tokenId)",
  "function mintBatch(uint256 amountWei, uint256 quantity) payable returns (uint256 firstTokenId)",
  "function mintBatchTo(uint256 amountWei, uint256 quantity, address to) payable returns (uint256 firstTokenId)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function redeem(uint256 tokenId)",
  "function redeemTo(uint256 tokenId, address recipient)",
  "function redeemBatch(uint256[] tokenIds) returns (uint256 totalWei)",
  "function redeemBatchTo(uint256[] tokenIds, address recipient) returns (uint256 totalWei)",
  "function compose(uint256 survivorId, uint256[] burnIds) returns (uint256 outId)",
  "function composeMany(ComposeCall[] calls) returns (uint256[] outIds)",
  "function decompose(uint256 survivorId) returns (uint256[] restoredIds)",
  "function decomposeTo(uint256 survivorId, address recipient) returns (uint256[] restoredIds)",
  "function decomposeMany(uint256[] survivorIds) returns (uint256[][] restoredIds)",
  "function decomposeManyTo(uint256[] survivorIds, address recipient) returns (uint256[][] restoredIds)",
  "function split(uint256 tokenId, uint8[] outDenoms) returns (uint256[] newIds)",
  "function splitTo(uint256 tokenId, uint8[] outDenoms, address recipient) returns (uint256[] newIds)",
  "function composeDepth(uint256 survivorId) view returns (uint256)",
  "function burnBacking(uint256 tokenId)",
  "function burn(uint256 tokenId)",
  "function valueOf(uint256 tokenId) view returns (uint256)",
  "function denomIndexOf(uint256 tokenId) view returns (uint8)",
  "function isComplete(uint256 tokenId) view returns (bool)",
  "function childSeed(bytes32 parentSeed, uint256 childIndex) pure returns (bytes32)",
  "function denominationAt(uint8 index) pure returns (uint256)",
  "function denominationCount() pure returns (uint8)",
  "function unit() pure returns (uint256)",
  "function owner() view returns (address)",
  "function ownerToken() view returns (uint256)",
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
  "function setMintFee(uint256 newFee)",
  "function pendingFees() view returns (uint256)",
  "function feesOwedTo(address recipient) view returns (uint256)",
  "function withdrawFees(address recipient)",
  "function refreshMetadata()",
  "function collection() view returns (address)",
  "function positions() view returns (address target, bool locked)",
  "function market() view returns (address target, bool locked)",
  "function setPointer(uint8 pointer, address target)",
  "function lockPointer(uint8 pointer)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function seedOf(uint256 tokenId) view returns (bytes32)",
  "function originCountOf(uint256 tokenId) view returns (uint256)",
  "function inkGeneOf(uint256 tokenId) view returns (uint8)",
  "function isBlackShape(uint256 tokenId) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function redeemableBacking() view returns (uint256)",
  "function burnedBacking() view returns (uint256)",
  "function blackShapeCount() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function mintFee() view returns (uint256)",
  // Temporary read fallback for the superseded percentage-fee Sepolia deployment. New Shapes
  // contracts do not implement this selector.
  "function mintFeeFor(uint256 amountWei) view returns (uint256)",
  // Unix seconds before which mintBatch/mintBatchTo revert MintNotOpen(); 0 means open at deploy.
  "function mintStart() view returns (uint64)",
  "event ShapeMinted(uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount)",
  "event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount)",
  "event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint32 originCount)",
  "event Decomposed(uint256 indexed survivorId, uint256[] restoredIds, uint8 survivorDenomIndex, uint32 survivorOriginCount)",
  "event Split(uint256 indexed tokenId, bytes32 indexed parentSeed, uint256[] newIds, uint8[] outDenoms, uint32[] originCounts)",
  "event ShapeRevived(uint256 indexed survivorId, uint256 indexed revivedId)",
  "event BlackShapeCreated(uint256 indexed tokenId, uint256 burnedWei)",
  "event PositionsSet(address indexed positions)",
  "event PositionsLocked(address indexed positions)",
  "event MarketSet(address indexed market)",
  "event MarketLocked(address indexed market)",
  "event AdminTransferred(address indexed previousAdmin, address indexed newAdmin)",
  "event OwnerTokenMoved(uint256 indexed fromTokenId, uint256 indexed toTokenId)",
  "event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient)",
  "event ArtistAttested(address indexed artist, bytes32 indexed releaseHash, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  // Custom errors from IShapes.sol, so a revert decodes to a named error instead of raw bytes.
  "struct ShapeChildPreview { bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; uint256 faceValueWei; bytes modules; }",
  "struct ShapeState { bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bool isBlack; uint8 formation; uint256 faceValueWei; uint256 redeemableValueWei; bytes modules; }",
  "struct ComposeInputView { uint256 id; bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bytes modules; }",
  "struct ComposeRecordView { uint8 survivorDenominationIndex; uint32 survivorOriginCount; uint8 survivorInkGene; bytes survivorModules; uint256 ownerTokenFrom; ComposeInputView[] inputs; }",
  "function previewCompose(uint256 survivorId, uint256[] burnIds) view returns (ShapeState result)",
  "function previewSplit(uint256 tokenId, uint8[] outDenoms) view returns (ShapeChildPreview[] children)",
  "function shapeState(uint256 tokenId) view returns (ShapeState)",
  "function unicodeCard(uint256 tokenId) view returns (string)",
  "function composeRecordAt(uint256 survivorId, uint256 depth) view returns (ComposeRecordView)",
  "function splitOriginOf(uint256 childId) view returns (bytes32 parentSeed, uint256 parentId, uint8 parentDenomIndex, uint8 originDenomIndex, uint8 parentInkGene, bytes parentModules, uint256 childIndex)",
  "function exists(uint256 tokenId) view returns (bool)",
  "function positionOf(uint256 tokenId) view returns (address)",
  "function isSupportedDenomination(uint256 amountWei) pure returns (bool)",
  // Every error IShapes declares, plus the three from IAdminControl and the one Denominations
  // throws through `split`, so a revert from the token always decodes to a name.
  "error UnsupportedDenomination(uint256 amountWei)",
  "error IncorrectPayment(uint256 expected, uint256 provided)",
  "error ZeroQuantity()",
  "error ArtistAlreadyAttested()",
  "error InvalidArtistReleaseHash()",
  "error InvalidArtistSignature()",
  "error NotShapeOwner(uint256 tokenId, address caller)",
  "error EthTransferFailed(address to, uint256 amountWei)",
  "error InvalidRecipient(address recipient)",
  "error NoFeesPending()",
  "error MintFeeAboveCap(uint256 fee)",
  "error DirectDepositRejected()",
  "error MintNotOpen()",
  "error SelfCustodyRejected(uint256 tokenId)",
  "error PresentationIsLocked()",
  "error UnsupportedRenderer(address renderer)",
  "error UnsupportedCollection(address collection)",
  "error CollectionNotSet()",
  "error TokenIsBlack(uint256 tokenId)",
  "error NoComposeInputs()",
  "error CannotComposeWithSelf(uint256 tokenId)",
  "error SplitSumMismatch(uint256 inputBacking, uint256 outputSum)",
  "error SplitTooFewOutputs()",
  "error NoComposeRecord(uint256 survivorId)",
  "error NotApexComplete(uint256 tokenId)",
  "error DuplicateComposeInput(uint256 tokenId)",
  "error InvalidPointerTarget()",
  "error PointerIsLocked()",
  "error InvalidPointer()",
  "error ComposeRecordOutOfRange(uint256 survivorId, uint256 depth, uint256 depthAvailable)",
  "error NotASplitChild(uint256 tokenId)",
  "error NoOwnerToken()",
  "error AdminUnauthorizedAccount(address account)",
  "error AdminInvalidAdmin(address admin)",
  "error AdminInvalidFeeRecipient(address recipient)",
  "error DenominationIndexOutOfRange(uint256 index)",
]);


// The collection metadata contract. It stores the token name prefix, the shared description and
// the owner token's own description, all read back by `Shapes.tokenURI` and `Shapes.contractURI`
// and editable by the Shapes admin until `Shapes.lockPresentation` freezes them.
export const shapeCollectionAbi = parseAbi([
  "function renderer() view returns (address)",
  "function shapes() view returns (address)",
  "function tokenNamePrefix() view returns (string)",
  "function description() view returns (string)",
  "function ownerTokenDescription() view returns (string)",
  "function setMetadataCopy(string tokenNamePrefix_, string description_, string ownerTokenDescription_)",
  "function contractURI() view returns (string)",
  "function image() view returns (string)",
  "function imageFor(bytes32 root) view returns (string)",
  "function card(uint8 denomIndex) view returns (string)",
  "function cardFor(bytes32 cardSeed, uint8 denomIndex) view returns (string)",
  "event MetadataCopySet(string tokenNamePrefix, string description, string ownerTokenDescription)",
  "error InvalidCopy(uint8 field)",
  "error DenominationIndexOutOfRange(uint256 index)",
  "error PresentationIsLocked()",
  "error AdminUnauthorizedAccount(address account)",
]);

/** The public libraries whose addresses are linked into `Shapes` at deploy time. */
export type LibraryName =
  | "RecompositionOps"
  | "AdminOps"
  | "ComposeCompute"
  | "GeometrySampling"
  | "InkGenes";

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
  renderer: `0x${string}`;
  collection?: `0x${string}`;
  auctionHouse?: `0x${string}`;
  /** Flat fee in wei for every Shape created. New deployment metadata includes this as a
   *  readback aid; transaction construction still reads the canonical value onchain. */
  mintFeeWei?: string;
  /** Unix seconds before which the contract's immutable `mintStart` blocks minting, as a readback
   *  aid; the site's authoritative value is the chain read in `SiteData.mintStart` (see
   *  `mintStartOf` for parsing this field on its own, e.g. before that load completes). Absent or
   *  "0" means open at deploy. */
  mintStart?: string;
  /** Linked library addresses, from the deploy broadcast's `libraries` array. A value is null,
   *  or the key absent, on a record written before this key existed; the contracts page shows
   *  such a library as not recorded. */
  libraries?: Partial<Record<LibraryName, `0x${string}` | null>>;
  /** Block the contract was deployed at. Log scans start here; a public RPC rejects a scan from
   *  block 0 as too wide. Omitted on a local dev chain, where the whole range is tiny. */
  fromBlock?: number;
  /** Git commit and branch `script/deploy.sh` was run from. Absent on a record written before
   *  these keys existed. */
  commit?: string;
  branch?: string;
}

/** Parses `Deployment.mintStart` (a JSON string) to the unix-seconds bigint the site computes
 *  against. Missing, empty, or non-numeric values mean open at deploy. */
export function mintStartOf(dep: Pick<Deployment, "mintStart">): bigint {
  try {
    return dep.mintStart ? BigInt(dep.mintStart) : 0n;
  } catch {
    return 0n;
  }
}

/** Parses `Deployment.mintFeeWei` (a JSON string) to the wei bigint it records. Null when
 *  missing, empty, or non-numeric, distinct from a recorded zero fee. */
export function mintFeeOf(dep: Pick<Deployment, "mintFeeWei">): bigint | null {
  try {
    return dep.mintFeeWei ? BigInt(dep.mintFeeWei) : null;
  } catch {
    return null;
  }
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
  "function auctions(uint256 auctionId) view returns ((address seller, address nft, uint256 tokenId, uint64 endTime, uint64 startTime, uint64 duration, uint32 extensionWindow, uint16 minIncrementBps, uint64 reserveUnits, uint64 highestUnits, address highestBidder, bool settled, bool lotClaimed))",
  "function bidUnits(uint256 auctionId, address bidder) view returns (uint64)",
  "function escrowedCards(uint256 auctionId, address bidder) view returns (uint256[])",
  "function minimumBid(uint256 auctionId) view returns (uint64)",
  "function cardsFor(uint256 backingWei) pure returns (uint256[9])",
  "function mintCostFor(uint256 backingWei) view returns (uint256)",
  "function getAuctionFor(address nft, uint256 tokenId) view returns (bool exists, uint256 auctionId)",
  "function hasAuctionFor(address nft, uint256 tokenId) view returns (bool)",
  "function createAuction(address nft, uint256 tokenId, uint64 duration, uint64 reserveUnits, uint16 minIncrementBps, uint32 extensionWindow) returns (uint256 auctionId)",
  "function createAuction(address nft, uint256 tokenId, uint64 duration, uint64 reserveUnits, uint16 minIncrementBps, uint32 extensionWindow, uint64 startTime) returns (uint256 auctionId)",
  "function cancelAuction(uint256 auctionId)",
  "function bid(uint256 auctionId, uint256[] cardIds, uint256 ethBackingWei) payable",
  "function settle(uint256 auctionId)",
  "function claimLot(uint256 auctionId)",
  "function withdraw(uint256 auctionId)",
  "function claimProceeds(uint256 auctionId)",
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, address indexed nft, uint256 tokenId, uint64 duration, uint64 reserveUnits, uint64 startTime)",
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

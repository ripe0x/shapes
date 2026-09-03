// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAdminControl} from "./IAdminControl.sol";
import {ComposeRecordView, ShapeChildPreview, ShapeFormation, ShapeState} from "../ShapeTypes.sol";
import {IERC721Value} from "./IERC721Value.sol";

/// @title IShapes
/// @notice ETH wrapped into unique ERC-721 objects at nine fixed denominations.
/// @dev A Shape holds an exact amount of ETH. Redeeming or burning it destroys the token and
///      returns exactly that amount to its owner. The other reserve outflow is `burnBacking`, which
///      sends an apex Complete Shape's backing to an unspendable address and is callable only by
///      that Shape's owner. No pause, upgrade path, recovery function or admin path reaches the
///      reserve.
///
///      One live Shape is the owner token, exposed by `ownerToken()`. It starts as #0 and moves
///      through `compose`, `decompose` and `split`. `owner()` follows its holder and returns zero
///      once it is redeemed or burned. Holding it grants no permissions. The separate `admin()`
///      role administers presentation and pointers, redirects future mint fees and adjusts the mint
///      fee within a compile-time cap. It reaches nothing else, and it may be transferred or
///      renounced without moving any Shape.
///
///      Every protocol fact and every simulation is reachable from this address alone. There is no
///      periphery read contract and no function reachable only through a library.
interface IShapes is IERC721, IERC721Value, IAdminControl {
    /// @notice The two fixed pointers administered by `setPointer` and `lockPointer`.
    enum Pointer {
        Positions,
        Market
    }

    /// @notice Emitted when a Shape is minted. `originCount` is always 1: a mint is the sole
    ///         source of new origins. A strict origin-creation signal; recomposition does not
    ///         emit it.
    event ShapeMinted(
        uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount
    );

    /// @notice Emitted when a Shape is redeemed for its backing. `originCount` is the redeemed
    ///         token's origin credit, carried so an event-only indexer can track the global
    ///         origin balance (mint origins − redeemed origins) without a pre-burn state read.
    event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount);

    /// @notice Emitted once per mint call that charges a nonzero fee: the aggregate fee accrued
    ///         to `pendingFees`, not yet forwarded to anyone. Quantity minted is recoverable from
    ///         the same transaction's `ShapeMinted` events.
    event MintFeeAccrued(uint256 amountWei);

    /// @notice Emitted when `withdrawFees` forwards the accrued fee to the current fee recipient.
    event FeesWithdrawn(address indexed recipient, uint256 amountWei);

    /// @notice Emitted once when the artist cryptographically approves this deployment and release.
    event ArtistAttested(address indexed artist, bytes32 indexed releaseHash, bytes signature);

    /// @notice Emitted when the admin replaces the onchain renderer.
    event RendererUpdated(address indexed renderer);

    /// @notice Emitted when the admin replaces the collection metadata contract.
    event CollectionUpdated(address indexed collection);

    /// @notice Emitted when presentation is permanently locked. Neither the renderer nor the
    ///         collection can change afterwards.
    event PresentationLocked(address indexed renderer, address indexed collection);

    /// @notice Standard contract-level metadata refresh signal, emitted by `refreshMetadata`.
    event ContractURIUpdated();

    /// @notice Emitted when the admin sets, replaces or clears the optional positions contract.
    event PositionsSet(address indexed positions);

    /// @notice Emitted when the current positions value is permanently locked, including zero.
    event PositionsLocked(address indexed positions);

    /// @notice Emitted when the admin sets, replaces or clears the optional canonical market.
    event MarketSet(address indexed market);

    /// @notice Emitted when the current market value is permanently locked, including zero.
    event MarketLocked(address indexed market);

    /// @notice Emitted when Shapes are composed into one. The survivor keeps its id and seed and
    ///         becomes the summed denomination; the burned inputs are consumed into it.
    event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint32 originCount);

    /// @notice Emitted when a Shape is decomposed: the survivor's top compose is reversed. The
    ///         survivor keeps its id and seed and reverts to `survivorDenomIndex` /
    ///         `survivorOriginCount`; `restoredIds` are the burned inputs re-minted under their
    ///         original ids and seeds. Re-minted inputs do not emit ShapeMinted.
    event Decomposed(
        uint256 indexed survivorId,
        uint256[] restoredIds,
        uint8 survivorDenomIndex,
        uint32 survivorOriginCount
    );

    /// @notice Emitted when a Shape is split. The input is burned and each output is a fresh id;
    ///         `originCounts` is the per-child origin partition. Outputs do not emit ShapeMinted.
    ///         `parentSeed` is the input's seed, from which every child seed derives.
    event Split(
        uint256 indexed tokenId,
        bytes32 indexed parentSeed,
        uint256[] newIds,
        uint8[] outDenoms,
        uint32[] originCounts
    );

    /// @notice Emitted when an apex Complete Shape's backing is burned and it becomes a Black Shape.
    ///         `burnedWei` is sent to an unspendable address and is never redeemable again.
    event BlackShapeCreated(uint256 indexed tokenId, uint256 burnedWei);

    /// @notice Emitted whenever a token's ink gene is assigned or changes: once per mint, once
    ///         per compose (the survivor), once per split child.
    ///         INK_GENES_IMPL_SPEC.md is the specification; gene assignment never uses fresh
    ///         entropy beyond the participating seeds.
    event InkGene(uint256 indexed tokenId, uint8 gene);

    /// @notice Filterable compose edge. Emitted once for every burned input in addition to the
    ///         aggregate `Composed` event.
    event ShapeAbsorbed(uint256 indexed survivorId, uint256 indexed burnedId);

    /// @notice Filterable split edge. Emitted once for every child in addition to `Split`.
    event ShapeFragmentCreated(
        uint256 indexed parentId, uint256 indexed childId, bytes32 indexed parentSeed, uint256 childIndex
    );

    /// @notice Filterable decompose edge. Emitted once for every input re-minted under its original
    ///         id when a survivor's compose is reversed, in addition to the aggregate `Decomposed`.
    event ShapeRevived(uint256 indexed survivorId, uint256 indexed revivedId);

    /// @notice Emitted whenever a token's sampled module geometry (`ModuleCodec`) is set or
    ///         restored: the survivor after `compose`, each child after `split`, and both the
    ///         survivor and every re-minted input after `decompose`. Empty `modules` means the
    ///         token's geometry has reverted to seed-derived grammar v1.
    event ModulesSampled(uint256 indexed tokenId, bytes modules);

    /// @notice Emitted whenever the owner token changes: at construction, when it is a compose
    ///         donor, when a compose absorbing it is decomposed, when it is split, and when it is
    ///         redeemed or burned. `type(uint256).max` denotes no owner token. The co-emitted
    ///         `Composed`/`Decomposed`/`Split`/`ShapeRedeemed` event in the same transaction says why.
    event OwnerTokenMoved(uint256 indexed fromTokenId, uint256 indexed toTokenId);

    error UnsupportedDenomination(uint256 amountWei);
    error IncorrectPayment(uint256 expected, uint256 provided);
    error ZeroQuantity();
    error ArtistAlreadyAttested();
    error InvalidArtistReleaseHash();
    error InvalidArtistSignature();
    error NotShapeOwner(uint256 tokenId, address caller);
    error EthTransferFailed(address to, uint256 amountWei);
    /// @notice A recipient-directed redemption named the zero address, which would burn the payout.
    error InvalidRecipient(address recipient);
    /// @dev `withdrawFees` found nothing accrued.
    error NoFeesPending();
    /// @dev A mint fee, at construction or via `setMintFee`, above the cap, `unit()`.
    error MintFeeAboveCap(uint256 fee);
    error DirectDepositRejected();
    /// @dev Every public mint entrypoint reverts before `block.timestamp` reaches `mintStart`.
    error MintNotOpen();
    /// @dev Redemption requires `msg.sender` to be the owner, which the contract can never be, so
    ///      minting and transferring to `address(this)` are both refused.
    error SelfCustodyRejected(uint256 tokenId);
    /// @dev `setRenderer`, `setCollection` and `lockPresentation` revert once presentation is
    ///      locked, as does `IShapeCollection.setMetadataCopy`, which reads the lock back from here.
    error PresentationIsLocked();
    /// @dev A renderer must have code and explicitly support the stable `IShapeRenderer`
    ///      capability; the zero address fails the code check.
    error UnsupportedRenderer(address renderer);
    /// @dev A collection must explicitly support the stable `IShapeCollection` capability.
    error UnsupportedCollection(address collection);
    /// @dev A Black Shape cannot be redeemed, composed, decomposed or have its backing burned again.
    ///      It remains transferable and may be destroyed through the draft ERC-8060 `burn` path.
    error TokenIsBlack(uint256 tokenId);
    /// @dev `compose` was called with an empty `burnIds`: there is nothing to burn into the
    ///      survivor.
    error NoComposeInputs();
    /// @dev The survivor of a compose cannot also appear in its burn set.
    error CannotComposeWithSelf(uint256 tokenId);
    /// @dev A split's output denominations must sum to exactly the input's backing.
    error SplitSumMismatch(uint256 inputBacking, uint256 outputSum);
    /// @dev `split`/`splitTo` named fewer than two outputs.
    error SplitTooFewOutputs();
    /// @dev `decompose` found no compose to reverse: the survivor's compose stack is empty.
    error NoComposeRecord(uint256 survivorId);
    /// @dev `burnBacking` requires an apex Complete: 100 ETH with an origin per 0.01 unit.
    error NotApexComplete(uint256 tokenId);
    /// @dev The same token id appears twice in one `compose` or `previewCompose` `burnIds`. A
    ///      token can only be burned into the survivor once.
    error DuplicateComposeInput(uint256 tokenId);
    /// @dev `tokenURI` and `contractURI` read the metadata copy from the collection, so both
    ///      revert while the collection pointer is zero. Deployment sets it immediately after
    ///      construction.
    error CollectionNotSet();
    /// @dev A nonzero positions or market pointer must contain code and answer ERC-165 for the
    ///      interface its reader calls.
    error InvalidPointerTarget();
    /// @dev A pointer cannot be changed or locked again after its permanent lock.
    error PointerIsLocked();
    /// @dev `pointer` must encode `Pointer.Positions` (0) or `Pointer.Market` (1).
    error InvalidPointer();
    /// @dev `composeRecordAt` was asked for a depth at or past `composeDepth(survivorId)`. Depths
    ///      run 0 (oldest) to `composeDepth - 1` (newest, next in line for `decompose`).
    error ComposeRecordOutOfRange(uint256 survivorId, uint256 depth, uint256 depthAvailable);
    /// @dev `splitOriginOf` requires `tokenId` to have been minted as a split child. Original
    ///      mints and re-minted decompose outputs never carry an entry.
    error NotASplitChild(uint256 tokenId);
    /// @dev `ownerToken` found no live owner token: it was redeemed or burned.
    error NoOwnerToken();
    /* ----------------------- fee and deployment reads ----------------------- */

    /// @notice Flat fee in wei for every Shape created, charged on top of backing. Never enters
    ///         backing. Set at construction and admin-adjustable afterward via `setMintFee`. The
    ///         cap, enforced at construction and by `setMintFee`, is one denomination unit,
    ///         `unit()`.
    function mintFee() external view returns (uint256);

    /// @notice Unix timestamp at or after which public minting opens. Zero opens minting
    ///         immediately. Immutable, set at construction.
    /// @dev Shape #0 is minted in the constructor and is not subject to this gate.
    function mintStart() external view returns (uint64);

    /// @notice Mint fees accrued and not yet withdrawn. Never part of `redeemableBacking`.
    function pendingFees() external view returns (uint256);

    /// @notice Where `withdrawFees` currently forwards accrued fees. Admin-updateable.
    function feeRecipient() external view returns (address);

    /// @notice Permanent creator attribution: the address that deployed Shapes.
    /// @dev Attribution only. It grants no ownership, administration, fee rights or other authority.
    function artist() external view returns (address);

    /// @notice Release or artifact hash permanently approved by the artist.
    /// @dev Zero means the one permitted attestation has not yet been stored.
    function artistReleaseHash() external view returns (bytes32);

    /// @notice Raw EIP-712 signature permanently stored by the artist; empty before attestation.
    function artistSignature() external view returns (bytes memory);

    /// @notice EIP-712 digest the artist signs for `releaseHash`.
    function artistAttestationDigest(bytes32 releaseHash) external view returns (bytes32);

    /// @notice Permanently store the artist's approval of this deployment and release.
    /// @dev Anyone may relay the signature. Supports EOAs, EIP-7702 delegated EOAs and ERC-1271 wallets.
    function attestArtist(bytes32 releaseHash, bytes calldata signature) external;

    /// @notice Holder of the current owner token, or zero if it no longer exists.
    /// @dev This address has no administrative authority. Ownership follows the owner token through
    ///      `compose`, `decompose` and `split`. Redeeming or burning it ends collection ownership
    ///      permanently: this returns zero and no other token inherits.
    function owner() external view returns (address);

    /// @notice The id of the current owner token.
    /// @dev Reverts `NoOwnerToken` once the owner token has been redeemed or burned.
    function ownerToken() external view returns (uint256);

    /// @notice The onchain renderer. Replaceable by the admin via `setRenderer` until locked.
    function renderer() external view returns (address);

    /// @notice Whether presentation has been permanently locked. True freezes the renderer, the
    ///         collection and the metadata copy.
    function presentationLocked() external view returns (bool);

    /// @notice The collection metadata contract. It stores the metadata copy `tokenURI` and
    ///         `contractURI` read. Replaceable by the admin via `setCollection` until
    ///         `lockPresentation` freezes it; zero until deployment sets it.
    function collection() external view returns (address);

    /// @notice The optional canonical positions contract and whether its pointer is permanently locked.
    /// @dev A zero target means none is configured. A true lock is permanent, including at zero.
    function positions() external view returns (address target, bool locked);

    /// @notice The optional canonical market and whether its pointer is permanently locked.
    /// @dev A zero target means none is configured. A true lock is permanent, including at zero.
    function market() external view returns (address target, bool locked);

    /* ----------------------------- renderer ---------------------------- */

    /// @notice Replace the onchain renderer. Admin only, and only while unlocked. The renderer
    ///         is read only by `tokenURI`; changing it affects how a Shape looks, never its
    ///         backing, redeemability or owner. `newRenderer` must carry code.
    function setRenderer(address newRenderer) external;

    /// @notice Replace the collection metadata contract. Admin only, and only while unlocked.
    ///         Read by `tokenURI` and `contractURI`; it can never touch ETH, backing or ownership.
    ///         `newCollection` must carry code and support `IShapeCollection`.
    /// @dev Replacing it replaces the stored metadata copy along with it, since the copy lives on
    ///      the collection, so this emits ERC-4906 `BatchMetadataUpdate` over every minted id and
    ///      `ContractURIUpdated` as well as `CollectionUpdated`.
    function setCollection(address newCollection) external;

    /// @notice Permanently lock presentation. Admin only, one way. After this the renderer, the
    ///         collection and the collection's metadata copy are all fixed: `setRenderer`,
    ///         `setCollection` and `IShapeCollection.setMetadataCopy` revert `PresentationIsLocked`.
    function lockPresentation() external;

    /// @notice Signal that every token's metadata and the contract-level metadata should be
    ///         re-read. Admin only, state-changing in no other way.
    /// @dev Emits ERC-4906 `BatchMetadataUpdate` over every minted id and `ContractURIUpdated`.
    ///      Editing the copy is two transactions: `IShapeCollection.setMetadataCopy` on the
    ///      collection, then this.
    function refreshMetadata() external;

    /* --------------------------- pointer admin ------------------------- */

    /// @notice Set, replace or clear one explicit pointer. Admin only while that pointer is unlocked.
    /// @dev Zero clears it. A nonzero target must contain code and answer ERC-165 for the
    ///      interface its reader calls: `IShapePositionResolver` for positions,
    ///      `IShapeAuctionHouse` for the market. No other call to the target ever occurs.
    function setPointer(uint8 pointer, address target) external;

    /// @notice Permanently freeze one explicit pointer. Admin only; may lock it at zero.
    function lockPointer(uint8 pointer) external;

    /* ---------------------------- minting ----------------------------- */

    /// @notice Mint one Shape backed by `amountWei`, to the caller.
    /// @dev `msg.value` must equal exactly `amountWei + mintFee()`.
    function mint(uint256 amountWei) external payable returns (uint256 tokenId);

    /// @notice Mint one Shape backed by `amountWei`, to `to`.
    /// @dev The recipient does not feed the seed, so naming one cannot be used to search for a
    ///      particular artwork. `to` must be able to receive an ERC721.
    function mintTo(uint256 amountWei, address to) external payable returns (uint256 tokenId);

    /// @notice Mint `quantity` Shapes, each backed by `amountWei`, to the caller.
    /// @dev `msg.value` must equal exactly `quantity * (amountWei + mintFee())`.
    ///      Each token receives a distinct id and a distinct seed.
    function mintBatch(uint256 amountWei, uint256 quantity) external payable returns (uint256 firstTokenId);

    /// @notice Mint `quantity` Shapes, each backed by `amountWei`, to `to`.
    function mintBatchTo(uint256 amountWei, uint256 quantity, address to)
        external
        payable
        returns (uint256 firstTokenId);

    /// @notice Forward every accrued mint fee to the current `feeRecipient`. Callable by anyone;
    ///         the destination is always the recipient at the time of the call. Reverts
    ///         `NoFeesPending` when nothing has accrued. A recipient that reverts on receipt makes
    ///         only this call revert; minting is never affected, and the admin can redirect
    ///         `feeRecipient` and retry.
    function withdrawFees() external;

    /* --------------------------- redemption --------------------------- */

    /// @notice Burn a Shape and receive exactly its backing.
    /// @dev Callable only by the current owner. All or nothing; there is no partial redemption.
    ///      Redeeming the owner token ends collection ownership permanently.
    function redeem(uint256 tokenId) external;

    /// @notice Burn several Shapes owned by the caller and receive the exact total backing.
    function redeemBatch(uint256[] calldata tokenIds) external returns (uint256 totalWei);

    /// @notice Redeem a caller-owned Shape and send its exact backing directly to `recipient`.
    function redeemTo(uint256 tokenId, address payable recipient) external;

    /// @notice Batch redemption with a caller-selected ETH recipient.
    function redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        external
        returns (uint256 totalWei);

    /* -------------------------- recomposition ------------------------- */

    /// @notice Compose several Shapes into one. `survivorId` keeps its id and seed and becomes the
    ///         summed denomination; the `burnIds` are burned into it. All must be owned by the
    ///         caller and not Black. No ETH moves and no fee is charged. The summed backing must be
    ///         a valid denomination. Origins are summed onto the survivor. If the owner token is
    ///         among `burnIds`, ownership moves to `survivorId`.
    function compose(uint256 survivorId, uint256[] calldata burnIds) external returns (uint256 outId);

    /// @notice One compose in a `composeMany` batch: a survivor and the ids burned into it.
    struct ComposeCall {
        uint256 survivorId;
        uint256[] burnIds;
    }

    /// @notice Run several composes in order in one transaction, each recording its own reversible
    ///         entry. Every id is pre-existing (compose mints nothing and keeps each survivor's id),
    ///         so a later call may name a survivor an earlier call produced. Bounded by block gas.
    function composeMany(ComposeCall[] calldata calls) external returns (uint256[] memory outIds);

    /// @notice Reverse the survivor's most recent compose. The survivor keeps its id and seed and
    ///         reverts to its pre-compose denomination, origin count and gene; every input burned by
    ///         that compose is re-minted under its original id and seed, to the caller. Caller must
    ///         own the survivor and it must not be Black. No ETH moves and no fee is charged. Stacked
    ///         composes reverse newest first (LIFO); reverts `NoComposeRecord` if none remain. If
    ///         the reversed compose had moved ownership from one of its inputs, ownership restores
    ///         to that input.
    function decompose(uint256 survivorId) external returns (uint256[] memory restoredIds);

    /// @notice Reverse the survivor's most recent compose, safely minting the restored inputs to
    ///         `recipient` instead of the caller. If ownership restores to a restored input,
    ///         `recipient` becomes the collection owner.
    function decomposeTo(uint256 survivorId, address recipient)
        external
        returns (uint256[] memory restoredIds);

    /// @notice Decompose several survivors in order in one transaction, restored inputs to the
    ///         caller. Repeat an id to pop stacked records; list a nested tree parent-before-child.
    ///         Bounded by block gas.
    function decomposeMany(uint256[] calldata survivorIds) external returns (uint256[][] memory restoredIds);

    /// @notice Batch decompose with a caller-selected recipient for every restored input.
    function decomposeManyTo(uint256[] calldata survivorIds, address recipient)
        external
        returns (uint256[][] memory restoredIds);

    /// @notice Split a Shape into the denominations in `outDenoms`, which must sum to its backing.
    ///         The input is burned; each output is a fresh id with a seed derived from the input's
    ///         seed. No ETH moves and no fee is charged. Origins are partitioned across the outputs,
    ///         each output filled to capacity in listed order. If the input is the owner token,
    ///         ownership moves to the first output.
    function split(uint256 tokenId, uint8[] calldata outDenoms) external returns (uint256[] memory newIds);

    /// @notice Split a caller-owned Shape and safely mint every child to `recipient`. If the input
    ///         is the owner token, `recipient` becomes the collection owner.
    function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        external
        returns (uint256[] memory newIds);

    /// @notice Permanently burn an apex Complete Shape's backing, turning it into a Black
    ///         Shape. Owner only, one way. The token keeps its id, seed and geometry; its backing is
    ///         sent to an unspendable address and it becomes non-redeemable and non-recomposable.
    ///         The resulting zero-value Black Shape stays transferable and may be burned for zero.
    function burnBacking(uint256 tokenId) external;

    /* ----------------------------- views ------------------------------ */

    /// @notice ETH available to redeem now, across every live non-Black Shape.
    function redeemableBacking() external view returns (uint256);

    /// @notice Cumulative backing already sent to the unspendable address by `burnBacking`. This
    ///         ETH is no longer held by the contract and can never be redeemed. Monotonic.
    function burnedBacking() external view returns (uint256);

    /// @notice Number of Black Shapes alive now. `burnBacking` raises it; burning a Black Shape for
    ///         zero lowers it. `burnedBacking`, which counts ETH that has already left, does not
    ///         move when one is burned.
    function blackShapeCount() external view returns (uint256);

    /// @notice Whether a live token is a Black Shape.
    function isBlack(uint256 tokenId) external view returns (bool);

    /// @notice ETH backing a live Shape. Black Shapes have no redeemable backing and return zero.
    function backingOf(uint256 tokenId) external view returns (uint256);

    /// @notice The denomination-ladder index (0..8) currently stored by a live Shape.
    /// @dev Reverts for a nonexistent id. Black Shapes retain and return apex index 8.
    function denomIndexOf(uint256 tokenId) external view returns (uint8);

    /// @notice The immutable visual seed of a live Shape.
    function seedOf(uint256 tokenId) external view returns (bytes32);

    /// @notice Independent direct-mint origins credited to a live Shape (one per mint, conserved).
    function originCountOf(uint256 tokenId) external view returns (uint256);

    /// @notice A live Shape's ink gene (0..6). Assigned at mint; evolves only through `compose`.
    function inkGeneOf(uint256 tokenId) external view returns (uint8);

    /// @notice A live Shape's stored module array (`ModuleCodec`), empty when its geometry derives
    ///         from `seed` under grammar v1.
    function modulesOf(uint256 tokenId) external view returns (bytes memory);

    /// @notice Collection-level metadata URI, read from the renderer.
    function contractURI() external view returns (string memory);

    /// @notice Stable numeric formation class; metadata strings are presentation only.
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);

    /// @notice Whether a Shape is Complete: not a Black Shape, above the minimum tier, and
    ///         carrying one origin per 0.01 unit of backing (`originCount == backing / 0.01`).
    function isComplete(uint256 tokenId) external view returns (bool);

    /// @notice Number of live Shapes.
    function totalSupply() external view returns (uint256);

    /// @notice The id counter: the next id to be issued, and one past the highest id ever issued
    ///         (ids start at 0). Not a live-supply or mint count: `decompose` re-mints ids without
    ///         advancing it, and burns do not decrease it. Use `totalSupply` for the live count.
    function totalMinted() external view returns (uint256);

    /// @notice The survivor's compose-stack depth: how many stacked composes `decompose` can still
    ///         reverse, newest first. Zero means nothing to decompose.
    function composeDepth(uint256 survivorId) external view returns (uint256);

    /// @notice One reversible compose record on `survivorId`'s stack, at `depth` (0 the oldest,
    ///         `composeDepth(survivorId) - 1` the newest, next in line for `decompose`). Carries
    ///         the survivor's pre-compose state and every burned input's snapshot: exactly what
    ///         `decompose` reads to reverse that compose, each donor's materialized module bytes
    ///         included, so the survivor's post-compose geometry can be reproduced off chain.
    /// @dev `ownerTokenFrom` on the returned record names the input that held collection
    ///      ownership before this compose, or `type(uint256).max` when none did. Reverts
    ///      `ComposeRecordOutOfRange` for a depth at or past `composeDepth(survivorId)`.
    function composeRecordAt(uint256 survivorId, uint256 depth)
        external
        view
        returns (ComposeRecordView memory);

    /// @notice The split that minted `childId`: the parent's id, pre-split seed, denomination
    ///         index, ink gene and effective module snapshot, the root split ancestor's
    ///         denomination index, plus `childId`'s index among that split's outputs.
    /// @dev `parentModules` is kept for provenance. Reproducing the child's sampled module bytes
    ///      needs the branch decision `parentId` enables, not `parentModules`:
    ///      `composeDepth(parentId)` selects between the compose-record pool and the grammar pool.
    ///      See SAMPLING_SPEC.md. The record is written once per split and shared by every child of
    ///      that split; only `childIndex` distinguishes them. It is never deleted, so it keeps
    ///      answering how the token was created even after the child is composed or split again.
    ///      Reverts `NotASplitChild` for a token that was never minted by `split`/`splitTo`, which
    ///      covers an original mint and an input re-minted by `decompose`.
    function splitOriginOf(uint256 childId)
        external
        view
        returns (
            bytes32 parentSeed,
            uint256 parentId,
            uint8 parentDenomIndex,
            uint8 originDenomIndex,
            uint8 parentInkGene,
            bytes memory parentModules,
            uint256 childIndex
        );

    /// @notice Every protocol fact about one live Shape in a single read.
    /// @dev Reverts for an id that does not exist.
    function shapeState(uint256 tokenId) external view returns (ShapeState memory);

    /// @notice Whether `tokenId` is a live Shape right now.
    /// @dev Never reverts. False for never-issued and burned ids, including ids consumed by compose
    ///      or replaced by split; true for live Black Shapes.
    function exists(uint256 tokenId) external view returns (bool);

    /// @notice The state `compose(survivorId, burnIds)` would leave on the survivor if `account`
    ///         called it now. Writes nothing.
    /// @dev Applies compose's own rules against `account`: every token must exist, be held by
    ///      `account` and not be Black, the survivor cannot be among `burnIds`, no id may repeat,
    ///      and the summed backing must land on a denomination. Same errors, same order, same
    ///      sampling code as `compose`.
    function previewCompose(address account, uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory);

    /// @notice The children `split(tokenId, outDenoms)` would mint if `account` called it now, one
    ///         entry per `outDenoms` index. Writes nothing.
    /// @dev Applies split's own rules against `account`: the token must exist, be held by `account`
    ///      and not be Black, there must be at least two outputs, and they must sum to the token's
    ///      backing. Child ids are not predicted, because they depend on `totalMinted` at the time
    ///      the split executes.
    function previewSplit(address account, uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children);

    /// @notice Unicode rendering of a live Shape's module grid, cells separated by spaces and rows
    ///         by newlines.
    /// @dev For display. Machine-readable geometry is `IShapeGeometry` on `renderer()`.
    function unicodeCard(uint256 tokenId) external view returns (string memory);

    /// @notice The position the configured positions contract reports for `tokenId`, or zero.
    /// @dev Does not require a live token. The positions contract is untrusted and is called with a
    ///      50,000-gas cap; a revert, an out-of-gas, or a malformed return all resolve to zero.
    function positionOf(uint256 tokenId) external view returns (address);

    /// @notice Deterministic seed assigned to a split child at `childIndex`.
    function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32);

    /// @notice Backing amount at a denomination index.
    function denominationAt(uint8 index) external pure returns (uint256);

    /// @notice Number of permanent denominations.
    function denominationCount() external pure returns (uint8);

    /// @notice Smallest denomination and accounting unit, 0.01 ETH.
    function unit() external pure returns (uint256);

    /// @notice Whether `amountWei` is one of the nine supported denominations.
    function isSupportedDenomination(uint256 amountWei) external pure returns (bool);
}

/// @title IShapeValue
/// @notice Backing and redemption, for an integrator that does not need recomposition.
/// @dev Advertised by `Shapes.supportsInterface`. Every member is implemented on the token.
interface IShapeValue {
    function backingOf(uint256 tokenId) external view returns (uint256);
    function denomIndexOf(uint256 tokenId) external view returns (uint8);
    function denominationAt(uint8 index) external pure returns (uint256);
    function denominationCount() external pure returns (uint8);
    function unit() external pure returns (uint256);
    function redeem(uint256 tokenId) external;
    function redeemBatch(uint256[] calldata tokenIds) external returns (uint256 totalWei);
    function redeemTo(uint256 tokenId, address payable recipient) external;
    function redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        external
        returns (uint256 totalWei);
}

/// @title IShapeRecomposition
/// @notice The structural mutators, for a contract that builds recomposition workflows.
/// @dev Advertised by `Shapes.supportsInterface`. Every member is implemented on the token.
interface IShapeRecomposition {
    function compose(uint256 survivorId, uint256[] calldata burnIds) external returns (uint256 outId);
    function decompose(uint256 survivorId) external returns (uint256[] memory restoredIds);
    function decomposeTo(uint256 survivorId, address recipient)
        external
        returns (uint256[] memory restoredIds);
    function split(uint256 tokenId, uint8[] calldata outDenoms) external returns (uint256[] memory newIds);
    function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        external
        returns (uint256[] memory newIds);
    function burnBacking(uint256 tokenId) external;
}

/// @title IShapeProvenance
/// @notice Origin and identity reads, separate from metadata presentation.
/// @dev Advertised by `Shapes.supportsInterface`. Every member is implemented on the token.
interface IShapeProvenance {
    function seedOf(uint256 tokenId) external view returns (bytes32);
    function originCountOf(uint256 tokenId) external view returns (uint256);
    function inkGeneOf(uint256 tokenId) external view returns (uint8);
    function isComplete(uint256 tokenId) external view returns (bool);
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);
    function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32);
}

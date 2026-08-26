// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAdminControl} from "./IAdminControl.sol";
import {ShapeFormation} from "./IShapeCapabilities.sol";
import {IERC721Value} from "./IERC721Value.sol";

/// @title IShapes
/// @notice ETH wrapped into unique ERC721 objects at nine fixed denominations.
/// @dev A Shape holds an exact amount of ETH. Redeeming or burning it destroys the token and
///      returns exactly that amount to its owner. The other reserve outflow is `sacrifice`, which
///      sends a fixed 100 ETH to an unspendable address and is callable only by an apex Complete
///      Shape's owner. No pause, upgrade path, recovery function or admin path reaches the reserve.
///      Shape #0 represents ownership of the contract as a collectible object: `owner()` follows
///      its current holder, including returning zero while #0 is burned. Ownership grants no
///      permissions. A separate `admin()` role may administer and independently lock the renderer
///      and optional position resolver, and may redirect future mint fees without changing the fee
///      rate or touching backing. It may be transferred or renounced without moving Shape #0.
///
///      `shapeState`, `previewCompose`, `previewSplit`, `unicodeCard`, `composeRecordAt` (rich
///      struct form) and `splitOriginOf` (rich-named form) are not declared here: they are
///      read-only periphery, deployed separately as `ShapeLens` (`IShapeLens`) to keep this
///      contract's runtime bytecode under the EIP-170 size limit. `modulesOf`,
///      `composeRecordHeaderAt`, `composeRecordInputAt` and `splitOriginRaw` below are the minimal
///      raw accessors `ShapeLens` reads to reconstruct them.
interface IShapes is IERC721, IERC721Value, IAdminControl {
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

    /// @notice Emitted once per mint call, when the aggregate fee is forwarded.
    event MintFeePaid(address indexed recipient, uint256 amountWei, uint256 quantity);

    /// @notice Emitted once when the artist cryptographically approves this deployment and release.
    event ArtistAttested(address indexed artist, bytes32 indexed releaseHash, bytes signature);

    /// @notice Emitted when the admin replaces the onchain renderer.
    event RendererUpdated(address indexed renderer);

    /// @notice Emitted when the admin replaces the collection metadata contract.
    event CollectionUpdated(address indexed collection);

    /// @notice Emitted when the renderer is permanently locked. It cannot change afterwards.
    event RendererLocked();

    /// @notice Standard contract-level metadata refresh signal, emitted when the collection copy changes.
    event ContractURIUpdated();

    /// @notice Emitted when the admin sets, replaces or clears the optional position resolver.
    event PositionResolverSet(address indexed resolver);

    /// @notice Emitted when the current resolver value is permanently locked, including zero.
    event PositionResolverLocked(address indexed resolver);

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

    /// @notice Emitted when an apex Complete Shape is sacrificed into Black. `sacrificedWei`
    ///         (100 ETH) is sent
    ///         to a provably unspendable address and is never redeemable again.
    event Blackened(uint256 indexed tokenId, uint256 sacrificedWei);

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

    /// @notice Emitted whenever a token's materialized module geometry (`ModuleCodec`) is set or
    ///         restored: the survivor after `compose`, each child after `split`, and both the
    ///         survivor and every re-minted input after `decompose`. Empty `modules` signals the
    ///         token's geometry has reverted to seed-derived grammar v1.
    event ModulesSampled(uint256 indexed tokenId, bytes modules);

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
    error MintFeeTransferFailed(address recipient, uint256 amountWei);
    error DirectDepositRejected();
    /// @dev Redemption requires `msg.sender` to be the owner, which the contract can never be, so
    ///      minting and transferring to `address(this)` are both refused.
    error SelfCustodyRejected(uint256 tokenId);
    /// @dev `setRenderer` and `lockRenderer` revert once the renderer has been locked.
    error RendererIsLocked();
    /// @dev A renderer must explicitly support the stable `IShapeRenderer` capability.
    error UnsupportedRenderer(address renderer);
    /// @dev A collection must explicitly support the stable `IShapeCollection` capability.
    error UnsupportedCollection(address collection);
    /// @dev A Black Shape cannot be redeemed, composed, decomposed or sacrificed again.
    ///      It remains transferable and may be destroyed through the draft ERC-8060 `burn` path.
    error TokenIsBlack(uint256 tokenId);
    /// @dev `compose` needs at least one token to burn; `split` at least two outputs.
    error EmptyRecomposition();
    /// @dev The survivor of a compose cannot also appear in its burn set.
    error CannotComposeWithSelf(uint256 tokenId);
    /// @dev A split's output denominations must sum to exactly the input's backing.
    error SplitMismatch(uint256 inputBacking, uint256 outputSum);
    /// @dev `decompose` found no compose to reverse: the survivor's compose stack is empty.
    error NoComposeRecord(uint256 survivorId);
    /// @dev `sacrifice` requires an apex Complete: 100 ETH with an origin per 0.01 unit.
    error NotApexComplete(uint256 tokenId);
    /// @dev `previewCompose` only: a burn id repeated in `burnIds`. `compose` reaches the same
    ///      outcome through `_burn`, which reverts on the second occurrence.
    error DuplicateComposeInput(uint256 tokenId);
    /// @dev Metadata copy is written verbatim into JSON, so a value is rejected when it carries a
    ///      `"`, a `\`, or a C0 control byte (which would break or restructure the document), is
    ///      not well-formed UTF-8 (which a strict consumer would reject), or exceeds its length
    ///      cap. `field` is 0 name/prefix, 1 description.
    error InvalidCopy(uint8 field);
    /// @dev A nonzero position resolver must contain deployed code when configured.
    error InvalidPositionResolver();
    /// @dev The position resolver cannot be changed or locked again after its permanent lock.
    error PositionResolverIsLocked();
    /// @dev Reverted by `IShapeLens.composeRecordAt` when `depth >= composeDepth(survivorId)`,
    ///      checked against `composeDepth` there rather than inside `composeRecordHeaderAt`.
    error ComposeRecordOutOfRange(uint256 survivorId, uint256 depth, uint256 depthAvailable);
    /// @dev `splitOriginRaw` requires `tokenId` to have been minted as a split child. Original
    ///      mints and re-minted decompose outputs never carry an entry.
    error NotASplitChild(uint256 tokenId);
    /* ----------------------- fee and deployment reads ----------------------- */

    /// @notice The mint fee in basis points of the backing, charged on top of it. 100 is 1%.
    ///         Never enters backing. Set at construction, never changeable.
    function feeBps() external view returns (uint256);

    /// @notice The mint fee in wei for a given backing amount: `amountWei * feeBps / 10000`.
    function mintFeeFor(uint256 amountWei) external view returns (uint256);

    /// @notice Where mint fees are currently forwarded. Admin-updateable for future mints.
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

    /// @notice The current holder of Shape #0, or zero while #0 does not exist.
    /// @dev This collectible ownership carries no administrative authority.
    function owner() external view returns (address);

    /// @notice The onchain renderer. Replaceable by the admin via `setRenderer` until locked.
    function renderer() external view returns (address);

    /// @notice Whether the renderer has been permanently locked.
    function rendererLocked() external view returns (bool);

    /// @notice The collection metadata contract, read only by `contractURI`. Replaceable by the
    ///         admin via `setCollection` until `lockRenderer` freezes it.
    function collection() external view returns (address);

    /// @notice The per-token metadata name prefix. A token's `name` is this followed by its id.
    function tokenNamePrefix() external view returns (string memory);

    /// @notice The shared description emitted by both token metadata and `contractURI`.
    function description() external view returns (string memory);

    /// @notice Optional canonical resolver for external Shape positions. Zero means none configured.
    function positionResolver() external view returns (address);

    /// @notice Whether the resolver value has been permanently frozen, including a frozen zero.
    function positionResolverLocked() external view returns (bool);

    /* ----------------------------- renderer ---------------------------- */

    /// @notice Replace the onchain renderer. Admin only, and only while unlocked. The renderer
    ///         is read only by `tokenURI`; changing it affects how a Shape looks, never its
    ///         backing, redeemability or owner. `newRenderer` must carry code.
    function setRenderer(address newRenderer) external;

    /// @notice Replace the collection metadata contract. Admin only, and only while unlocked.
    ///         Read only by `contractURI`; it can never touch ETH, backing or ownership.
    ///         `newCollection` must carry code and support `IShapeCollection`.
    function setCollection(address newCollection) external;

    /// @notice Permanently lock presentation. Admin only, one way. After this neither the
    ///         renderer nor the collection can change again. Does not freeze the metadata copy,
    ///         which the admin keeps editing via `setMetadataCopy`.
    function lockRenderer() external;

    /// @notice Atomically set the token name prefix and the description shared with `contractURI`.
    ///         Admin only. Emits both ERC-4906 `BatchMetadataUpdate` and `ContractURIUpdated`.
    /// @dev Written verbatim into metadata JSON, so all arguments must be well-formed UTF-8,
    ///      length-capped (64-byte names, 2048-byte description), and free of bytes JSON forbids
    ///      unescaped (`"`, `\`, C0 controls). Not affected by `lockRenderer`; copy is never frozen.
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_) external;

    /* ---------------------- position resolver admin -------------------- */

    /// @notice Set, replace or clear the optional resolver. Admin only, while unlocked.
    /// @dev Zero clears it; a nonzero resolver must contain deployed code. No resolver call occurs.
    function setPositionResolver(address resolver_) external;

    /// @notice Permanently freeze the current resolver value. Admin only; may lock while zero.
    function lockPositionResolver() external;

    /* ---------------------------- minting ----------------------------- */

    /// @notice Mint one Shape backed by `amountWei`, to the caller.
    /// @dev `msg.value` must equal exactly `amountWei + mintFeeFor(amountWei)`.
    function mint(uint256 amountWei) external payable returns (uint256 tokenId);

    /// @notice Mint one Shape backed by `amountWei`, to `to`.
    /// @dev The recipient does not feed the seed, so naming one cannot be used to search for a
    ///      particular artwork. `to` must be able to receive an ERC721.
    function mintTo(uint256 amountWei, address to) external payable returns (uint256 tokenId);

    /// @notice Mint `quantity` Shapes, each backed by `amountWei`, to the caller.
    /// @dev `msg.value` must equal exactly `quantity * (amountWei + mintFeeFor(amountWei))`.
    ///      Each token receives a distinct id and a distinct seed.
    function mintBatch(uint256 amountWei, uint256 quantity) external payable returns (uint256 firstTokenId);

    /// @notice Mint `quantity` Shapes, each backed by `amountWei`, to `to`.
    function mintBatchTo(uint256 amountWei, uint256 quantity, address to)
        external
        payable
        returns (uint256 firstTokenId);

    /* --------------------------- redemption --------------------------- */

    /// @notice Burn a Shape and receive exactly its backing.
    /// @dev Callable only by the current owner. All or nothing; there is no partial redemption.
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
    ///         a valid denomination. Origins are summed onto the survivor.
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
    ///         composes reverse newest first (LIFO); reverts `NoComposeRecord` if none remain.
    function decompose(uint256 survivorId) external returns (uint256[] memory restoredIds);

    /// @notice Reverse the survivor's most recent compose, safely minting the restored inputs to
    ///         `recipient` instead of the caller.
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
    ///         each output filled to capacity in listed order.
    function split(uint256 tokenId, uint8[] calldata outDenoms) external returns (uint256[] memory newIds);

    /// @notice Split a caller-owned Shape and safely mint every child to `recipient`.
    function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        external
        returns (uint256[] memory newIds);

    /// @notice Permanently sacrifice an apex Complete Shape's 100 ETH backing, turning it Black.
    ///         Owner only, one way. The token keeps its id, seed and geometry; its 100 ETH is sent
    ///         to an unspendable address and it becomes non-redeemable and non-recomposable. The
    ///         resulting zero-value Black Shape remains transferable and may be burned for zero.
    function sacrifice(uint256 tokenId) external;

    /* ----------------------------- views ------------------------------ */

    /// @notice ETH available to redeem now, across every live non-Black Shape.
    function redeemableBacking() external view returns (uint256);

    /// @notice Cumulative backing sacrificed by Black Shapes. Monotonic; 100 ETH per Black Shape.
    function sacrificedBacking() external view returns (uint256);

    /// @notice Number of Shapes ever sacrificed into Black. Monotonic even after a Black burn.
    function blackCount() external view returns (uint256);

    /// @notice Whether a live token is Black.
    function isBlack(uint256 tokenId) external view returns (bool);

    /// @notice Whether `tokenId` is currently a live Shape.
    /// @dev Never reverts. False for never-issued and burned ids, including ids consumed by
    ///      compose or replaced by split; true for live Black Shapes.
    function exists(uint256 tokenId) external view returns (bool);

    /// @notice ETH backing a live Shape.
    function backingOf(uint256 tokenId) external view returns (uint256);

    /// @notice The denomination-ladder index (0..8) currently stored by a live Shape.
    /// @dev Reverts for a nonexistent id. Black Shapes retain and return apex index 8.
    function denomIndexOf(uint256 tokenId) external view returns (uint8);

    /// @notice Canonical external position reported for `tokenId`, or zero when none is reported.
    /// @dev Does not require a live token. Resolver results are unvalidated; failures return zero.
    function positionOf(uint256 tokenId) external view returns (address);

    /// @notice The immutable visual seed of a live Shape.
    function seedOf(uint256 tokenId) external view returns (bytes32);

    /// @notice Independent direct-mint origins credited to a live Shape (one per mint, conserved).
    function originCountOf(uint256 tokenId) external view returns (uint256);

    /// @notice A live Shape's ink gene (0..6). Assigned at mint; evolves only through `compose`.
    function inkGeneOf(uint256 tokenId) external view returns (uint8);

    /// @notice A live Shape's raw materialized module array (`ModuleCodec`), empty when its
    ///         geometry derives from `seed` under grammar v1. The minimal raw accessor
    ///         `ShapeLens` reads to assemble the rich views moved off this contract; the lens reads
    ///         the other required state-owned fact directly through `denomIndexOf`.
    function modulesOf(uint256 tokenId) external view returns (bytes memory);

    /// @notice Collection-level metadata URI, read from the renderer.
    function contractURI() external view returns (string memory);

    /// @notice Stable numeric formation class; metadata strings are presentation only.
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);

    /// @notice Whether a Shape is Complete: not Black, above the minimum tier, and carrying one
    ///         origin per 0.01 unit of backing (`originCount == backing / 0.01`).
    function isComplete(uint256 tokenId) external view returns (bool);

    /// @notice Number of live Shapes.
    function totalSupply() external view returns (uint256);

    /// @notice The id counter: the next id to be issued, and one past the highest id ever issued
    ///         (ids start at 0). Not a live-supply or mint count — `decompose` re-mints ids
    ///         without advancing it, and burns do not decrease it. Use `totalSupply` for live count.
    function totalMinted() external view returns (uint256);

    /// @notice The survivor's compose-stack depth: how many stacked composes `decompose` can still
    ///         reverse, newest first. Zero means nothing to decompose.
    function composeDepth(uint256 survivorId) external view returns (uint256);

    /// @notice Raw accessor for one compose record's survivor-side fields on `survivorId`'s stack
    ///         at `depth` (0 the oldest, `composeDepth(survivorId) - 1` the newest, next in line
    ///         for `decompose`), plus the record's input count. `ShapeLens.composeRecordAt`
    ///         combines this with `composeRecordInputAt` to reassemble the full
    ///         `ComposeRecordView` (IShapeLens); declared here rather than as a rich struct getter
    ///         to keep this contract's runtime bytecode under the EIP-170 size limit.
    /// @dev No `depth` bounds check: an out-of-range `depth` panics on the storage array access
    ///      rather than reverting `ComposeRecordOutOfRange`. `ShapeLens.composeRecordAt` checks
    ///      `depth` against `composeDepth` itself and reverts that error before calling this.
    function composeRecordHeaderAt(uint256 survivorId, uint256 depth)
        external
        view
        returns (
            uint8 survivorDenomIndex,
            uint32 survivorOriginCount,
            uint8 survivorInkGene,
            bytes memory survivorModules,
            uint256 inputCount
        );

    /// @notice Raw accessor for one burned input's fields within the compose record at
    ///         `(survivorId, depth)`, indexed 0..`inputCount - 1` as reported by
    ///         `composeRecordHeaderAt`. See `IShapeLens.composeRecordAt` for the reassembled view.
    /// @dev Reverts with the standard out-of-bounds panic for an `inputIndex` at or beyond the
    ///      record's input count.
    function composeRecordInputAt(uint256 survivorId, uint256 depth, uint256 inputIndex)
        external
        view
        returns (
            uint256 id,
            bytes32 seed,
            uint8 denomIndex,
            uint32 originCount,
            uint8 inkGene,
            bytes memory modules
        );

    /// @notice The split that minted `childId`: the parent's pre-split seed, denomination index,
    ///         ink gene and effective module snapshot (SAMPLING_SPEC.md), plus `childId`'s index
    ///         among that split's outputs. A caller re-runs `GeometrySampling.sampleSplitChild`
    ///         with this data and the child's own denomination index to reproduce the child's
    ///         module bytes as sampled at split time.
    /// @dev The record is written once per split and shared by every child of that split; only
    ///      `childIndex` distinguishes them. It survives the child's own later mutation (e.g. the
    ///      child subsequently used as a compose survivor): this view answers how the token was
    ///      created, not what it currently looks like, so it keeps answering even though
    ///      `IShapeLens.shapeState(childId).modules` has since moved on to a later operation's
    ///      result. Reverts `NotASplitChild` for a token that was never minted by `split`/
    ///      `splitTo` (an original mint, or an input re-minted verbatim by `decompose`). Already
    ///      minimal (a passthrough, no struct assembly), so `ShapeLens.splitOriginOf` returns this
    ///      unchanged rather than reassembling anything.
    function splitOriginRaw(uint256 childId)
        external
        view
        returns (
            bytes32 parentSeed,
            uint8 parentDenomIndex,
            uint8 parentInkGene,
            bytes memory parentModules,
            uint256 childIndex
        );

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

    /// @notice Grid a denomination maps to. Reverts for unsupported amounts.
    function gridForAmount(uint256 amountWei) external pure returns (uint256 cols, uint256 rows);

    /// @notice Module count a denomination maps to.
    function modulesForAmount(uint256 amountWei) external pure returns (uint256);
}

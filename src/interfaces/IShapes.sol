// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ShapeChildPreview, ShapeFormation, ShapeState} from "./IShapeCapabilities.sol";

/// @title IShapes
/// @notice ETH wrapped into unique ERC721 objects at nine fixed denominations.
/// @dev A Shape holds an exact amount of ETH. Redeeming it burns the token and returns exactly
///      that amount to its owner. The only other way ETH leaves the reserve is `blacken`, which
///      sends a fixed 100 ETH to an unspendable address and is callable only by an apex Complete
///      Shape's owner. No pause, no upgrade path, no recovery function, and no admin path reaches
///      the reserve; the sole owner power is replacing the (value-inert) renderer until it locks.
interface IShapes is IERC721 {
    /// @notice Emitted when a Shape is minted. `originCount` is always 1: a mint is the sole
    ///         source of new origins. A strict origin-creation signal; recomposition does not
    ///         emit it.
    event ShapeMinted(
        uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount
    );

    /// @notice Emitted when a Shape is burned and its backing returned.
    /// @notice Emitted when a Shape is redeemed for its backing. `originCount` is the redeemed
    ///         token's origin credit, carried so an event-only indexer can track the global
    ///         origin balance (mint origins − redeemed origins) without a pre-burn state read.
    event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount);

    /// @notice Emitted once per mint call, when the aggregate fee is forwarded.
    event MintFeePaid(address indexed recipient, uint256 amountWei, uint256 quantity);

    /// @notice Emitted when the owner replaces the onchain renderer.
    event RendererUpdated(address indexed renderer);

    /// @notice Emitted when the renderer is permanently locked. It cannot change afterwards.
    event RendererLocked();

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
    ///         `parentSeed` is the input's seed, from which every child seed derives; it keys the
    ///         split record that `restore` later verifies against.
    event Split(
        uint256 indexed tokenId,
        bytes32 indexed parentSeed,
        uint256[] newIds,
        uint8[] outDenoms,
        uint32[] originCounts
    );

    /// @notice Emitted when a split's complete child set is reassembled into the original. The
    ///         children are burned and `newTokenId` carries the parent's seed and denomination,
    ///         so its artwork is identical to the split input's. `originCount` is the summed
    ///         child origins, equal to the split input's count by conservation.
    event Restored(
        uint256 indexed newTokenId,
        bytes32 indexed parentSeed,
        uint256[] childIds,
        uint8 denomIndex,
        uint32 originCount
    );

    /// @notice Emitted when an apex Complete Shape is blackened. `sacrificedWei` (100 ETH) is sent
    ///         to a provably unspendable address and is never redeemable again.
    event Blackened(uint256 indexed tokenId, uint256 sacrificedWei);

    /// @notice Emitted whenever a token's ink gene is assigned or changes: once per mint, once
    ///         per compose (the survivor), once per split child, once per restore.
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

    /// @notice Filterable restoration edge. Emitted once for every consumed child.
    event ShapeReassembledFrom(
        uint256 indexed newTokenId, uint256 indexed childId, bytes32 indexed parentSeed
    );

    /// @notice Filterable decompose edge. Emitted once for every input re-minted under its original
    ///         id when a survivor's compose is reversed, in addition to the aggregate `Decomposed`.
    event ShapeRevived(uint256 indexed survivorId, uint256 indexed revivedId);

    error UnsupportedDenomination(uint256 amountWei);
    error IncorrectPayment(uint256 expected, uint256 provided);
    error ZeroQuantity();
    error NotShapeOwner(uint256 tokenId, address caller);
    error EthTransferFailed(address to, uint256 amountWei);
    /// @notice A recipient-directed redemption named the zero address, which would burn the payout.
    error InvalidRecipient(address recipient);
    error MintFeeTransferFailed(address recipient, uint256 amountWei);
    error DirectDepositRejected();
    /// @dev A Shape held by the Shapes contract itself could never be redeemed, because the
    ///      contract can never be `msg.sender`. Both minting and transferring to it are
    ///      refused rather than allowing a token to become permanently unredeemable.
    error SelfCustodyRejected(uint256 tokenId);
    /// @dev `setRenderer` and `lockRenderer` revert once the renderer has been locked.
    error RendererIsLocked();
    /// @dev A renderer must explicitly support the stable `IShapeRenderer` capability.
    error UnsupportedRenderer(address renderer);
    /// @dev A Black Shape is terminal: it cannot be redeemed, composed, decomposed or split.
    error TokenIsBlack(uint256 tokenId);
    /// @dev `compose` needs at least one token to burn; `split` at least two outputs.
    error EmptyRecomposition();
    /// @dev The survivor of a compose cannot also appear in its burn set.
    error CannotComposeWithSelf(uint256 tokenId);
    /// @dev A split's output denominations must sum to exactly the input's backing.
    error SplitMismatch(uint256 inputBacking, uint256 outputSum);
    /// @dev `decompose` found no compose to reverse: the survivor's compose stack is empty.
    error NoComposeRecord(uint256 survivorId);
    /// @dev `blacken` requires an apex Complete: 100 ETH with an origin per 0.01 unit.
    error NotApexComplete(uint256 tokenId);
    /// @dev `restore` found no split record for the given parent seed. Either no such split
    ///      happened, or its children were already reassembled.
    error NoSplitRecord(bytes32 parentSeed);
    /// @dev `restore` was given a different number of children than the split produced.
    error RestoreCountMismatch(uint256 expected, uint256 provided);
    /// @dev The child at `index` does not carry the seed the split assigned to that position.
    error RestoreChildMismatch(uint256 tokenId, uint256 index);
    /// @dev The children's summed backing no longer equals the split input's backing. A child's
    ///      denomination can only have grown, via compose, since the split.
    error RestoreBackingMismatch(uint256 expected, uint256 provided);
    /// @dev `simulateCompose` only: a burn id repeated in `burnIds`. `compose` itself needs no
    ///      dedicated check for this — the second occurrence's `_burn` reverts, because the
    ///      first occurrence already consumed the token — but `simulateCompose` touches no
    ///      state, so there is nothing for a second occurrence to fail against without an
    ///      explicit check.
    error DuplicateComposeInput(uint256 tokenId);

    /* --------------------------- immutables --------------------------- */

    /// @notice The mint fee in basis points of the backing, charged on top of it. 100 is 1%.
    ///         Never enters backing. Set at construction, never changeable.
    function feeBps() external view returns (uint256);

    /// @notice The mint fee in wei for a given backing amount: `amountWei * feeBps / 10000`.
    function mintFeeFor(uint256 amountWei) external view returns (uint256);

    /// @notice Where mint fees are forwarded. Set at construction, never changeable.
    function feeRecipient() external view returns (address);

    /// @notice The onchain renderer. Replaceable by the owner via `setRenderer` until locked.
    function renderer() external view returns (address);

    /// @notice Whether the renderer has been permanently locked.
    function rendererLocked() external view returns (bool);

    /* ----------------------------- renderer ---------------------------- */

    /// @notice Replace the onchain renderer. Owner only, and only while unlocked. The renderer
    ///         is read only by `tokenURI`; changing it affects how a Shape looks, never its
    ///         backing, redeemability or owner. `newRenderer` must carry code.
    function setRenderer(address newRenderer) external;

    /// @notice Permanently lock the renderer. Owner only, one way. After this the renderer can
    ///         never change again.
    function lockRenderer() external;

    /* ---------------------------- minting ----------------------------- */

    /// @notice Mint one Shape backed by `amountWei`.
    /// @dev `msg.value` must equal exactly `amountWei + mintFeeFor(amountWei)`.
    function mint(uint256 amountWei, address to) external payable returns (uint256 tokenId);

    /// @notice Mint `quantity` Shapes, each backed by `amountWei`.
    /// @dev `msg.value` must equal exactly `quantity * (amountWei + mintFeeFor(amountWei))`.
    ///      Each token receives a distinct id and a distinct seed.
    function mintBatch(uint256 amountWei, uint256 quantity, address to)
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
    function decomposeMany(uint256[] calldata survivorIds)
        external
        returns (uint256[][] memory restoredIds);

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

    /// @notice Reassemble a split's complete child set into the original Shape. `childIds` must
    ///         list every output of the split of the token that carried `parentSeed`, in split
    ///         order, all owned by the caller and all still at the denominations the split
    ///         assigned. The children are burned and a fresh token id is minted carrying the
    ///         parent's seed and denomination — the exact artwork of the split input. Origins are
    ///         summed back. No ETH moves and no fee is charged. The split record is consumed, so
    ///         a restored Shape must be split again before it can be restored again.
    function restore(bytes32 parentSeed, uint256[] calldata childIds) external returns (uint256 newTokenId);

    /// @notice Restore an exact split and safely mint the restored Shape to `recipient`.
    function restoreTo(bytes32 parentSeed, uint256[] calldata childIds, address recipient)
        external
        returns (uint256 newTokenId);

    /// @notice Permanently sacrifice an apex Complete Shape's 100 ETH backing, turning it Black.
    ///         Owner only, one way. The token keeps its id, seed and geometry; its 100 ETH is sent
    ///         to an unspendable address and it becomes non-redeemable and non-recomposable.
    function blacken(uint256 tokenId) external;

    /* ----------------------------- views ------------------------------ */

    /// @notice ETH available to redeem now, across every live non-Black Shape.
    function redeemableBacking() external view returns (uint256);

    /// @notice Cumulative backing sacrificed by Black Shapes. Monotonic; 100 ETH per Black Shape.
    function sacrificedBacking() external view returns (uint256);

    /// @notice Number of Black Shapes. Monotonic.
    function blackCount() external view returns (uint256);

    /// @notice Whether a token has been blackened.
    function isBlack(uint256 tokenId) external view returns (bool);

    /// @notice ETH backing a live Shape.
    function backingOf(uint256 tokenId) external view returns (uint256);

    /// @notice The immutable visual seed of a live Shape.
    function seedOf(uint256 tokenId) external view returns (bytes32);

    /// @notice Independent direct-mint origins credited to a live Shape (one per mint, conserved).
    function originCountOf(uint256 tokenId) external view returns (uint256);

    /// @notice A live Shape's ink gene (0..6). Assigned at mint; evolves only through `compose`.
    function inkGeneOf(uint256 tokenId) external view returns (uint8);

    /// @notice AutoGlyph-style Unicode rendering of a live Shape's canonical module grid.
    /// @dev Cells are separated by spaces and rows by newlines. This is intended for display;
    ///      integrations that need machine-readable geometry should call `IShapeGeometry` on
    ///      `renderer()` instead.
    function unicodeCard(uint256 tokenId) external view returns (string memory);

    /// @notice Every protocol fact about a live Shape in one canonical read.
    function shapeState(uint256 tokenId) external view returns (ShapeState memory);

    /// @notice Stable numeric formation class; metadata strings are presentation only.
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);

    /// @notice Preview the gene and denomination `compose(survivorId, burnIds)` would produce,
    ///         without moving state or requiring caller ownership. Mirrors `compose`'s
    ///         validation (existence, not-Black, no self-burn, no duplicate id, the summed
    ///         backing lands on a denomination).
    function simulateCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (uint8 newGene, uint8 newDenomIndex);

    /// @notice Preview a split's child gene: trivially `inkGeneOf(tokenId)`, since every
    ///         child of a split inherits the parent's gene verbatim. Included for interface
    ///         symmetry with `simulateCompose`.
    function simulateSplit(uint256 tokenId) external view returns (uint8 childGene);

    /// @notice Complete deterministic state that `compose` would produce.
    function previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory result);

    /// @notice Validate a split and return every deterministic child before changing state.
    function previewSplit(uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children);

    /// @notice Validate an exact restoration and return its deterministic resulting state.
    function previewRestore(bytes32 parentSeed, uint256[] calldata childIds)
        external
        view
        returns (ShapeState memory result);

    /// @notice Whether a Shape is Complete: not Black, above the minimum tier, and carrying one
    ///         origin per 0.01 unit of backing (`originCount == backing / 0.01`).
    function isComplete(uint256 tokenId) external view returns (bool);

    /// @notice Number of live Shapes.
    function totalSupply() external view returns (uint256);

    /// @notice Number of Shapes ever minted. Also the highest token id issued.
    function totalMinted() external view returns (uint256);

    /// @notice The split record keyed by a parent seed: how many children the split produced and
    ///         the input's denomination index. `childCount` of zero means no restorable split —
    ///         none happened, or it was already restored. Written by `split`, consumed by
    ///         `restore`.
    function splitRecordOf(bytes32 parentSeed) external view returns (uint16 childCount, uint8 denomIndex);

    /// @notice The survivor's compose-stack depth: how many stacked composes `decompose` can still
    ///         reverse, newest first. Zero means nothing to decompose.
    function composeDepth(uint256 survivorId) external view returns (uint256);

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

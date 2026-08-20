// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ShapeChildPreview, ShapeFormation, ShapeState} from "./IShapeCapabilities.sol";
import {IERC721Value} from "./IERC721Value.sol";

/// @title IShapes
/// @notice ETH wrapped into unique ERC721 objects at nine fixed denominations.
/// @dev A Shape holds an exact amount of ETH. Redeeming or burning it destroys the token and
///      returns exactly that amount to its owner. The other reserve outflow is `sacrifice`, which
///      sends a fixed 100 ETH to an unspendable address and is callable only by an apex Complete
///      Shape's owner. No pause, upgrade path, recovery function or admin path reaches the reserve.
///      The owner may administer and independently lock the value-inert renderer and optional
///      position resolver; ownership itself is transferable and renounceable.
interface IShapes is IERC721, IERC721Value {
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

    /// @notice Emitted when the owner replaces the onchain renderer.
    event RendererUpdated(address indexed renderer);

    /// @notice Emitted when the owner replaces the collection metadata contract.
    event CollectionUpdated(address indexed collection);

    /// @notice Emitted when title to Shapes passes to a new holder, and once at deployment with
    ///         `previousHolder` as the zero address. The full chain of custody is these events;
    ///         the contract stores only the current holder.
    event TitleTransferred(address indexed previousHolder, address indexed newHolder);

    /// @notice Emitted when the renderer is permanently locked. It cannot change afterwards.
    event RendererLocked();

    /// @notice Emitted when the owner updates the per-token metadata copy (name prefix, description).
    event TokenCopyUpdated(string namePrefix, string description);

    /// @notice Emitted when the owner updates the collection metadata copy (name, description).
    event CollectionCopyUpdated(string name, string description);

    /// @notice Standard contract-level metadata refresh signal, emitted when the collection copy changes.
    event ContractURIUpdated();

    /// @notice Emitted when the owner sets, replaces or clears the optional position resolver.
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

    error UnsupportedDenomination(uint256 amountWei);
    error IncorrectPayment(uint256 expected, uint256 provided);
    error ZeroQuantity();
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
    /// @dev Only the current title holder may pass the title on. The contract owner cannot.
    error NotTitleHolder();
    /// @dev The title cannot be sent to the zero address or to this contract, at construction or
    ///      afterwards.
    error InvalidTitleRecipient();
    /// @dev The recipient already holds the title.
    error TitleAlreadyHeldByRecipient();
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

    /// @notice The collection metadata contract, read only by `contractURI`. Replaceable by the
    ///         owner via `setCollection` until `lockRenderer` freezes it.
    function collection() external view returns (address);

    /// @notice The per-token metadata name prefix. A token's `name` is this followed by its id.
    function tokenNamePrefix() external view returns (string memory);

    /// @notice The per-token metadata description, emitted verbatim in every token's metadata.
    function tokenDescription() external view returns (string memory);

    /// @notice The collection `name` used by `contractURI`.
    function collectionName() external view returns (string memory);

    /// @notice The collection `description` used by `contractURI`.
    function collectionDescription() external view returns (string memory);

    /// @notice Optional canonical resolver for external Shape positions. Zero means none configured.
    function positionResolver() external view returns (address);

    /// @notice Whether the resolver value has been permanently frozen, including a frozen zero.
    function positionResolverLocked() external view returns (bool);

    /* ----------------------------- renderer ---------------------------- */

    /// @notice Replace the onchain renderer. Owner only, and only while unlocked. The renderer
    ///         is read only by `tokenURI`; changing it affects how a Shape looks, never its
    ///         backing, redeemability or owner. `newRenderer` must carry code.
    function setRenderer(address newRenderer) external;

    /// @notice Replace the collection metadata contract. Owner only, and only while unlocked.
    ///         Read only by `contractURI`; it can never touch ETH, backing or ownership.
    ///         `newCollection` must carry code and support `IShapeCollection`.
    function setCollection(address newCollection) external;

    /// @notice Permanently lock presentation. Owner only, one way. After this neither the
    ///         renderer nor the collection can change again. Does not freeze the metadata copy,
    ///         which the owner keeps editing via `setTokenCopy` / `setCollectionCopy`.
    function lockRenderer() external;

    /// @notice Set the per-token metadata copy: the `name` prefix and the `description`. Owner
    ///         only. Emits ERC-4906 `BatchMetadataUpdate` so marketplaces refresh every token.
    /// @dev Written verbatim into each token's metadata JSON, so both arguments are validated:
    ///      each must be well-formed UTF-8 within its length cap (64-byte prefix, 2048-byte
    ///      description) and free of the bytes JSON forbids unescaped (`"`, `\`, C0 controls);
    ///      anything else reverts `InvalidCopy`. This keeps copy from breaking the document and
    ///      from producing bytes a conformant consumer would reject. Not affected by
    ///      `lockRenderer`; copy is never frozen.
    function setTokenCopy(string calldata namePrefix, string calldata description) external;

    /// @notice Set the collection metadata copy: the `name` and the `description` used by
    ///         `contractURI`. Owner only. Emits `ContractURIUpdated`.
    /// @dev Same validation and length caps as `setTokenCopy`; reverts `InvalidCopy` otherwise.
    function setCollectionCopy(string calldata name, string calldata description) external;

    /* ---------------------- position resolver admin -------------------- */

    /// @notice Set, replace or clear the optional resolver. Owner only, while unlocked.
    /// @dev Zero clears it; a nonzero resolver must contain deployed code. No resolver call occurs.
    function setPositionResolver(address resolver_) external;

    /// @notice Permanently freeze the current resolver value. Owner only; may lock while zero.
    function lockPositionResolver() external;

    /* ------------------------------ title ----------------------------- */

    /// @notice Who currently holds title to Shapes as a whole.
    /// @dev Cultural title to the work and the protocol, recorded by the contract itself. It is
    ///      not a token: there is no title NFT, no companion collection and no reserved Shape.
    ///      This contract is the only source of truth for it.
    ///
    ///      The title confers no authority. Its holder cannot reach the reserve, the mint fees,
    ///      the fee recipient, any Shape, the renderer, the collection, the position resolver or
    ///      administrative ownership, and it grants no intellectual property or legal right. The
    ///      one capability it carries is `transferTitle`.
    ///
    ///      Distinct from `owner()`, which holds narrow configuration authority. The two roles
    ///      may sit at one address or at different ones, and neither constrains the other:
    ///      ownership can be renounced with the title still transferable.
    function titleHolder() external view returns (address);

    /// @notice When the current holder received the title, as a unix timestamp. Deployment for
    ///         the first holder.
    function titleSince() external view returns (uint64);

    /// @notice Pass title to `to`. Current holder only.
    /// @dev Immediate and unconditional: one transaction, no pending state, no approval, and no
    ///      acceptance by the recipient. The previous holder loses the title in the same call and
    ///      the new one may pass it on immediately. Moves no ETH, calls nothing, and alters no
    ///      Shape, no accounting and no configuration.
    ///
    ///      A bearer instrument, deliberately. Sending the title to a contract that cannot itself
    ///      call `transferTitle`, or to an address whose key is lost, strands it permanently.
    ///      There is no administrative recovery, because an owner able to recover the title would
    ///      be an owner able to take it.
    function transferTitle(address to) external;

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

    /// @notice ETH backing a live Shape.
    function backingOf(uint256 tokenId) external view returns (uint256);

    /// @notice Canonical external position reported for `tokenId`, or zero when none is reported.
    /// @dev Does not require a live token. Resolver results and failures propagate without validation.
    function positionOf(uint256 tokenId) external view returns (address);

    /// @notice The immutable visual seed of a live Shape.
    function seedOf(uint256 tokenId) external view returns (bytes32);

    /// @notice Independent direct-mint origins credited to a live Shape (one per mint, conserved).
    function originCountOf(uint256 tokenId) external view returns (uint256);

    /// @notice A live Shape's ink gene (0..6). Assigned at mint; evolves only through `compose`.
    function inkGeneOf(uint256 tokenId) external view returns (uint8);

    /// @notice Collection-level metadata URI, read from the renderer.
    function contractURI() external view returns (string memory);

    /// @notice AutoGlyph-style Unicode rendering of a live Shape's canonical module grid.
    /// @dev Cells are separated by spaces and rows by newlines. This is intended for display;
    ///      integrations that need machine-readable geometry should call `IShapeGeometry` on
    ///      `renderer()` instead.
    function unicodeCard(uint256 tokenId) external view returns (string memory);

    /// @notice Every protocol fact about a live Shape in one canonical read.
    function shapeState(uint256 tokenId) external view returns (ShapeState memory);

    /// @notice Stable numeric formation class; metadata strings are presentation only.
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);

    /// @notice The state `compose(survivorId, burnIds)` would produce. Requires no caller
    ///         ownership and moves no state. Applies compose's validation: existence, not-Black,
    ///         no self-burn, no duplicate id, and a summed backing that lands on a denomination.
    function previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory result);

    /// @notice Validate a split and return every deterministic child before changing state.
    function previewSplit(uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children);

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

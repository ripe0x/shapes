// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Value} from "shapes/interfaces/IERC721Value.sol";

/// @notice One pack, read in a single call.
struct PackState {
    uint256[] shapeIds;
    uint32[] counts; // Shapes per ladder index
    uint256 valueWei; // cached; equals the live sum of backingOf over shapeIds
    uint256 mintedCount; // Shapes the pack minted itself, at creation and in additions
    address creator;
}

/// @title IShapePacks
/// @notice Bundles of Shapes as one ERC-721. A pack custodies live, non-Black Shapes; its value is
///         exactly the sum of theirs. Contents can only grow while the pack is live: the holder
///         may add, nobody can remove. Exit is all-or-nothing at the token level: `open` returns
///         the Shapes, `redeem` unwraps them to ETH, and `unseal` + `claim`/`claimEth` do the same
///         in chunks for packs too large for one block.
///
/// @dev Custody rules follow `ShapeCardEscrow`: Shapes are pulled with `transferFrom` from the
///      caller only, minted into the contract through a receiver window that admits nothing else,
///      and pushed out with `transferFrom`. The contract never calls a Shapes mutator other than
///      `mintBatchTo` and `redeemBatchTo`, never approves anyone, never holds ETH, and has no
///      admin path into custody. The admin role reaches presentation only.
///
///      Every pull is `transferFrom(msg.sender, this, id)`, so an approval granted to this
///      contract can only be exercised by the approver's own call.
interface IShapePacks is IERC721, IERC721Value {
    /* ------------------------------- events ------------------------------- */

    /// @notice A pack was created. `shapeIds` lists pulled Shapes first, then minted ones.
    event PackCreated(
        uint256 indexed packId,
        address indexed creator,
        address indexed to,
        uint256[] shapeIds,
        uint256 pulledCount,
        uint256 valueWei
    );

    /// @notice Shapes were added to a live pack by its owner. `valueWei` is the new total.
    event PackExtended(
        uint256 indexed packId,
        address indexed by,
        uint256[] shapeIds,
        uint256 pulledCount,
        uint256 addedValueWei,
        uint256 valueWei
    );

    /// @notice The pack token was burned; `count` Shapes remain as `claimant`'s claim. Emitted
    ///         by every exit path, single-transaction or chunked.
    event PackUnsealed(
        uint256 indexed packId, address indexed owner, address indexed claimant, uint256 count
    );

    /// @notice Shapes left an unsealed pack to `to`.
    event ShapesClaimed(uint256 indexed packId, address indexed to, uint256[] shapeIds);

    /// @notice Shapes left an unsealed pack as ETH, paid by Shapes to `recipient` in one transfer.
    event EthClaimed(uint256 indexed packId, address indexed recipient, uint256[] shapeIds, uint256 valueWei);

    event RendererUpdated(address indexed renderer);
    event MetadataCopySet(string tokenNamePrefix, string description);
    event PresentationLocked(address indexed renderer);
    /// @notice ERC-7572.
    event ContractURIUpdated();
    /// @notice ERC-4906.
    event MetadataUpdate(uint256 _tokenId);
    /// @notice ERC-4906.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    /* ------------------------------- errors ------------------------------- */

    /// @notice A creation or addition named no Shape to pull and none to mint.
    error NoShapes();
    /// @notice `mintCounts.length` is not the Shapes denomination count.
    error MakeupLengthMismatch();
    /// @notice `msg.value` is not exactly the cost of the requested mints.
    error IncorrectPayment(uint256 expected, uint256 provided);
    /// @notice The Shape has zero backing (it is Black) and cannot be packed.
    error WorthlessShape(uint256 shapeId);
    /// @notice A new pack's backing is under `MIN_PACK_VALUE`.
    error PackBelowMinimum(uint256 valueWei, uint256 minimum);
    /// @notice The caller is not the pack's owner. Approval is not enough.
    error NotPackOwner(uint256 packId, address caller);
    /// @notice The caller is not the recorded claimant of an unsealed pack.
    error NotClaimant(uint256 packId, address caller);
    /// @notice The pack has nothing left to claim, or was never unsealed.
    error NothingToClaim(uint256 packId);
    error ZeroQuantity();
    error InvalidRecipient(address recipient);
    /// @notice A Shape arrived through `safeTransferFrom` outside the mint window.
    error UnsolicitedToken(address from);
    error DirectDepositRejected();
    /// @notice `defaultMakeup` was asked for an amount that is not a whole number of units.
    error NotAUnitMultiple(uint256 amountWei);
    error PresentationIsLocked();
    /// @notice The renderer has no code or does not answer ERC-165 for `IShapePackRenderer`.
    error UnsupportedRenderer(address renderer);
    /// @notice A copy field is too long or not JSON-safe. 0 is the name prefix, 1 the description.
    error InvalidCopy(uint8 field);
    error AdminUnauthorizedAccount(address account);
    error AdminInvalidAdmin(address admin);
    /// @notice A pack token may not be held by this contract: it could never be opened.
    error SelfCustodyRejected(uint256 packId);

    /* --------------------------- create and extend --------------------------- */

    /// @notice Creates a pack for the caller. See `createPackTo`.
    function createPack(uint256[] calldata shapeIds, uint32[] calldata mintCounts)
        external
        payable
        returns (uint256 packId);

    /// @notice Creates a pack from Shapes the caller owns and/or Shapes minted from ETH.
    /// @dev Checked in order: `mintCounts.length == denominationCount()` (`MakeupLengthMismatch`);
    ///      at least one Shape in total (`NoShapes`); `msg.value` equals
    ///      `Σ mintCounts[d] * (denominationAt(d) + mintFee())` exactly (`IncorrectPayment`), zero
    ///      when nothing is minted; each `shapeIds[i]` has nonzero backing (`WorthlessShape`) and
    ///      is pulled with `transferFrom(msg.sender, this, id)`; each nonzero `mintCounts[d]` is
    ///      minted with one `mintBatchTo` into this contract; the total backing is at least
    ///      `MIN_PACK_VALUE` (`PackBelowMinimum`); then the pack token is `_safeMint`ed to `to`.
    /// @param shapeIds Shapes the caller owns and has approved this contract for.
    /// @param mintCounts Shapes to mint per ladder index; length must equal `denominationCount()`.
    /// @param to Recipient of the pack token. A contract must implement `IERC721Receiver`.
    function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
        external
        payable
        returns (uint256 packId);

    /// @notice Adds Shapes to a live pack. Owner-only. Same rules as creation except the floor,
    ///         which the pack already met. Emits `PackExtended` and ERC-4906 `MetadataUpdate`.
    function addToPack(uint256 packId, uint256[] calldata shapeIds, uint32[] calldata mintCounts)
        external
        payable;

    /// @notice Cost of a makeup, read live from Shapes.
    function quoteMint(uint32[] calldata mintCounts)
        external
        view
        returns (uint256 backingWei, uint256 feeWei, uint256 totalWei, uint256 shapeCount);

    /// @notice The fewest-Shapes makeup for `backingWei`: largest denomination first, as many as
    ///         fit, repeat. A prefill for a UI; `createPack` takes whatever makeup the user wants.
    function defaultMakeup(uint256 backingWei) external view returns (uint32[] memory mintCounts);

    /* -------------------------------- exit -------------------------------- */

    /// @notice Burns the pack and transfers every Shape to the caller. Owner-only.
    function open(uint256 packId) external;

    /// @notice Burns the pack and transfers every Shape to `to`. Owner-only.
    function openTo(uint256 packId, address to) external;

    /// @notice Burns the pack and redeems every Shape, paying the caller the exact total in one
    ///         transfer made by Shapes. Owner-only. `burn(packId)` is identical.
    function redeem(uint256 packId) external;

    /// @notice As `redeem`, paying `recipient`. The caller remains the one who must own the pack.
    function redeemTo(uint256 packId, address payable recipient) external;

    /// @notice Burns the pack token and records `claimant` as the only account that may drain
    ///         what remains. For packs too large for one block. Owner-only.
    function unseal(uint256 packId, address claimant) external;

    /// @notice Transfers up to `maxCount` remaining Shapes of an unsealed pack to the claimant,
    ///         from the end of the list. Claimant-only.
    function claim(uint256 packId, uint256 maxCount) external;

    /// @notice Redeems up to `maxCount` remaining Shapes of an unsealed pack to `recipient`, from
    ///         the end of the list, in one `redeemBatchTo`. Claimant-only.
    function claimEth(uint256 packId, uint256 maxCount, address payable recipient) external;

    /* -------------------------------- read -------------------------------- */

    /// @notice A live pack's contents, or an unsealed pack's remaining Shapes. Empty otherwise.
    function contentsOf(uint256 packId) external view returns (uint256[] memory shapeIds);

    /// @notice The pack a Shape is inside, or 0.
    function packOf(uint256 shapeId) external view returns (uint256 packId);

    /// @notice The claimant of an unsealed pack with Shapes remaining, or zero.
    function claimantOf(uint256 packId) external view returns (address);

    /// @notice Who created the pack. Survives unsealing.
    function creatorOf(uint256 packId) external view returns (address);

    /// @notice Shapes per ladder index for a live pack. Reverts for a pack that is not live.
    function makeupOf(uint256 packId) external view returns (uint32[] memory counts);

    /// @notice Everything about a live pack in one call. Reverts for a pack that is not live.
    function packState(uint256 packId) external view returns (PackState memory);

    /// @notice True for a live pack token. Never reverts.
    function exists(uint256 packId) external view returns (bool);

    /// @notice The Shapes token this collection wraps.
    function shapes() external view returns (address);

    /// @notice The creation floor, `3 * unit()` of the wrapped Shapes.
    function MIN_PACK_VALUE() external view returns (uint256);

    /// @notice Packs ever created. The next pack id is `totalMinted() + 1`.
    function totalMinted() external view returns (uint256);

    /// @notice Live packs.
    function totalSupply() external view returns (uint256);

    /* ---------------------------- presentation ---------------------------- */

    function admin() external view returns (address);
    function transferAdmin(address newAdmin) external;
    function renounceAdmin() external;
    function renderer() external view returns (address);
    function presentationLocked() external view returns (bool);
    function tokenNamePrefix() external view returns (string memory);
    function description() external view returns (string memory);

    /// @notice Replaces the renderer. Admin-only until `lockPresentation`.
    function setRenderer(address newRenderer) external;

    /// @notice Replaces the token name prefix (at most 64 bytes) and the shared description (at
    ///         most 2048 bytes). Both must be printable ASCII with no `"` or `\`. Admin-only until
    ///         `lockPresentation`.
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_) external;

    /// @notice Permanently freezes the renderer and the copy. Admin-only.
    function lockPresentation() external;

    /// @notice ERC-7572 collection metadata.
    function contractURI() external view returns (string memory);
}

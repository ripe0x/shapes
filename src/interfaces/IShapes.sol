// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title IShapes
/// @notice ETH wrapped into unique ERC721 objects at nine fixed denominations.
/// @dev A Shape holds an exact amount of ETH. Burning it returns exactly that amount to its
///      owner. There is no other way for ETH to leave the contract: no owner, no admin, no
///      pause, no upgrade path, no recovery function.
interface IShapes is IERC721 {
    /// @notice Emitted when a Shape is minted. `originCount` is always 1: a mint is the sole
    ///         source of new origins. A strict origin-creation signal; recomposition does not
    ///         emit it.
    event ShapeMinted(
        uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount
    );

    /// @notice Emitted when a Shape is burned and its backing returned.
    event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei);

    /// @notice Emitted once per mint call, when the aggregate fee is forwarded.
    event MintFeePaid(address indexed recipient, uint256 amountWei, uint256 quantity);

    /// @notice Emitted when the owner replaces the onchain renderer.
    event RendererUpdated(address indexed renderer);

    /// @notice Emitted when the renderer is permanently locked. It cannot change afterwards.
    event RendererLocked();

    error UnsupportedDenomination(uint256 amountWei);
    error IncorrectPayment(uint256 expected, uint256 provided);
    error ZeroQuantity();
    error NotShapeOwner(uint256 tokenId, address caller);
    error EthTransferFailed(address to, uint256 amountWei);
    error MintFeeTransferFailed(address recipient, uint256 amountWei);
    error DirectDepositRejected();
    /// @dev A Shape held by the Shapes contract itself could never be redeemed, because the
    ///      contract can never be `msg.sender`. Both minting and transferring to it are
    ///      refused rather than allowing a token to become permanently unredeemable.
    error SelfCustodyRejected(uint256 tokenId);
    /// @dev `setRenderer` and `lockRenderer` revert once the renderer has been locked.
    error RendererIsLocked();

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

    /* ----------------------------- views ------------------------------ */

    /// @notice ETH backing a live Shape.
    function backingOf(uint256 tokenId) external view returns (uint256);

    /// @notice The immutable visual seed of a live Shape.
    function seedOf(uint256 tokenId) external view returns (bytes32);

    /// @notice Independent direct-mint origins credited to a live Shape (one per mint, conserved).
    function originCountOf(uint256 tokenId) external view returns (uint256);

    /// @notice Sum of the backing of every live Shape.
    function totalBacking() external view returns (uint256);

    /// @notice Number of live Shapes.
    function totalSupply() external view returns (uint256);

    /// @notice Number of Shapes ever minted. Also the highest token id issued.
    function totalMinted() external view returns (uint256);

    /// @notice Whether `amountWei` is one of the nine supported denominations.
    function isSupportedDenomination(uint256 amountWei) external pure returns (bool);

    /// @notice Grid a denomination maps to. Reverts for unsupported amounts.
    function gridForAmount(uint256 amountWei) external pure returns (uint256 cols, uint256 rows);

    /// @notice Module count a denomination maps to.
    function modulesForAmount(uint256 amountWei) external pure returns (uint256);
}

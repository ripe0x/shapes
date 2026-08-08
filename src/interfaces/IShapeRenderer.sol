// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeRenderer
/// @notice The fully onchain renderer for Shape tokens.
/// @dev Every function is `pure`. The renderer holds no state, has no owner and no
///      initialiser; a deployed renderer's output for a given (seed, amount, tokenId) is
///      fixed for as long as the chain exists.
interface IShapeRenderer {
    /// @notice The complete SVG document for a token.
    /// @dev Takes no token id: a Shape carries no type, so its artwork is a function of its
    ///      seed and denomination alone.
    function renderSVG(bytes32 seed, uint256 amountWei) external pure returns (string memory);

    /// @notice The metadata JSON for a token, with the SVG inlined as a base64 data URI.
    function metadataJSON(bytes32 seed, uint256 amountWei, uint256 tokenId)
        external
        pure
        returns (string memory);

    /// @notice A base64 `data:application/json` URI wrapping `metadataJSON`.
    function tokenURI(bytes32 seed, uint256 amountWei, uint256 tokenId)
        external
        pure
        returns (string memory);

    /// @notice The module glyph sequence used as the `Modules` trait.
    function moduleSequence(bytes32 seed, uint256 amountWei) external pure returns (string memory);
}

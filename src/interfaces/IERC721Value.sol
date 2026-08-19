// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IERC721Value
/// @notice Draft ERC-8060 interface for ERC721 tokens carrying redeemable native ETH value.
interface IERC721Value {
    /// @notice Native ETH the current owner would receive by burning `tokenId` now.
    /// @dev Reverts for nonexistent token IDs.
    function valueOf(uint256 tokenId) external view returns (uint256);

    /// @notice Destroy `tokenId` and pay its current `valueOf` to its owner.
    /// @dev Only the current owner may burn. A zero-value token is destroyed with no ETH transfer.
    function burn(uint256 tokenId) external;
}

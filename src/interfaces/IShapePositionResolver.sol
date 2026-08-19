// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapePositionResolver
/// @notice Resolves a Shape token ID to its canonical current external position.
interface IShapePositionResolver {
    /// @notice Return the position associated with `tokenId`, or zero when none is reported.
    /// @dev The resolver defines existence, lifecycle, authorization and claim semantics.
    function positionOf(uint256 tokenId) external view returns (address);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeAuctionHouseStartTime
/// @notice The scheduled-start extension of `IShapeAuctionHouse`.
/// @dev `type(IShapeAuctionHouseStartTime).interfaceId` is the selector of this one function. A
///      house reports it through ERC-165 alongside `IShapeAuctionHouse`.
interface IShapeAuctionHouseStartTime {
    /// @notice Escrows an ERC721 and opens an auction on it, priced in Shapes, that accepts bids
    ///         from `startTime`.
    /// @param nft The collection the lot belongs to. Must have code and report the ERC721
    ///        interface under ERC165.
    /// @param duration Seconds the auction runs for once the first bid lands. At most `MAX_DURATION`.
    /// @param reserveUnits Smallest winning bid, in `UNIT` multiples.
    /// @param minIncrementBps How far a bid must clear the standing one, in basis points.
    /// @param extensionWindow A bid inside this many seconds of the end pushes the end out by it.
    ///        At most `duration`.
    /// @param startTime Unix time bids open. Zero or a past time opens the listing at creation.
    ///        At most `MAX_DURATION` after the current block time.
    function createAuction(
        address nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint16 minIncrementBps,
        uint32 extensionWindow,
        uint64 startTime
    ) external returns (uint256 auctionId);
}

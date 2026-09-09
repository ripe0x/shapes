// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeAuctionHouseStartTime
/// @notice The scheduled-start extension of `IShapeAuctionHouse`.
/// @dev `type(IShapeAuctionHouseStartTime).interfaceId` is the XOR of this interface's three
///      function selectors: the `startTime` `createAuction` overload, `MAX_START_LEAD`, and
///      `setStartTime`. A house reports it through ERC-165 alongside `IShapeAuctionHouse`.
///      `MAX_START_LEAD` lives here rather than on `IShapeAuctionHouse` because adding a function
///      to that interface would change its interface id, which `Shapes.setPointer` checks.
interface IShapeAuctionHouseStartTime {
    /// @notice The furthest into the future `startTime` may be set, in `createAuction` or
    ///         `setStartTime`, from the current block time.
    function MAX_START_LEAD() external view returns (uint64);

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
    ///        At most `MAX_START_LEAD` after the current block time.
    function createAuction(
        address nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint16 minIncrementBps,
        uint32 extensionWindow,
        uint64 startTime
    ) external returns (uint256 auctionId);

    /// @notice Moves the time bids open on an auction that has no bid yet.
    /// @dev Seller only. Reverts `InvalidAuction` when the caller is not the seller, a bid exists,
    ///      or the auction is settled. Zero or a past time opens bidding now. At most
    ///      `MAX_START_LEAD` after the current block time.
    function setStartTime(uint256 auctionId, uint64 startTime) external;
}

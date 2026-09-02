// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeCardEscrow
/// @notice The bidding surface shared by every auction denominated in Shape cards: what a bid is
///         made of, how it is valued, and how it is pulled back.
/// @dev A bid is a set of Shapes whose summed backing is the bid amount, carried in `UNIT`
///      (0.01 ETH) multiples. That is exact rather than lossy: the smallest denomination is
///      0.01 ETH and every other is a whole multiple of it, so no sum of cards lands between two
///      units. What is being sold is not described here; an implementation decides that.
interface IShapeCardEscrow {
    /// @notice Emitted when the ETH path mints cards for a bidder who brought no Shapes.
    event BidCardsMinted(uint256 indexed auctionId, address indexed bidder, uint256 backingWei);

    /// @dev A bid carried no cards and no ETH.
    error EmptyBid();
    /// @dev A card valued at zero: it does not exist, or it is Black and therefore unredeemable.
    error WorthlessCard(uint256 tokenId);
    /// @dev More cards in one bid than `MAX_CARDS_PER_BID`.
    error TooManyCards(uint256 provided);
    /// @dev The ETH path was given a backing that is not a whole multiple of `UNIT`.
    error NotAUnitMultiple(uint256 backingWei);
    error IncorrectPayment(uint256 expected, uint256 provided);
    /// @dev The bid does not clear the reserve, or the standing bid plus its increment.
    error BidTooLow(uint64 provided, uint64 required);
    /// @dev The standing leader cannot withdraw, and a bidder with nothing escrowed has nothing
    ///      to withdraw.
    error NothingToWithdraw(uint256 auctionId, address bidder);
    /// @dev ERC721s are accepted only from `shapes`, and only while minting a bid.
    error UnsolicitedToken(address from);

    /// @notice The largest number of cards one bidder may have escrowed on one auction. A minimal
    ///         set never needs more than twenty for any amount below 100 ETH, so this is headroom,
    ///         not a constraint.
    function MAX_CARDS_PER_BID() external view returns (uint256);

    /// @notice The Shapes contract every bid is denominated in.
    function shapes() external view returns (address);

    /// @notice The cards a bidder currently has escrowed on an auction.
    function escrowedCards(uint256 auctionId, address bidder) external view returns (uint256[] memory);

    /// @notice A bidder's escrowed total, in `UNIT` multiples.
    function bidUnits(uint256 auctionId, address bidder) external view returns (uint64);

    /// @notice The minimal card set for `backingWei`: `counts[i]` cards at denomination `i`.
    ///         Reverts unless `backingWei` is a whole multiple of `UNIT`.
    function cardsFor(uint256 backingWei) external pure returns (uint256[9] memory counts);

    /// @notice Exact ETH required to mint the minimal card set for `backingWei`.
    /// @dev Returns backing plus one flat Shapes mint fee for every card `cardsFor` produces.
    function mintCostFor(uint256 backingWei) external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeAuctionHouse
/// @notice An English auction for a Shape, with bids denominated in Shape cards.
/// @dev A bid is a set of Shapes whose summed backing is the bid amount. Amounts are carried in
///      `UNIT` (0.01 ETH) multiples throughout, which is the finest granularity the denomination
///      ladder can express. Escrowed cards are never moved on an outbid; every payout is pulled.
interface IShapeAuctionHouse {
    /// @notice Emitted when a seller escrows a token and opens an auction.
    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits
    );

    /// @notice Emitted when a bid takes the lead. `units` is the bidder's whole escrowed total,
    ///         not the increment, because a bidder may top up across several transactions.
    ///         `endTime` is the deadline after any anti-sniping extension this bid triggered.
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint64 units, uint64 endTime);

    /// @notice Emitted when the ETH path mints cards for a bidder who brought no Shapes.
    event BidCardsMinted(uint256 indexed auctionId, address indexed bidder, uint256 backingWei);

    /// @notice Emitted when the sold token is delivered to the winner. The winning cards stay
    ///         escrowed until the seller pulls them.
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint64 units);

    /// @notice Emitted when an auction ends with no bid and the seller reclaims the token.
    event AuctionCancelled(uint256 indexed auctionId);

    /// @notice Emitted when a losing bidder pulls their escrowed cards back.
    event BidWithdrawn(uint256 indexed auctionId, address indexed bidder, uint256 cardCount);

    /// @notice Emitted when the seller pulls the winning bid.
    event ProceedsClaimed(uint256 indexed auctionId, address indexed seller, uint256 cardCount);

    error AuctionNotFound(uint256 auctionId);
    error AuctionOver(uint256 auctionId);
    error AuctionStillRunning(uint256 auctionId);
    error AuctionAlreadySettled(uint256 auctionId);
    /// @dev `cancelAuction` was called by a non-seller, once a bid had landed, or after settlement.
    error InvalidAuction();
    /// @dev `createAuction` duration was zero or above `MAX_DURATION`.
    error DurationOutOfRange();
    /// @dev `createAuction` extension window exceeded the duration.
    error ExtensionWindowTooLong();
    /// @dev `createAuction`'s transfer left the lot unheld by the house.
    error LotNotReceived();
    /// @dev The seller bid its own auction.
    error SellerCannotBid();
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
    /// @dev The house accepts ERC721s only from `shapes`, and only while minting a bid.
    error UnsolicitedToken(address from);

    /// @notice The largest number of cards one bidder may have escrowed on one auction. A minimal set never needs more
    ///         than twenty for any amount below 100 ETH, so this is headroom, not a constraint.
    function MAX_CARDS_PER_BID() external view returns (uint256);

    /// @notice The longest an auction may run. `createAuction` rejects a longer duration, and an
    ///         `extensionWindow` larger than the duration.
    function MAX_DURATION() external view returns (uint64);

    /// @notice The Shapes contract every bid is denominated in.
    function shapes() external view returns (address);

    /// @notice Number of auctions ever created. Ids are issued from 0.
    function auctionCount() external view returns (uint256);

    /// @notice Escrow a Shape and open an auction on it. The clock starts at the first bid, so an
    ///         auction cannot expire unsold because nobody was watching on day one.
    /// @dev The lot is always a Shape, never an arbitrary ERC721. A contract whose `transferFrom`
    ///      returns without moving anything would let a seller take a real winning bid for a lot
    ///      that never changed hands, and one that reverts only on the way out would strand the
    ///      leader's escrow with no settlement and no withdrawal. The house cannot tell either
    ///      apart from an honest implementation, so it sells only the collection it was built
    ///      against.
    ///
    ///      A Black Shape (zero backing) is accepted as a lot. Its worth is assessed by bidders,
    ///      unlike a bid's cards, which are valued at their backing and so reject a Black card.
    /// @param duration Seconds the auction runs for once the first bid lands. At most `MAX_DURATION`.
    /// @param reserveUnits Smallest winning bid, in `UNIT` multiples.
    /// @param minIncrementBps How far a bid must clear the standing one, in basis points.
    /// @param extensionWindow A bid inside this many seconds of the end pushes the end out by it.
    ///        At most `duration`.
    function createAuction(
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint16 minIncrementBps,
        uint32 extensionWindow
    ) external returns (uint256 auctionId);

    /// @notice Reclaim the token before anyone bids. Seller only.
    function cancelAuction(uint256 auctionId) external;

    /// @notice Bid with Shapes, with ETH, or with both.
    /// @dev `cardIds` are transferred in and valued at `backingOf`, which is zero for a Black
    ///      Shape and so rejects one. `ethBackingWei` is minted into the minimal card set for
    ///      that amount, which costs the Shapes mint fee on top; send
    ///      `ethBackingWei + shapes.mintFeeFor(ethBackingWei)`. A bidder already holding the
    ///      standing bid adds to it rather than replacing it.
    function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei) external payable;

    /// @notice Deliver the token to the winner. Permissionless once the auction has ended. An
    ///         auction that never received a bid never ends; the seller exits it with
    ///         `cancelAuction`.
    function settle(uint256 auctionId) external;

    /// @notice Pull back the cards of a bid that is no longer leading.
    function withdraw(uint256 auctionId) external;

    /// @notice Pull the winning bid. Seller only, after settlement.
    function claimProceeds(uint256 auctionId) external;

    /* ----------------------------- views ------------------------------ */

    /// @notice The cards a bidder currently has escrowed on an auction.
    function escrowedCards(uint256 auctionId, address bidder) external view returns (uint256[] memory);

    /// @notice A bidder's escrowed total, in `UNIT` multiples.
    function bidUnits(uint256 auctionId, address bidder) external view returns (uint64);

    /// @notice The smallest bid that would take the lead right now, in `UNIT` multiples.
    function minimumBid(uint256 auctionId) external view returns (uint64);

    /// @notice The minimal card set for `backingWei`: `counts[i]` cards at denomination `i`.
    ///         Reverts unless `backingWei` is a whole multiple of `UNIT`.
    function cardsFor(uint256 backingWei) external pure returns (uint256[9] memory counts);
}

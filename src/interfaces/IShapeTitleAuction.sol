// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IShapeCardEscrow} from "./IShapeCardEscrow.sol";

/// @title IShapeTitleAuction
/// @notice An English auction for title to Shapes, with bids denominated in Shape cards.
/// @dev Title is a property of the `Shapes` contract, not a token: one recorded holder, moved only
///      by `transferTitle`, carrying no authority beyond passing itself on. There is no `approve`
///      and no `transferFrom`, so nothing can pull it — a seller hands it over deliberately or not
///      at all. That shapes the whole lifecycle here, and is why an auction opens before the title
///      arrives rather than after.
///
///      Reusable rather than one-shot: whoever holds title may open an auction, and the winner
///      may open another later.
interface IShapeTitleAuction is IShapeCardEscrow {
    /// @notice Emitted when a title holder opens an auction. The title has not moved yet.
    event TitleAuctionOpened(
        uint256 indexed auctionId, address indexed seller, uint64 duration, uint64 reserveUnits
    );

    /// @notice Emitted on the first bid, when the title is confirmed held and the clock starts.
    event TitleAuctionStarted(uint256 indexed auctionId, uint64 endTime);

    /// @notice Emitted when a bid takes the lead. `units` is the bidder's whole escrowed total,
    ///         not the increment, because a bidder may top up across several transactions.
    event TitleBidPlaced(uint256 indexed auctionId, address indexed bidder, uint64 units, uint64 endTime);

    /// @notice Emitted when the outcome is recorded. Moves nothing.
    event TitleAuctionSettled(uint256 indexed auctionId, address indexed winner, uint64 units);

    /// @notice Emitted when a seller closes an auction that never received a bid.
    event TitleAuctionCancelled(uint256 indexed auctionId);

    /// @notice Emitted when title leaves this contract: to the winner if it sold, back to the
    ///         seller if it was cancelled or never started.
    event TitleClaimed(uint256 indexed auctionId, address indexed to);

    /// @notice Emitted when a losing bidder pulls their escrowed cards back.
    event TitleBidWithdrawn(uint256 indexed auctionId, address indexed bidder, uint256 cardCount);

    /// @notice Emitted when the seller pulls the winning bid.
    event TitleProceedsClaimed(uint256 indexed auctionId, address indexed seller, uint256 cardCount);

    error AuctionNotFound(uint256 auctionId);
    error AuctionOver(uint256 auctionId);
    error AuctionStillRunning(uint256 auctionId);
    error AuctionAlreadySettled(uint256 auctionId);
    /// @dev `open` was called by someone who does not currently hold title.
    error NotTitleHolder(address caller);
    /// @dev An auction is already open or running. There is one title, so there is one at a time.
    error AuctionAlreadyOpen(uint256 auctionId);
    /// @dev A bid arrived before the seller handed the title over.
    error TitleNotHeld();
    /// @dev `cancel` was called by a non-seller, after a bid had landed, or after settlement.
    error InvalidAuction();
    /// @dev `open` duration was zero or above `MAX_DURATION`, or the extension window exceeded it.
    error DurationOutOfRange();
    /// @dev The seller bid its own auction.
    error SellerCannotBid();
    /// @dev Title has already left for this auction.
    error TitleAlreadyClaimed(uint256 auctionId);
    /// @dev `claimTitle` was called by someone other than the party the outcome names.
    error NotTitleRecipient(uint256 auctionId, address caller);

    /// @notice The longest an auction may run once the first bid lands.
    function MAX_DURATION() external view returns (uint64);

    /// @notice Number of auctions ever opened. Ids are issued from 0.
    function auctionCount() external view returns (uint256);

    /// @notice Open an auction on the title. Caller must currently hold it.
    /// @dev Opening does not move the title, because nothing can pull it. The seller hands it over
    ///      afterwards with `shapes.transferTitle(address(this))`, and until they do, `bid`
    ///      refuses. Opening first is what makes that safe: were rights instead granted to whoever
    ///      called after the title landed, anyone watching could take the auction.
    ///
    ///      Nothing is at risk in the gap. An auction whose title never arrives takes no bids and
    ///      can be cancelled by its seller, who still holds the title throughout.
    /// @param duration Seconds the auction runs for once the first bid lands. At most `MAX_DURATION`.
    /// @param reserveUnits Smallest winning bid, in `UNIT` multiples.
    /// @param minIncrementBps How far a bid must clear the standing one, in basis points.
    /// @param extensionWindow A bid inside this many seconds of the end pushes the end out by it.
    function open(uint64 duration, uint64 reserveUnits, uint16 minIncrementBps, uint32 extensionWindow)
        external
        returns (uint256 auctionId);

    /// @notice Bid with Shapes, with ETH, or with both. Refused until the title is held here.
    function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei) external payable;

    /// @notice Close an auction that never received a bid. Seller only. Moves nothing; the seller
    ///         then pulls the title back with `claimTitle` if they had already handed it over.
    function cancel(uint256 auctionId) external;

    /// @notice Record the outcome. Permissionless once the auction has ended.
    /// @dev Moves nothing, so no failure anywhere can prevent an outcome being recorded.
    function settle(uint256 auctionId) external;

    /// @notice Take title: the winner once settled, or the seller of an auction that closed
    ///         without selling.
    /// @dev The single path by which title leaves this contract. `transferTitle` cannot revert
    ///      for a valid recipient, so this could have been pushed at settlement; it is pulled
    ///      because title has no recovery anywhere, and an undelivered claim can be retried while
    ///      a stranded one cannot be undone.
    function claimTitle(uint256 auctionId) external;

    /// @notice Pull back the cards of a bid that is no longer leading.
    function withdraw(uint256 auctionId) external;

    /// @notice Pull the winning bid. Seller only, after settlement.
    function claimProceeds(uint256 auctionId) external;

    /// @notice The smallest bid that would take the lead right now, in `UNIT` multiples.
    function minimumBid(uint256 auctionId) external view returns (uint64);

    /// @notice Whether this contract currently holds title.
    function holdsTitle() external view returns (bool);
}

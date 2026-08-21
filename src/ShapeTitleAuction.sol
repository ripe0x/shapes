// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapeCardEscrow} from "./ShapeCardEscrow.sol";
import {IShapeTitleAuction} from "./interfaces/IShapeTitleAuction.sol";
import {IShapes} from "./interfaces/IShapes.sol";

/// @title ShapeTitleAuction
/// @notice An English auction for title to Shapes, priced in Shape cards.
///
/// @dev Title is not a token. It is one recorded address on the `Shapes` contract, moved only by
///      `transferTitle`, and it carries no authority beyond passing itself on. There is no
///      `approve` and no `transferFrom`, so no contract can pull it: a seller hands it over or
///      does not. Every difference between this and `ShapeAuctionHouse` follows from that.
///
///      An auction is opened by the title holder and only then handed the title. `bid` refuses
///      until the title is actually here, so an auction whose seller never follows through simply
///      takes no bids. The reverse order would be unsafe: granting rights to whoever called after
///      the title landed lets anyone watching take the auction.
///
///      There is one title, so there is one auction at a time. A new one may open once the
///      previous has released what it held, which makes selling title repeatable without this
///      contract ever holding two claims on it.
///
///      Title leaves through `claimTitle` alone, pulled by the winner or by the seller of an
///      auction that did not sell. `transferTitle` cannot revert for a valid recipient, so
///      settlement could have pushed it; it does not, because title has no recovery path anywhere
///      in the system, and a claim that fails can be retried while a strand cannot be undone.
contract ShapeTitleAuction is ShapeCardEscrow, IShapeTitleAuction {
    struct Auction {
        address seller;
        uint64 endTime;
        uint64 duration;
        uint32 extensionWindow;
        uint16 minIncrementBps;
        uint64 reserveUnits;
        uint64 highestUnits;
        address highestBidder;
        bool settled;
        bool titleClaimed;
    }

    /// @inheritdoc IShapeTitleAuction
    uint64 public constant MAX_DURATION = 30 days;

    /// @inheritdoc IShapeTitleAuction
    uint256 public auctionCount;

    mapping(uint256 auctionId => Auction) private _auctions;

    /// @dev The auction that may still hold or receive title, as id plus one so zero reads as
    ///      "none". Cleared when that auction has both settled or cancelled and released title.
    uint256 private _liveAuctionPlusOne;

    constructor(address shapes_) ShapeCardEscrow(shapes_) {}

    /* ------------------------------ opening ----------------------------- */

    /// @inheritdoc IShapeTitleAuction
    function open(uint64 duration, uint64 reserveUnits, uint16 minIncrementBps, uint32 extensionWindow)
        external
        returns (uint256 auctionId)
    {
        // Only the holder may open, which is also what stops a second auction opening while this
        // contract holds the title: while it does, no one else is the holder.
        if (IShapes(shapes).titleHolder() != msg.sender) revert NotTitleHolder(msg.sender);
        if (_liveAuctionPlusOne != 0) revert AuctionAlreadyOpen(_liveAuctionPlusOne - 1);
        if (duration == 0 || duration > MAX_DURATION || extensionWindow > duration) {
            revert DurationOutOfRange();
        }

        auctionId = auctionCount++;
        _auctions[auctionId] = Auction({
            seller: msg.sender,
            endTime: 0, // set by the first bid
            duration: duration,
            extensionWindow: extensionWindow,
            minIncrementBps: minIncrementBps,
            reserveUnits: reserveUnits,
            highestUnits: 0,
            highestBidder: address(0),
            settled: false,
            titleClaimed: false
        });
        _liveAuctionPlusOne = auctionId + 1;

        emit TitleAuctionOpened(auctionId, msg.sender, duration, reserveUnits);
    }

    /// @inheritdoc IShapeTitleAuction
    /// @dev Records the close and returns nothing. If the seller had already handed the title
    ///      over, they pull it back with `claimTitle`; if they had not, they still hold it and
    ///      there is nothing here to reclaim.
    function cancel(uint256 auctionId) external {
        Auction storage a = _requireAuction(auctionId);
        if (msg.sender != a.seller || a.highestBidder != address(0) || a.settled) {
            revert InvalidAuction();
        }

        a.settled = true;
        // An auction that never took the title holds nothing, so nothing is left to release and
        // the next one may open immediately.
        if (!holdsTitle()) {
            a.titleClaimed = true;
            _liveAuctionPlusOne = 0;
        }
        emit TitleAuctionCancelled(auctionId);
    }

    /* ------------------------------ bidding ----------------------------- */

    /// @inheritdoc IShapeTitleAuction
    function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei)
        external
        payable
        nonReentrant
    {
        Auction storage a = _requireAuction(auctionId);
        // A seller bidding sets a floor with cards it withdraws intact once a real bidder clears
        // it, at no net cost. A second address defeats this; the free, obvious form is closed.
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (a.settled) revert AuctionAlreadySettled(auctionId);
        // The auction is inert until the seller hands the title over. Checked on every bid, not
        // once: nothing else here can confirm the handover happened.
        if (!holdsTitle()) revert TitleNotHeld();
        if (a.endTime != 0 && block.timestamp >= a.endTime) revert AuctionOver(auctionId);

        uint64 newUnits = _takeBid(auctionId, cardIds, ethBackingWei);

        uint64 required = _minimumBid(a);
        if (newUnits < required) revert BidTooLow(newUnits, required);

        a.highestUnits = newUnits;
        a.highestBidder = msg.sender;

        // The clock starts at the first bid, so an auction cannot expire because nobody was
        // watching on the day it opened. Afterwards a late bid pushes the deadline out.
        if (a.endTime == 0) {
            a.endTime = uint64(block.timestamp) + a.duration;
            emit TitleAuctionStarted(auctionId, a.endTime);
        } else if (block.timestamp + a.extensionWindow > a.endTime) {
            a.endTime = uint64(block.timestamp) + a.extensionWindow;
        }

        emit TitleBidPlaced(auctionId, msg.sender, newUnits, a.endTime);
    }

    /* ----------------------------- settling ----------------------------- */

    /// @inheritdoc IShapeTitleAuction
    /// @dev Calls nothing, so it cannot be made to fail and needs no reentrancy guard.
    function settle(uint256 auctionId) external {
        Auction storage a = _requireAuction(auctionId);
        if (a.settled) revert AuctionAlreadySettled(auctionId);
        if (a.endTime == 0 || block.timestamp < a.endTime) revert AuctionStillRunning(auctionId);

        a.settled = true;
        emit TitleAuctionSettled(auctionId, a.highestBidder, a.highestUnits);
    }

    /// @inheritdoc IShapeTitleAuction
    /// @dev `highestBidder` partitions the outcomes: settling requires a bid and so leaves it set,
    ///      cancelling requires none and so leaves it zero. Marked claimed and the slot freed
    ///      before the call, so a reentrant caller finds nothing left to take twice.
    function claimTitle(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (!a.settled) revert AuctionStillRunning(auctionId);
        if (a.titleClaimed) revert TitleAlreadyClaimed(auctionId);

        address recipient = a.highestBidder == address(0) ? a.seller : a.highestBidder;
        if (msg.sender != recipient) revert NotTitleRecipient(auctionId, msg.sender);

        a.titleClaimed = true;
        _liveAuctionPlusOne = 0; // the next holder may open their own auction
        emit TitleClaimed(auctionId, recipient);
        IShapes(shapes).transferTitle(recipient);
    }

    /// @inheritdoc IShapeTitleAuction
    /// @dev Available to every bidder except the standing leader, whose cards are the live bid.
    ///      Once settled the leader has become the winner and their cards belong to the seller, so
    ///      the same check covers both phases.
    function withdraw(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (msg.sender == a.highestBidder) revert NothingToWithdraw(auctionId, msg.sender);

        uint256 count = _release(auctionId, msg.sender, msg.sender);
        emit TitleBidWithdrawn(auctionId, msg.sender, count);
    }

    /// @inheritdoc IShapeTitleAuction
    function claimProceeds(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (!a.settled) revert AuctionStillRunning(auctionId);
        if (msg.sender != a.seller) revert NothingToWithdraw(auctionId, msg.sender);

        uint256 count = _release(auctionId, a.highestBidder, a.seller);
        emit TitleProceedsClaimed(auctionId, a.seller, count);
    }

    /* ------------------------------- views ------------------------------ */

    function auctions(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    /// @inheritdoc IShapeTitleAuction
    function holdsTitle() public view returns (bool) {
        return IShapes(shapes).titleHolder() == address(this);
    }

    /// @inheritdoc IShapeTitleAuction
    function minimumBid(uint256 auctionId) external view returns (uint64) {
        Auction storage a = _requireAuction(auctionId);
        return _minimumBid(a);
    }

    function _minimumBid(Auction storage a) private view returns (uint64) {
        return _minimumFrom(a.highestBidder != address(0), a.highestUnits, a.minIncrementBps, a.reserveUnits);
    }

    function _requireAuction(uint256 auctionId) private view returns (Auction storage a) {
        a = _auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound(auctionId);
    }
}

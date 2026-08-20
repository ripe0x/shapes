// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IShapeAuctionHouse} from "./interfaces/IShapeAuctionHouse.sol";
import {IShapes} from "./interfaces/IShapes.sol";
import {Denominations} from "./lib/Denominations.sol";

/// @title ShapeAuctionHouse
/// @notice An English auction for any ERC721, with bids denominated in Shape cards.
///
/// @dev A bid is a set of Shapes whose summed backing is the bid amount. Bidders who hold no
///      Shapes can bid ETH, which the house mints into the minimal card set for that amount, so
///      every bid ends up expressed as cards either way.
///
///      Amounts are carried in `UNIT` (0.01 ETH) multiples. That is exact rather than lossy: the
///      smallest denomination is 0.01 ETH and every other is a whole multiple of it, so no sum of
///      cards can land between two units.
///
///      Escrowed cards are claims on real ETH, redeemable by whoever holds them, so the custody
///      rules are strict. Nothing is ever pushed: an outbid bidder's cards do not move, they wait
///      to be pulled. Pushing up to sixty-four ERC721 transfers inside `bid` would let a bidder
///      with a reverting `onERC721Received` freeze the auction on their own bid permanently.
///
///      The house takes no fee and has no owner, no pause, and no path that reaches an escrowed
///      card other than its depositor pulling it back or the seller claiming a settled win. A
///      percentage fee is not merely declined but unrepresentable: a bid is a set of indivisible
///      cards and a percentage of a lattice amount need not land on the lattice.
contract ShapeAuctionHouse is IShapeAuctionHouse, IERC721Receiver, ReentrancyGuard {
    struct Auction {
        address seller;
        address nft;
        uint256 tokenId;
        uint64 endTime;
        uint64 duration;
        uint32 extensionWindow;
        uint16 minIncrementBps;
        uint64 reserveUnits;
        uint64 highestUnits;
        address highestBidder;
        bool settled;
    }

    /// @inheritdoc IShapeAuctionHouse
    uint256 public constant MAX_CARDS_PER_BID = 64;

    /// @inheritdoc IShapeAuctionHouse
    address public immutable shapes;

    /// @inheritdoc IShapeAuctionHouse
    uint256 public auctionCount;

    mapping(uint256 auctionId => Auction) private _auctions;
    mapping(uint256 auctionId => mapping(address bidder => uint256[])) private _escrow;
    mapping(uint256 auctionId => mapping(address bidder => uint64)) private _units;

    /// @dev Set only while `bid` is minting, and read only by `onERC721Received`. Anything else
    ///      sending the house an ERC721 through the safe path is refused, so a token cannot be
    ///      stranded here with no record of who owns it.
    bool private _minting;

    constructor(address shapes_) {
        require(shapes_.code.length != 0, "shapes has no code");
        shapes = shapes_;
    }

    /* ---------------------------- creating ---------------------------- */

    /// @inheritdoc IShapeAuctionHouse
    /// @dev The token is escrowed with `transferFrom` rather than `safeTransferFrom`, so the
    ///      house takes no receiver callback for it and the sale is deliverable from this point.
    function createAuction(
        address nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint16 minIncrementBps,
        uint32 extensionWindow
    ) external nonReentrant returns (uint256 auctionId) {
        if (duration == 0) revert InvalidAuction();

        auctionId = auctionCount++;
        _auctions[auctionId] = Auction({
            seller: msg.sender,
            nft: nft,
            tokenId: tokenId,
            endTime: 0, // set by the first bid
            duration: duration,
            extensionWindow: extensionWindow,
            minIncrementBps: minIncrementBps,
            reserveUnits: reserveUnits,
            highestUnits: 0,
            highestBidder: address(0),
            settled: false
        });

        emit AuctionCreated(auctionId, msg.sender, nft, tokenId, duration, reserveUnits);
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
    }

    /// @inheritdoc IShapeAuctionHouse
    function cancelAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (msg.sender != a.seller || a.highestBidder != address(0) || a.settled) {
            revert InvalidAuction();
        }

        a.settled = true;
        emit AuctionCancelled(auctionId);
        IERC721(a.nft).transferFrom(address(this), a.seller, a.tokenId);
    }

    /* ----------------------------- bidding ---------------------------- */

    /// @inheritdoc IShapeAuctionHouse
    function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei)
        external
        payable
        nonReentrant
    {
        Auction storage a = _requireAuction(auctionId);
        if (a.settled) revert AuctionAlreadySettled(auctionId);
        if (a.endTime != 0 && block.timestamp >= a.endTime) revert AuctionOver(auctionId);
        if (cardIds.length == 0 && ethBackingWei == 0) revert EmptyBid();
        // Without this, ETH sent alongside a cards-only bid would sit here unreachable.
        if (ethBackingWei == 0 && msg.value != 0) revert IncorrectPayment(0, msg.value);

        uint256 added = _takeCards(auctionId, cardIds);
        if (ethBackingWei != 0) added += _mintCards(auctionId, ethBackingWei);

        // Every accepted card's backing is a whole number of UNITs, so this division is exact.
        uint64 newUnits = _units[auctionId][msg.sender] + uint64(added / Denominations.UNIT);

        uint64 required = _minimumBid(a);
        if (newUnits < required) revert BidTooLow(newUnits, required);

        _units[auctionId][msg.sender] = newUnits;
        a.highestUnits = newUnits;
        a.highestBidder = msg.sender;

        // The clock starts at the first bid. Afterwards, a bid inside the extension window
        // pushes the deadline out, so an auction cannot be won by arriving last.
        if (a.endTime == 0) {
            a.endTime = uint64(block.timestamp) + a.duration;
        } else if (block.timestamp + a.extensionWindow > a.endTime) {
            a.endTime = uint64(block.timestamp) + a.extensionWindow;
        }

        emit BidPlaced(auctionId, msg.sender, newUnits, a.endTime);
    }

    /// @dev Pulls the caller's cards into escrow and returns their summed backing. `backingOf`
    ///      returns zero for a Black Shape, which is how one is rejected: a Black Shape still
    ///      carries the apex denomination internally, so valuing a bid off the denomination
    ///      rather than the backing would price an unredeemable token at 100 ETH. A repeated id
    ///      needs no check of its own, because the second `transferFrom` finds the caller no
    ///      longer owns it.
    function _takeCards(uint256 auctionId, uint256[] calldata cardIds) private returns (uint256 backing) {
        uint256 n = cardIds.length;
        uint256[] storage held = _escrow[auctionId][msg.sender];
        // Bounds the escrow, not the call: a bidder tops up across transactions, and it is the
        // total that `_release` later has to loop over.
        if (held.length + n > MAX_CARDS_PER_BID) revert TooManyCards(held.length + n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = cardIds[i];
            uint256 value = IShapes(shapes).backingOf(id);
            if (value == 0) revert WorthlessCard(id);

            backing += value;
            held.push(id);
            IERC721(shapes).transferFrom(msg.sender, address(this), id);
        }
    }

    /// @dev Mints the minimal card set for `backingWei` into escrow. The Shapes mint fee is
    ///      charged on top and is exactly `backingWei * feeBps / 10000`: the fee is linear in
    ///      backing and lands on a whole number of wei at every denomination.
    function _mintCards(uint256 auctionId, uint256 backingWei) private returns (uint256) {
        if (backingWei % Denominations.UNIT != 0) revert NotAUnitMultiple(backingWei);

        uint256 expected = backingWei + IShapes(shapes).mintFeeFor(backingWei);
        if (msg.value != expected) revert IncorrectPayment(expected, msg.value);

        uint256[9] memory counts = _cardsFor(backingWei);
        uint256[] storage held = _escrow[auctionId][msg.sender];
        if (held.length + _total(counts) > MAX_CARDS_PER_BID) {
            revert TooManyCards(held.length + _total(counts));
        }

        _minting = true;
        for (uint256 d = 0; d < Denominations.COUNT; ++d) {
            uint256 count = counts[d];
            if (count == 0) continue;

            uint256 amount = Denominations.amountAt(d);
            uint256 cost = (amount + IShapes(shapes).mintFeeFor(amount)) * count;
            // Take the ids the mint reports rather than predicting them from the counter: a batch
            // is contiguous from its return value, which is the guarantee actually offered.
            uint256 firstId = IShapes(shapes).mintBatch{value: cost}(amount, count, address(this));
            for (uint256 i = 0; i < count; ++i) {
                held.push(firstId + i);
            }
        }
        _minting = false;

        emit BidCardsMinted(auctionId, msg.sender, backingWei);
        return backingWei;
    }

    /* ---------------------------- settling ---------------------------- */

    /// @inheritdoc IShapeAuctionHouse
    function settle(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (a.settled) revert AuctionAlreadySettled(auctionId);
        if (a.endTime == 0 || block.timestamp < a.endTime) revert AuctionStillRunning(auctionId);

        a.settled = true;
        address winner = a.highestBidder;

        emit AuctionSettled(auctionId, winner, a.highestUnits);
        IERC721(a.nft).transferFrom(address(this), winner, a.tokenId);
    }

    /// @inheritdoc IShapeAuctionHouse
    /// @dev Available to every bidder except the standing leader, whose cards are the live bid.
    ///      Once settled the leader has become the winner and their cards belong to the seller,
    ///      so the same check covers both phases.
    function withdraw(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (msg.sender == a.highestBidder) revert NothingToWithdraw(auctionId, msg.sender);

        uint256 count = _release(auctionId, msg.sender, msg.sender);
        emit BidWithdrawn(auctionId, msg.sender, count);
    }

    /// @inheritdoc IShapeAuctionHouse
    function claimProceeds(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (!a.settled) revert AuctionStillRunning(auctionId);
        if (msg.sender != a.seller) revert NothingToWithdraw(auctionId, msg.sender);

        uint256 count = _release(auctionId, a.highestBidder, a.seller);
        emit ProceedsClaimed(auctionId, a.seller, count);
    }

    /// @dev Clears an escrow entry and hands its cards to `to`. State is cleared before the
    ///      transfers, so a receiver that calls back finds nothing left to claim twice.
    function _release(uint256 auctionId, address from, address to) private returns (uint256) {
        uint256[] storage held = _escrow[auctionId][from];
        uint256 count = held.length;
        if (count == 0) revert NothingToWithdraw(auctionId, from);

        uint256[] memory ids = held;
        delete _escrow[auctionId][from];
        _units[auctionId][from] = 0;

        for (uint256 i = 0; i < count; ++i) {
            IERC721(shapes).transferFrom(address(this), to, ids[i]);
        }
        return count;
    }

    /* ----------------------------- receipt ---------------------------- */

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts Shapes only while `bid` is minting them. Bidding by sending a card here
    ///      directly is unsupported on purpose: a bid must be one transaction, so that what it
    ///      totals is compared against the standing bid exactly once.
    function onERC721Received(address, address from, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != shapes || !_minting) revert UnsolicitedToken(from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /* ------------------------------ views ----------------------------- */

    function auctions(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    /// @inheritdoc IShapeAuctionHouse
    function escrowedCards(uint256 auctionId, address bidder) external view returns (uint256[] memory) {
        return _escrow[auctionId][bidder];
    }

    /// @inheritdoc IShapeAuctionHouse
    function bidUnits(uint256 auctionId, address bidder) external view returns (uint64) {
        return _units[auctionId][bidder];
    }

    /// @inheritdoc IShapeAuctionHouse
    function minimumBid(uint256 auctionId) external view returns (uint64) {
        return _minimumBid(_requireAuction(auctionId));
    }

    /// @dev The reserve until someone bids, then the standing bid plus its increment. The
    ///      increment is rounded up to a whole unit and floored at one, so the requirement always
    ///      names an amount the ladder can express: every whole multiple of UNIT is assemblable,
    ///      nothing between two units is, and a requirement landing between them would be
    ///      unmeetable.
    function _minimumBid(Auction storage a) private view returns (uint64) {
        if (a.highestBidder == address(0)) {
            return a.reserveUnits == 0 ? 1 : a.reserveUnits;
        }
        uint256 step = (uint256(a.highestUnits) * a.minIncrementBps + 9999) / 10_000;
        if (step == 0) step = 1;
        return uint64(uint256(a.highestUnits) + step);
    }

    /// @inheritdoc IShapeAuctionHouse
    function cardsFor(uint256 backingWei) external pure returns (uint256[9] memory) {
        return _cardsFor(backingWei);
    }

    /// @dev Largest denomination first, as many as fit, repeat. On this ladder that is provably
    ///      the fewest cards for the amount, and it never exceeds twenty below 100 ETH.
    function _cardsFor(uint256 backingWei) private pure returns (uint256[9] memory counts) {
        if (backingWei % Denominations.UNIT != 0) revert NotAUnitMultiple(backingWei);

        uint256 remaining = backingWei;
        for (uint256 i = Denominations.COUNT; i > 0; --i) {
            uint256 amount = Denominations.amountAt(i - 1);
            counts[i - 1] = remaining / amount;
            remaining %= amount;
        }
    }

    function _total(uint256[9] memory counts) private pure returns (uint256 sum) {
        for (uint256 i = 0; i < 9; ++i) {
            sum += counts[i];
        }
    }

    function _requireAuction(uint256 auctionId) private view returns (Auction storage a) {
        a = _auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound(auctionId);
    }
}

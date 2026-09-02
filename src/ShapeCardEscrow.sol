// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IShapeCardEscrow} from "./interfaces/IShapeCardEscrow.sol";
import {IShapes} from "./interfaces/IShapes.sol";
import {Denominations} from "./lib/Denominations.sol";

/// @title ShapeCardEscrow
/// @notice Custody and valuation for bids made of Shape cards. Inherited by each auction that
///         prices something in Shapes; what is being sold lives in the deriving contract.
///
/// @dev Escrowed cards are claims on real ETH, redeemable by whoever holds them, so the custody
///      rules are strict. Cards are never pushed: an outbid bidder's cards do not move, they wait
///      to be pulled. Pushing up to `MAX_CARDS_PER_BID` ERC721 transfers inside a bid would put
///      that cost on whoever outbids, and would let a bidder with a reverting receiver freeze an
///      auction on their own bid.
///
///      There is no owner, no pause, and no path that reaches an escrowed card other than its
///      depositor pulling it back or a seller claiming a settled win. A Shape pushed here by a
///      plain `transferFrom`, which calls no receiver hook and so cannot be refused, is held with
///      no escrow entry and no way out. That is accepted: a recovery function would be an
///      administrative path into everyone else's escrow.
abstract contract ShapeCardEscrow is IShapeCardEscrow, IERC721Receiver, ReentrancyGuard {
    /// @inheritdoc IShapeCardEscrow
    uint256 public constant MAX_CARDS_PER_BID = 64;

    /// @inheritdoc IShapeCardEscrow
    address public immutable shapes;

    mapping(uint256 auctionId => mapping(address bidder => uint256[])) private _escrow;
    mapping(uint256 auctionId => mapping(address bidder => uint64)) private _units;

    /// @dev Set only across the individual mint call inside a bid, and read only by
    ///      `onERC721Received`, which accepts a mint to this contract (`from == address(0)`) and
    ///      nothing else. An inbound `safeTransferFrom` is refused even during the window, so a
    ///      token cannot be stranded here with no record of who owns it.
    bool private _minting;

    constructor(address shapes_) {
        require(shapes_.code.length != 0, "shapes has no code");
        shapes = shapes_;
    }

    /* ---------------------------- taking cards ---------------------------- */

    /// @dev Pulls the caller's cards into escrow and returns their summed backing. `backingOf`
    ///      returns zero for a Black Shape, which is how one is rejected: a Black Shape still
    ///      carries the apex denomination internally, so valuing a bid off the denomination
    ///      rather than the backing would price an unredeemable token at 100 ETH. A repeated id
    ///      needs no check of its own, because the second `transferFrom` finds the caller no
    ///      longer owns it.
    function _takeCards(uint256 auctionId, uint256[] calldata cardIds) internal returns (uint256 backing) {
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

    /// @dev Mints the minimal card set for `backingWei` into escrow. Each card is a newly created
    ///      Shape and therefore pays the token's flat per-Shape mint fee.
    function _mintCards(uint256 auctionId, uint256 backingWei) internal returns (uint256) {
        uint256[9] memory counts = _cardsFor(backingWei);
        uint256 cardCount = _total(counts);
        uint256 fee = IShapes(shapes).mintFee();
        uint256 expected = backingWei + fee * cardCount;
        if (msg.value != expected) revert IncorrectPayment(expected, msg.value);

        uint256[] storage held = _escrow[auctionId][msg.sender];
        if (held.length + cardCount > MAX_CARDS_PER_BID) {
            revert TooManyCards(held.length + cardCount);
        }

        for (uint256 d = 0; d < Denominations.COUNT; ++d) {
            uint256 count = counts[d];
            if (count == 0) continue;

            uint256 amount = Denominations.amountAt(d);
            uint256 cost = (amount + fee) * count;
            // The window is open only across the mint call that fills it, not across the whole
            // loop, so nothing between two calls can slip a token in under the flag.
            _minting = true;
            // Take the ids the mint reports rather than predicting them from the counter: a batch
            // is contiguous from its return value, which is the guarantee actually offered.
            uint256 firstId = IShapes(shapes).mintBatchTo{value: cost}(amount, count, address(this));
            _minting = false;
            for (uint256 i = 0; i < count; ++i) {
                held.push(firstId + i);
            }
        }

        emit BidCardsMinted(auctionId, msg.sender, backingWei);
        return backingWei;
    }

    /// @dev Takes a bid's cards and ETH together and returns the escrowed total in units. Every
    ///      accepted card's backing is a whole number of UNITs, so the division is exact.
    function _takeBid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei)
        internal
        returns (uint64 newUnits)
    {
        if (cardIds.length == 0 && ethBackingWei == 0) revert EmptyBid();
        // Without this, ETH sent alongside a cards-only bid would sit here unreachable.
        if (ethBackingWei == 0 && msg.value != 0) revert IncorrectPayment(0, msg.value);

        uint256 added = _takeCards(auctionId, cardIds);
        if (ethBackingWei != 0) added += _mintCards(auctionId, ethBackingWei);

        newUnits = _units[auctionId][msg.sender] + uint64(added / Denominations.UNIT);
        _units[auctionId][msg.sender] = newUnits;
    }

    /* ---------------------------- releasing ---------------------------- */

    /// @dev Clears an escrow entry and hands its cards to `to`. State is cleared before the
    ///      transfers, so a receiver that calls back finds nothing left to claim twice.
    function _release(uint256 auctionId, address from, address to) internal returns (uint256) {
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

    /* ---------------------------- the increment ---------------------------- */

    /// @dev The reserve until someone bids, then the standing bid plus its increment. The
    ///      increment is rounded up to a whole unit and floored at one, so the requirement always
    ///      names an amount the ladder can express: every whole multiple of UNIT is assemblable,
    ///      nothing between two units is, and a requirement landing between them would be
    ///      unmeetable.
    function _minimumFrom(bool hasBidder, uint64 highestUnits, uint16 minIncrementBps, uint64 reserveUnits)
        internal
        pure
        returns (uint64)
    {
        if (!hasBidder) {
            return reserveUnits == 0 ? 1 : reserveUnits;
        }
        uint256 step = (uint256(highestUnits) * minIncrementBps + 9999) / 10_000;
        if (step == 0) step = 1;
        return uint64(uint256(highestUnits) + step);
    }

    /* ------------------------------ receipt ---------------------------- */

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts a Shape only when it is minted here (`from == address(0)`) while a bid is
    ///      minting one. An inbound `safeTransferFrom` carries a nonzero `from` and is refused:
    ///      bidding by sending a card here directly is unsupported on purpose, since a bid must be
    ///      one transaction, so that what it totals is compared against the standing bid exactly
    ///      once. A contract fee recipient that gains control inside the mint cannot push its own
    ///      Shape in through this path.
    function onERC721Received(address, address from, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != shapes || !_minting || from != address(0)) revert UnsolicitedToken(from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /* ------------------------------- views ----------------------------- */

    /// @inheritdoc IShapeCardEscrow
    function escrowedCards(uint256 auctionId, address bidder) external view returns (uint256[] memory) {
        return _escrow[auctionId][bidder];
    }

    /// @inheritdoc IShapeCardEscrow
    function bidUnits(uint256 auctionId, address bidder) public view returns (uint64) {
        return _units[auctionId][bidder];
    }

    /// @inheritdoc IShapeCardEscrow
    function cardsFor(uint256 backingWei) external pure returns (uint256[9] memory) {
        return _cardsFor(backingWei);
    }

    /// @inheritdoc IShapeCardEscrow
    function mintCostFor(uint256 backingWei) external view returns (uint256) {
        return backingWei + IShapes(shapes).mintFee() * _total(_cardsFor(backingWei));
    }

    /// @dev Largest denomination first, as many as fit, repeat. On this ladder that is provably
    ///      the fewest cards for the amount, and it never exceeds twenty below 100 ETH.
    function _cardsFor(uint256 backingWei) internal pure returns (uint256[9] memory counts) {
        if (backingWei % Denominations.UNIT != 0) revert NotAUnitMultiple(backingWei);

        uint256 remaining = backingWei;
        for (uint256 i = Denominations.COUNT; i > 0; --i) {
            uint256 amount = Denominations.amountAt(i - 1);
            counts[i - 1] = remaining / amount;
            remaining %= amount;
        }
    }

    function _total(uint256[9] memory counts) internal pure returns (uint256 sum) {
        for (uint256 i = 0; i < Denominations.COUNT; ++i) {
            sum += counts[i];
        }
    }
}

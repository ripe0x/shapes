// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ShapeCardEscrow} from "./ShapeCardEscrow.sol";
import {IShapeAuctionHouse} from "./interfaces/IShapeAuctionHouse.sol";

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
///      Card custody is `ShapeCardEscrow`, which never pushes a card. The lot is pulled on the
///      same terms, which is what lets the house sell a collection it
///      knows nothing about. `settle` and `cancelAuction` record an outcome and move nothing;
///      `claimLot` is the single path by which the lot leaves. A lot whose transfer reverts
///      therefore blocks its own delivery and nothing else: the seller still claims the winning
///      cards and every outbid bidder still withdraws, because those paths move Shapes alone.
///      The lot's collection is called from exactly two functions, `createAuction` and
///      `claimLot`, whose callers are the seller and the winner.
///
///      The house takes no fee and has no owner. A percentage fee is not merely declined but
///      unrepresentable: a bid is a set of indivisible cards and a percentage of a lattice amount
///      need not land on the lattice.
contract ShapeAuctionHouse is ShapeCardEscrow, IShapeAuctionHouse {
    constructor(address shapes_) ShapeCardEscrow(shapes_) {}

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
        bool lotClaimed;
    }

    /// @inheritdoc IShapeAuctionHouse
    uint64 public constant MAX_DURATION = 30 days;

    /// @dev EIP-721's ERC165 interface id.
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;

    /// @inheritdoc IShapeAuctionHouse
    uint256 public auctionCount;

    mapping(uint256 auctionId => Auction) private _auctions;

    /// @dev (collection, token) to auction id plus one, so the zero default reads as "none".
    ///      Set when the lot is escrowed and cleared when it leaves, which is `claimLot` rather
    ///      than settlement: the house still holds a settled lot until the winner takes it, and
    ///      it must not be listable again in the meantime.
    mapping(address nft => mapping(uint256 tokenId => uint256)) private _auctionIdByToken;

    /* ---------------------------- creating ---------------------------- */

    /// @inheritdoc IShapeAuctionHouse
    /// @dev The lot is escrowed with `transferFrom` rather than `safeTransferFrom`, so the house
    ///      takes no receiver callback for it.
    ///
    ///      The ownership check after the transfer binds an honest collection: a `transferFrom`
    ///      that returns without moving anything is caught, as is a token the seller did not own.
    ///      It does not bind a collection that also reports `ownerOf` falsely, and nothing on
    ///      chain does. What bounds that case is the shape of the contract rather than a check
    ///      inside it: `nft` is called here and in `claimLot`, and nowhere those calls can reach
    ///      does anyone but the seller and the winner have something at stake.
    function createAuction(
        address nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint16 minIncrementBps,
        uint32 extensionWindow
    ) external nonReentrant returns (uint256 auctionId) {
        // An address with no code accepts a void call silently, so `transferFrom` on one would
        // appear to succeed. `ownerOf` below would revert on it regardless; this names the reason.
        if (nft.code.length == 0) revert LotHasNoCode(nft);
        // Rejects an address that is not the collection the seller meant, which is the mistake
        // that actually happens. A contract that answers this falsely is not caught here or
        // anywhere else; see `claimLot` for what bounds that case instead.
        if (!IERC165(nft).supportsInterface(ERC721_INTERFACE_ID)) revert LotNotERC721(nft);
        if (_auctionIdByToken[nft][tokenId] != 0) revert AuctionAlreadyExistsForToken(nft, tokenId);

        // Checked here so the caller gets a named error rather than the collection's internal
        // one, and so an approved operator can list on the owner's behalf.
        address tokenOwner = IERC721(nft).ownerOf(tokenId);
        if (
            msg.sender != tokenOwner && msg.sender != IERC721(nft).getApproved(tokenId)
                && !IERC721(nft).isApprovedForAll(tokenOwner, msg.sender)
        ) {
            revert NotTokenOwnerOrApproved(nft, tokenId, msg.sender);
        }
        // Bound the clock. An unbounded duration would hold every bidder's escrow for as long as
        // the seller chose; extensionWindow may not exceed the duration it extends.
        if (duration == 0 || duration > MAX_DURATION) revert DurationOutOfRange();
        if (extensionWindow > duration) revert ExtensionWindowTooLong();

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
            settled: false,
            lotClaimed: false
        });

        _auctionIdByToken[nft][tokenId] = auctionId + 1;

        emit AuctionCreated(auctionId, msg.sender, nft, tokenId, duration, reserveUnits);
        IERC721(nft).transferFrom(tokenOwner, address(this), tokenId);
        if (IERC721(nft).ownerOf(tokenId) != address(this)) revert LotNotReceived();
    }

    /// @inheritdoc IShapeAuctionHouse
    /// @dev Records the close and returns nothing. The seller pulls the lot back with `claimLot`,
    ///      which `highestBidder == address(0)` directs to them rather than to a winner.
    function cancelAuction(uint256 auctionId) external {
        Auction storage a = _requireAuction(auctionId);
        if (msg.sender != a.seller || a.highestBidder != address(0) || a.settled) {
            revert InvalidAuction();
        }

        a.settled = true;
        emit AuctionCancelled(auctionId);
    }

    /* ----------------------------- bidding ---------------------------- */

    /// @inheritdoc IShapeAuctionHouse
    function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei)
        external
        payable
        nonReentrant
    {
        Auction storage a = _requireAuction(auctionId);
        // The seller cannot bid its own lot. A seller bidding sets a floor with cards it withdraws
        // intact once a real bidder clears it, at no net cost. A second address defeats this, but
        // the free, on-chain-obvious form is closed.
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (a.settled) revert AuctionAlreadySettled(auctionId);
        if (a.endTime != 0 && block.timestamp >= a.endTime) revert AuctionOver(auctionId);
        uint64 newUnits = _takeBid(auctionId, cardIds, ethBackingWei);

        uint64 required = _minimumBid(a);
        if (newUnits < required) revert BidTooLow(newUnits, required);

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

    /* ---------------------------- settling ---------------------------- */

    /// @inheritdoc IShapeAuctionHouse
    /// @dev Touches no collection, so it cannot be made to revert by the lot and the outcome is
    ///      always recordable. Needs no reentrancy guard for the same reason: it calls nothing.
    function settle(uint256 auctionId) external {
        Auction storage a = _requireAuction(auctionId);
        if (a.settled) revert AuctionAlreadySettled(auctionId);
        if (a.endTime == 0 || block.timestamp < a.endTime) revert AuctionStillRunning(auctionId);

        a.settled = true;
        emit AuctionSettled(auctionId, a.highestBidder, a.highestUnits);
    }

    /// @inheritdoc IShapeAuctionHouse
    /// @dev `highestBidder` partitions the two outcomes: `settle` requires a bid and so leaves it
    ///      set, `cancelAuction` requires none and so leaves it zero. Marked claimed before the
    ///      transfer, so a collection that calls back finds nothing left to take twice.
    function claimLot(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireAuction(auctionId);
        if (!a.settled) revert AuctionStillRunning(auctionId);
        if (a.lotClaimed) revert LotAlreadyClaimed(auctionId);

        address recipient = a.highestBidder == address(0) ? a.seller : a.highestBidder;
        if (msg.sender != recipient) revert NotLotRecipient(auctionId, msg.sender);

        a.lotClaimed = true;
        delete _auctionIdByToken[a.nft][a.tokenId]; // the token is free to be listed again
        emit LotClaimed(auctionId, recipient);
        IERC721(a.nft).transferFrom(address(this), recipient, a.tokenId);
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

    /* ------------------------------ views ----------------------------- */

    function auctions(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    /// @inheritdoc IShapeAuctionHouse
    function minimumBid(uint256 auctionId) external view returns (uint64) {
        return _minimumBid(_requireAuction(auctionId));
    }

    /// @dev Delegates the rounding to `ShapeCardEscrow`, which every card-denominated auction
    ///      shares: an increment that landed between two units would name an unmeetable amount.
    function _minimumBid(Auction storage a) private view returns (uint64) {
        return _minimumFrom(a.highestBidder != address(0), a.highestUnits, a.minIncrementBps, a.reserveUnits);
    }

    /// @inheritdoc IShapeAuctionHouse
    function getAuctionFor(address nft, uint256 tokenId)
        external
        view
        returns (bool exists, uint256 auctionId)
    {
        uint256 stored = _auctionIdByToken[nft][tokenId];
        if (stored == 0) return (false, 0);
        return (true, stored - 1);
    }

    /// @inheritdoc IShapeAuctionHouse
    function hasAuctionFor(address nft, uint256 tokenId) external view returns (bool) {
        return _auctionIdByToken[nft][tokenId] != 0;
    }

    function _requireAuction(uint256 auctionId) private view returns (Auction storage a) {
        a = _auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound(auctionId);
    }
}

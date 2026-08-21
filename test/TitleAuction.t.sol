// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {ShapeTitleAuction} from "../src/ShapeTitleAuction.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeCardEscrow} from "../src/interfaces/IShapeCardEscrow.sol";
import {IShapeTitleAuction} from "../src/interfaces/IShapeTitleAuction.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";

/// @notice Selling title to Shapes without tokenising it. Title is one recorded address on the
///         token contract, movable only by its holder, so the whole lifecycle turns on a handover
///         that cannot be pulled.
contract TitleAuctionTest is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ShapeTitleAuction internal auction;

    address internal artist = makeAddr("artist");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    uint64 internal constant DURATION = 24 hours;
    uint64 internal constant RESERVE = 1; // 0.01 ETH
    uint16 internal constant INCREMENT_BPS = 500;
    uint32 internal constant EXTENSION = 15 minutes;

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        // The artist holds title from deployment.
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection), artist);
        auction = new ShapeTitleAuction(address(shapes));

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            vm.prank(who);
            shapes.setApprovalForAll(address(auction), true);
        }
    }

    function feeOf(uint256 wei_) internal pure returns (uint256) {
        return wei_ / 100;
    }

    function _card(address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(to);
        id = shapes.mint{value: amount + feeOf(amount)}(amount);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    /// @dev Open, then hand the title over. That order is the contract's, not a convenience.
    function _openAndHandOver() internal returns (uint256 id) {
        vm.prank(artist);
        id = auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
        vm.prank(artist);
        shapes.transferTitle(address(auction));
    }

    /* ------------------------------ opening ----------------------------- */

    function test_OnlyTheTitleHolderCanOpen() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.NotTitleHolder.selector, alice));
        auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
    }

    function test_OpeningMovesNothing() public {
        vm.prank(artist);
        auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
        assertEq(shapes.titleHolder(), artist, "opening does not take the title");
        assertFalse(auction.holdsTitle());
    }

    /// @notice The reason the order is open-then-hand-over. If rights went to whoever called after
    ///         the title arrived, a watcher could take the auction; here they cannot open at all,
    ///         because opening requires holding title and the artist still holds it.
    function test_AWatcherCannotOpenOnTheArtistsTitle() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.NotTitleHolder.selector, bob));
        auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);

        // Nor once the title is here: then nobody but this contract holds it.
        _openAndHandOver();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.NotTitleHolder.selector, bob));
        auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
    }

    function test_OnlyOneAuctionAtATime() public {
        vm.prank(artist);
        uint256 first = auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.AuctionAlreadyOpen.selector, first));
        auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
    }

    function test_OpenRejectsABadDuration() public {
        vm.prank(artist);
        vm.expectRevert(IShapeTitleAuction.DurationOutOfRange.selector);
        auction.open(0, RESERVE, INCREMENT_BPS, EXTENSION);

        vm.prank(artist);
        vm.expectRevert(IShapeTitleAuction.DurationOutOfRange.selector);
        auction.open(DURATION, RESERVE, INCREMENT_BPS, uint32(DURATION) + 1);
    }

    /* ------------------------- the handover gap ------------------------- */

    /// @notice An auction whose seller never follows through takes no bids, and the artist keeps
    ///         the title throughout. Nothing is at risk in the gap.
    function test_BiddingIsRefusedUntilTheTitleArrives() public {
        vm.prank(artist);
        uint256 id = auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);

        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(IShapeTitleAuction.TitleNotHeld.selector);
        auction.bid(id, _one(card), 0);

        assertEq(shapes.titleHolder(), artist, "the artist still holds it");
    }

    function test_AnAbandonedAuctionIsCancellableAndFreesTheSlot() public {
        vm.prank(artist);
        uint256 id = auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
        vm.prank(artist);
        auction.cancel(id);

        // Nothing was held, so nothing is owed and a fresh auction may open at once.
        vm.prank(artist);
        uint256 second = auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
        assertTrue(second != id);
    }

    /* ------------------------------ bidding ----------------------------- */

    function test_ACardBidTakesTheLeadAndStartsTheClock() public {
        uint256 id = _openAndHandOver();
        assertTrue(auction.holdsTitle(), "the title is held for the sale");

        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(card), 0);

        assertEq(auction.bidUnits(id, alice), 100, "1 ETH is 100 units");
        assertEq(auction.auctions(id).highestBidder, alice);
        assertEq(
            auction.auctions(id).endTime, uint64(block.timestamp) + DURATION, "clock starts at the first bid"
        );
    }

    function test_TheEthPathMintsTheBiddersCards() public {
        uint256 id = _openAndHandOver();
        vm.prank(bob);
        auction.bid{value: 1 ether + feeOf(1 ether)}(id, _none(), 1 ether);
        assertEq(auction.bidUnits(id, bob), 100);
        assertEq(auction.escrowedCards(id, bob).length, 1, "1 ETH is one card");
    }

    function test_TheSellerCannotBid() public {
        uint256 id = _openAndHandOver();
        vm.deal(artist, 10 ether);
        vm.prank(artist);
        vm.expectRevert(IShapeTitleAuction.SellerCannotBid.selector);
        auction.bid{value: 1 ether + feeOf(1 ether)}(id, _none(), 1 ether);
    }

    function test_ABidMustClearTheStandingOne() public {
        uint256 id = _openAndHandOver();
        uint256 a = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(a), 0);

        // 1 ETH + 5% rounds up to 105 units; 1 ETH alone does not clear it.
        uint256 b = _card(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.BidTooLow.selector, uint64(100), uint64(105)));
        auction.bid(id, _one(b), 0);
    }

    /// @notice A Black Shape reads as 100 ETH by denomination and zero by backing. Bids are valued
    ///         by backing, which is what rejects it.
    function test_ABlackShapeIsWorthlessAsABid() public {
        uint256 id = _openAndHandOver();

        vm.prank(alice);
        uint256 first =
            shapes.mintBatchTo{value: 10_000 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 10_000, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        vm.prank(alice);
        shapes.sacrifice(first);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.WorthlessCard.selector, first));
        auction.bid(id, _one(first), 0);
    }

    /* ----------------------------- settling ----------------------------- */

    function test_SettlementRecordsAndMovesNothing() public {
        uint256 id = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(card), 0);

        skip(DURATION);
        auction.settle(id); // permissionless
        assertEq(shapes.titleHolder(), address(auction), "settlement delivers nothing");
        assertTrue(auction.auctions(id).settled);
    }

    function test_TheWinnerPullsTitleAndTheSellerPullsTheBid() public {
        uint256 id = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(card), 0);
        skip(DURATION);
        auction.settle(id);

        vm.prank(alice);
        auction.claimTitle(id);
        assertEq(shapes.titleHolder(), alice, "title passed to the winner");
        assertEq(shapes.titleSince(), uint64(block.timestamp), "and the stamp moved with it");

        vm.prank(artist);
        auction.claimProceeds(id);
        assertEq(shapes.ownerOf(card), artist, "the artist was paid in Shapes");
        assertEq(shapes.balanceOf(address(auction)), 0, "nothing retained");
    }

    function test_OnlyTheWinnerMayTakeTitle() public {
        uint256 id = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(card), 0);
        skip(DURATION);
        auction.settle(id);

        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.NotTitleRecipient.selector, id, artist));
        auction.claimTitle(id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.NotTitleRecipient.selector, id, bob));
        auction.claimTitle(id);
    }

    function test_TitleCannotBeClaimedTwiceOrEarly() public {
        uint256 id = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(card), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.AuctionStillRunning.selector, id));
        auction.claimTitle(id);

        skip(DURATION);
        auction.settle(id);
        vm.prank(alice);
        auction.claimTitle(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.TitleAlreadyClaimed.selector, id));
        auction.claimTitle(id);
    }

    function test_ALoserWithdrawsAndTheLeaderCannot() public {
        uint256 id = _openAndHandOver();
        uint256 a = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(a), 0);
        uint256 b = _card(bob, 5 ether);
        vm.prank(bob);
        auction.bid(id, _one(b), 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, bob));
        auction.withdraw(id);

        vm.prank(alice);
        auction.withdraw(id);
        assertEq(shapes.ownerOf(a), alice, "the outbid bidder pulled their card back");
    }

    /* ---------------------------- cancelling ---------------------------- */

    function test_ACancelledAuctionReturnsTitleToTheSeller() public {
        uint256 id = _openAndHandOver();
        vm.prank(artist);
        auction.cancel(id);
        assertEq(shapes.titleHolder(), address(auction), "cancelling moves nothing either");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeTitleAuction.NotTitleRecipient.selector, id, alice));
        auction.claimTitle(id);

        vm.prank(artist);
        auction.claimTitle(id);
        assertEq(shapes.titleHolder(), artist, "the artist has it back");
    }

    function test_CancelIsRefusedOnceABidLands() public {
        uint256 id = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(id, _one(card), 0);

        vm.prank(artist);
        vm.expectRevert(IShapeTitleAuction.InvalidAuction.selector);
        auction.cancel(id);
    }

    /* ----------------------------- resale ------------------------------- */

    /// @notice The point of the contract: title changes hands and the new holder can sell it on.
    function test_TheWinnerCanSellTitleOnAgain() public {
        uint256 first = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        vm.prank(alice);
        auction.bid(first, _one(card), 0);
        skip(DURATION);
        auction.settle(first);
        vm.prank(alice);
        auction.claimTitle(first);
        assertEq(shapes.titleHolder(), alice);

        // Alice, now the holder, runs her own auction on the same contract.
        vm.prank(alice);
        uint256 second = auction.open(DURATION, RESERVE, INCREMENT_BPS, EXTENSION);
        vm.prank(alice);
        shapes.transferTitle(address(auction));

        uint256 bobCard = _card(bob, 5 ether);
        vm.prank(bob);
        auction.bid(second, _one(bobCard), 0);
        skip(DURATION);
        auction.settle(second);
        vm.prank(bob);
        auction.claimTitle(second);

        assertEq(shapes.titleHolder(), bob, "title reached a second buyer");
        vm.prank(alice);
        auction.claimProceeds(second);
        assertEq(shapes.ownerOf(bobCard), alice, "and the first buyer was paid");
    }

    /// @notice Title carries no authority, so a sale must not move anything else.
    function test_ASaleTouchesNothingButTheTitle() public {
        uint256 id = _openAndHandOver();
        uint256 card = _card(alice, 1 ether);
        uint256 backingBefore = shapes.redeemableBacking();
        address ownerBefore = shapes.owner();

        vm.prank(alice);
        auction.bid(id, _one(card), 0);
        skip(DURATION);
        auction.settle(id);
        vm.prank(alice);
        auction.claimTitle(id);

        assertEq(shapes.owner(), ownerBefore, "administrative ownership is untouched");
        assertEq(shapes.redeemableBacking(), backingBefore, "no ETH moved through the reserve");
        assertEq(address(auction).balance, 0, "the auction holds no ETH");
    }
}

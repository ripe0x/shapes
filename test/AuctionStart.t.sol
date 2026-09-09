// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuctionBase} from "./AuctionHouse.t.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";
import {IShapeAuctionHouseStartTime} from "../src/interfaces/IShapeAuctionHouseStartTime.sol";

/// @dev Bids open at `startTime`; before it, bid reverts `NotStarted`.
contract AuctionStartTest is AuctionBase {
    function _openAt(uint64 startTime) internal returns (uint256 auctionId) {
        vm.prank(seller);
        auctionId = house.createAuction(
            address(shapes), lotId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION, startTime
        );
    }

    /// @dev The live mainnet and Sepolia `AdminOps` libraries check this exact id in
    ///      `Shapes.setPointer`. A change to the `IShapeAuctionHouse` function set makes every
    ///      live token refuse a new house.
    function test_PointerInterfaceIdIsFrozen() public view {
        assertEq(type(IShapeAuctionHouse).interfaceId, bytes4(0xaa0978b5));
        assertTrue(house.supportsInterface(type(IShapeAuctionHouse).interfaceId));
        assertTrue(house.supportsInterface(type(IShapeAuctionHouseStartTime).interfaceId));
    }

    function test_SixParameterCreateAuctionOpensImmediatelyAndAcceptsABid() public {
        vm.prank(seller);
        uint256 id =
            house.createAuction(address(shapes), lotId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
        assertEq(house.auctions(id).startTime, 0);

        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(card), 0);
        assertEq(house.auctions(id).highestBidder, alice);
    }

    function test_BidBeforeStartTimeReverts() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;
        uint256 id = _openAt(startTime);
        uint256 card = _mintCard(alice, DENOMS[4]);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotStarted.selector, id, startTime));
        house.bid(id, _one(card), 0);
    }

    function test_BidAtExactStartTimeSucceedsAndSetsEndTime() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;
        uint256 id = _openAt(startTime);
        uint256 card = _mintCard(alice, DENOMS[4]);

        vm.warp(startTime);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        assertEq(house.auctions(id).endTime, startTime + DURATION, "endTime is startTime + duration");
    }

    function test_ZeroStartTimeAcceptsAnImmediateBid() public {
        uint256 id = _openAt(0);
        uint256 card = _mintCard(alice, DENOMS[4]);

        vm.prank(alice);
        house.bid(id, _one(card), 0);
        assertEq(house.auctions(id).highestBidder, alice);
    }

    function test_PastStartTimeAcceptsAnImmediateBid() public {
        uint64 startTime = uint64(block.timestamp) - 1;
        uint256 id = _openAt(startTime);
        uint256 card = _mintCard(alice, DENOMS[4]);

        vm.prank(alice);
        house.bid(id, _one(card), 0);
        assertEq(house.auctions(id).highestBidder, alice);
    }

    function test_StartTimeAtTheMaxStartLeadBoundaryIsAccepted() public {
        uint64 startTime = uint64(block.timestamp) + house.MAX_START_LEAD();
        uint256 id = _openAt(startTime);
        assertEq(house.auctions(id).startTime, startTime);
    }

    function test_StartTimePastTheMaxStartLeadBoundaryReverts() public {
        uint64 startTime = uint64(block.timestamp) + house.MAX_START_LEAD() + 1;
        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.StartTooFar.selector);
        house.createAuction(
            address(shapes), lotId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION, startTime
        );
    }

    function test_StartTimeOneYearOutSucceedsAndBidBeforeItReverts() public {
        uint64 startTime = uint64(block.timestamp) + 365 days;
        uint256 id = _openAt(startTime);
        assertEq(house.auctions(id).startTime, startTime);

        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotStarted.selector, id, startTime));
        house.bid(id, _one(card), 0);
    }

    function test_CancelBeforeStartSucceeds() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;
        uint256 id = _openAt(startTime);

        vm.prank(seller);
        house.cancelAuction(id);
        assertEq(house.auctions(id).settled, true);
    }

    function test_ExtensionWindowStillAppliesAfterStart() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;
        uint256 id = _openAt(startTime);

        vm.warp(startTime);
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint64 firstEnd = house.auctions(id).endTime;

        skip(DURATION - 60); // one minute left, inside the 15 minute window
        uint256 b = _mintCard(bob, DENOMS[5]);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        // `vm.getBlockTimestamp()` rather than a second direct `block.timestamp` read: with
        // `via_ir` on, the optimizer treats two `block.timestamp` reads in one function as the
        // same value and reuses the first (taken before `startTime` above), which goes stale
        // across the `vm.warp`/`skip` calls in between.
        assertEq(house.auctions(id).endTime, uint64(vm.getBlockTimestamp()) + EXTENSION);
        assertGt(house.auctions(id).endTime, firstEnd, "the end must move out, never in");
    }

    function test_AuctionCreatedEmitsStartTimeAndAuctionsReturnsIt() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;

        vm.expectEmit(true, true, true, true, address(house));
        emit IShapeAuctionHouse.AuctionCreated(
            house.auctionCount(), seller, address(shapes), lotId, DURATION, RESERVE_UNITS, startTime
        );
        uint256 id = _openAt(startTime);

        assertEq(house.auctions(id).startTime, startTime);
    }

    /* ------------------------------ setStartTime ----------------------------- */

    function test_SellerMovesStartTimeEarlierAndLater() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;
        uint256 id = _openAt(startTime);

        uint64 earlier = startTime - 30 minutes;
        vm.prank(seller);
        house.setStartTime(id, earlier);
        assertEq(house.auctions(id).startTime, earlier);

        uint64 later = startTime + 30 minutes;
        vm.prank(seller);
        house.setStartTime(id, later);
        assertEq(house.auctions(id).startTime, later);
    }

    function test_SetStartTimeByNonSellerReverts() public {
        uint256 id = _openAt(uint64(block.timestamp) + 1 hours);

        vm.prank(alice);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.setStartTime(id, uint64(block.timestamp) + 2 hours);
    }

    function test_SetStartTimeAfterABidReverts() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.setStartTime(id, uint64(block.timestamp) + 1 hours);
    }

    function test_SetStartTimeAfterCancelReverts() public {
        uint64 startTime = uint64(block.timestamp) + 1 hours;
        uint256 id = _openAt(startTime);
        vm.prank(seller);
        house.cancelAuction(id);

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.setStartTime(id, startTime);
    }

    function test_SetStartTimeAtTheMaxStartLeadBoundaryIsAccepted() public {
        uint256 id = _open();
        uint64 startTime = uint64(block.timestamp) + house.MAX_START_LEAD();

        vm.prank(seller);
        house.setStartTime(id, startTime);
        assertEq(house.auctions(id).startTime, startTime);
    }

    function test_SetStartTimePastTheMaxStartLeadBoundaryReverts() public {
        uint256 id = _open();
        uint64 startTime = uint64(block.timestamp) + house.MAX_START_LEAD() + 1;

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.StartTooFar.selector);
        house.setStartTime(id, startTime);
    }

    function test_SetStartTimeToZeroOpensBiddingNow() public {
        uint256 id = _openAt(uint64(block.timestamp) + 1 hours);

        vm.prank(seller);
        house.setStartTime(id, 0);
        assertEq(house.auctions(id).startTime, 0);

        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(card), 0);
        assertEq(house.auctions(id).highestBidder, alice);
    }

    function test_SetStartTimeEmitsAuctionStartTimeChanged() public {
        uint256 id = _open();
        uint64 startTime = uint64(block.timestamp) + 1 hours;

        vm.expectEmit(true, true, true, true, address(house));
        emit IShapeAuctionHouse.AuctionStartTimeChanged(id, startTime);
        vm.prank(seller);
        house.setStartTime(id, startTime);
    }
}

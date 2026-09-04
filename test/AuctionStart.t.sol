// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuctionBase} from "./AuctionHouse.t.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";

/// @dev Bids open at `startTime`; before it, bid reverts `NotStarted`.
contract AuctionStartTest is AuctionBase {
    function _openAt(uint64 startTime) internal returns (uint256 auctionId) {
        vm.prank(seller);
        auctionId = house.createAuction(
            address(shapes), lotId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION, startTime
        );
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

    function test_StartTimeAtTheMaxDurationBoundaryIsAccepted() public {
        uint64 startTime = uint64(block.timestamp) + house.MAX_DURATION();
        uint256 id = _openAt(startTime);
        assertEq(house.auctions(id).startTime, startTime);
    }

    function test_StartTimePastTheMaxDurationBoundaryReverts() public {
        uint64 startTime = uint64(block.timestamp) + house.MAX_DURATION() + 1;
        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.StartTooFar.selector);
        house.createAuction(
            address(shapes), lotId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION, startTime
        );
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
}

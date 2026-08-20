// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";

/// @dev H-01: transferFrom succeeds and moves nothing.
contract FakeLot {
    function transferFrom(address, address, uint256) external {}

    function ownerOf(uint256) external view returns (address) {
        return msg.sender;
    }
}

/// @dev H-02: inbound works, outbound reverts.
contract SelectiveLot {
    address public house;

    function setHouse(address h) external {
        house = h;
    }

    function transferFrom(address from, address, uint256) external view {
        if (from == house) revert("no delivery");
    }
}

contract AuctionSecurityTest is Test {
    Shapes shapes;
    ShapeRenderer renderer;
    ShapeCollection collection;
    ShapeAuctionHouse house;
    address seller = makeAddr("seller");
    address alice = makeAddr("alice");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, makeAddr("fee"), address(renderer), address(collection));
        vm.deal(seller, 10 ether);
        house = new ShapeAuctionHouse(address(shapes));
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
    }

    /// @notice H-01. A lot whose `transferFrom` returns without moving anything would let a
    ///         seller collect a real winning bid for a lot that never changed hands. The house
    ///         cannot tell such a contract from an honest one, so it does not accept one: the lot
    ///         is always a Shape. `FakeLot` and `SelectiveLot` below are unreachable as lots, and
    ///         are kept as a record of what the parameter used to admit.
    function test_H01_AnArbitraryContractCannotBeTheLot() public {
        FakeLot fake = new FakeLot();

        // There is no longer a way to name it: `createAuction` takes only a Shape token id, and
        // escrowing pulls through `shapes`. Naming an id the seller does not own reverts.
        vm.prank(seller);
        vm.expectRevert();
        house.createAuction(uint256(uint160(address(fake))), 1, 100, 0, 0);

        assertEq(house.auctionCount(), 0, "no auction was opened over a foreign contract");
    }

    /// @notice H-02. Delivery cannot be made to revert selectively, for the same reason: the only
    ///         lot is a Shape, whose `transferFrom` the house can always complete once it holds
    ///         the token. A seller cannot strand the leader's escrow.
    function test_H02_SettlementCannotBeBlockedByTheLot() public {
        vm.prank(seller);
        uint256 lot = shapes.mint{value: 0.101 ether}(0.1 ether);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 a = house.createAuction(lot, 1, 100, 0, 0);

        vm.prank(alice);
        uint256 card = shapes.mint{value: 1.01 ether}(1 ether);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        vm.prank(alice);
        house.bid(a, ids, 0);

        skip(2);
        house.settle(a); // completes; nothing can interpose
        assertEq(shapes.ownerOf(lot), alice, "winner received the lot");

        vm.prank(seller);
        house.claimProceeds(a);
        assertEq(shapes.ownerOf(card), seller, "seller received the bid, having delivered");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @dev Covers the immutable public mint start gate: the constructor's genesis mint is exempt,
///      `mintBatch`/`mintBatchTo` (and anything built on them, such as the auction house's
///      ETH-backed bid path) are gated, and every other Shape #0 action stays open before start.
contract MintStartTest is Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    address internal feeRecipient = address(0xFEE);
    address internal deployer = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        renderer = new ShapeRenderer();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _deploy(uint64 mintStart_) internal returns (Shapes shapes) {
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), mintStart_
        );
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
    }

    /* --------------------------- genesis, unaffected --------------------------- */

    function test_ConstructorMintsGenesisRegardlessOfFutureStart() public {
        uint64 future = uint64(block.timestamp + 1 days);
        Shapes shapes = _deploy(future);

        assertEq(shapes.ownerOf(0), deployer);
        assertEq(shapes.owner(), deployer);
        assertEq(shapes.ownerToken(), 0);
    }

    function test_TransferOfGenesisWorksBeforeStart() public {
        Shapes shapes = _deploy(uint64(block.timestamp + 1 days));
        shapes.transferFrom(deployer, alice, 0);
        assertEq(shapes.ownerOf(0), alice);
    }

    function test_RedeemGenesisWorksBeforeStart() public {
        Shapes shapes = _deploy(uint64(block.timestamp + 1 days));
        // Redeems to `alice` rather than this test contract: the test contract has no `receive`,
        // so a plain redemption back to it would fail on the ETH transfer, not the mint gate.
        uint256 before = alice.balance;
        shapes.redeemTo(0, payable(alice));
        assertEq(alice.balance, before + Denominations.amountAt(0));
    }

    function test_ListingGenesisInAuctionHouseWorksBeforeStart() public {
        Shapes shapes = _deploy(uint64(block.timestamp + 1 days));
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));
        shapes.approve(address(house), 0);
        uint256 auctionId = house.createAuction(address(shapes), 0, 24 hours, 1, 500, 15 minutes);
        assertEq(shapes.ownerOf(0), address(house));
        assertEq(house.auctions(auctionId).seller, deployer);
    }

    /* ------------------------------ the gate itself ----------------------------- */

    function test_MintBatchRevertsBeforeStart() public {
        Shapes shapes = _deploy(uint64(block.timestamp + 1 days));
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mintBatch{value: Denominations.amountAt(0) + MINT_FEE}(Denominations.amountAt(0), 1);
    }

    function test_MintBatchToRevertsBeforeStart() public {
        Shapes shapes = _deploy(uint64(block.timestamp + 1 days));
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mintBatchTo{value: Denominations.amountAt(0) + MINT_FEE}(Denominations.amountAt(0), 1, bob);
    }

    function test_MintBatchSucceedsExactlyAtStart() public {
        uint64 start = uint64(block.timestamp + 1 days);
        Shapes shapes = _deploy(start);

        vm.warp(start);
        vm.prank(alice);
        uint256 firstId =
            shapes.mintBatch{value: Denominations.amountAt(0) + MINT_FEE}(Denominations.amountAt(0), 1);
        assertEq(shapes.ownerOf(firstId), alice);
    }

    function test_MintStartZeroIsOpenImmediately() public {
        Shapes shapes = _deploy(0);
        vm.prank(alice);
        uint256 firstId =
            shapes.mintBatch{value: Denominations.amountAt(0) + MINT_FEE}(Denominations.amountAt(0), 1);
        assertEq(shapes.ownerOf(firstId), alice);
    }

    /* --------------------- auction house: ETH-backed bids mint --------------------- */

    /// @dev A card-only bid never touches `mintBatchTo`; only an ETH-backed bid does, through
    ///      `ShapeCardEscrow._mintCards`. That path inherits the same gate.
    function test_AuctionBidWithEthRevertsBeforeStartThenSucceedsAfter() public {
        uint64 start = uint64(block.timestamp + 1 days);
        Shapes shapes = _deploy(start);
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));

        shapes.approve(address(house), 0);
        uint256 auctionId = house.createAuction(address(shapes), 0, 24 hours, 1, 500, 15 minutes);

        uint256 ethBacking = Denominations.amountAt(0);
        uint256 cost = ethBacking + MINT_FEE; // one card at the minimum denomination
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        house.bid{value: cost}(auctionId, new uint256[](0), ethBacking);

        vm.warp(start);
        vm.prank(alice);
        house.bid{value: cost}(auctionId, new uint256[](0), ethBacking);
        assertEq(house.bidUnits(auctionId, alice), ethBacking / Denominations.UNIT);
    }
}

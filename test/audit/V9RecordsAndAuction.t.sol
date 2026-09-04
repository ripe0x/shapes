// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {IShapeAuctionHouse} from "../../src/interfaces/IShapeAuctionHouse.sol";
import {IShapeCardEscrow} from "../../src/interfaces/IShapeCardEscrow.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {ShapeAuctionHouse} from "../../src/ShapeAuctionHouse.sol";
import {ComposeRecordView} from "../../src/ShapeTypes.sol";

/// @notice v9 attempts 4 (records crafted through legitimate calls whose later reads misbehave)
///         and 9 (auction paths, with the owner token as the lot).
contract V9RecordsAndAuctionTest is AuditBase {
    /* ------------------------------------------------------------------ */
    /*  attempt 4: crafted records                                         */
    /* ------------------------------------------------------------------ */

    function test_Attempt4_DegenerateComposeInputsAreRejected() public {
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);

        uint256[] memory empty = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(IShapes.NoComposeInputs.selector);
        shapes.compose(survivor, empty);
        vm.expectRevert(IShapes.NoComposeInputs.selector);
        shapes.previewCompose(survivor, empty);

        uint256[] memory dup = new uint256[](2);
        dup[0] = survivor + 1;
        dup[1] = survivor + 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, dup[0]));
        shapes.compose(survivor, dup);
        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, dup[0]));
        shapes.previewCompose(survivor, dup);

        uint256[] memory self = new uint256[](1);
        self[0] = survivor;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, survivor));
        shapes.compose(survivor, self);

        // A sum that is not on the ladder is refused, and the burns are rolled back with it.
        uint256[] memory two = new uint256[](2);
        two[0] = survivor + 1;
        two[1] = survivor + 2;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, 3 * DENOMS[0]));
        shapes.compose(survivor, two);
        assertEq(shapes.ownerOf(survivor + 1), alice, "a rejected compose burned an input");
        _assertReserveInvariant();
    }

    /// @notice A maximal-shaped compose (a hundred inputs) and a maximal-shaped split (a hundred
    ///         children) both round trip, and the reads over their records stay well formed.
    function test_Attempt4_MaximalBatchesRoundTrip() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 100);
        uint256[] memory burnIds = new uint256[](99);
        for (uint256 i = 0; i < 99; ++i) {
            burnIds[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burnIds);
        assertEq(shapes.backingOf(first), DENOMS[4], "one hundred 0.01 make 1 ETH");
        assertEq(shapes.originCountOf(first), 100);

        ComposeRecordView memory rec = shapes.composeRecordAt(first, 0);
        assertEq(rec.inputs.length, 99);
        assertEq(rec.ownerTokenFrom, type(uint256).max, "no ownership moved");
        for (uint256 i = 0; i < 99; ++i) {
            assertEq(rec.inputs[i].id, burnIds[i], "record input order is the calldata order");
        }

        vm.expectRevert(abi.encodeWithSelector(IShapes.ComposeRecordOutOfRange.selector, first, 1, 1));
        shapes.composeRecordAt(first, 1);

        // A hundred 0.01 children out of the 1 ETH survivor, then compose them back.
        uint8[] memory outs = new uint8[](100);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(first, outs);
        assertEq(kids.length, 100);
        assertEq(shapes.totalSupply(), 101, "genesis plus the hundred split children");
        assertEq(shapes.originCountOf(kids[0]), 1, "origins spread one per child");
        _assertReserveInvariant();
    }

    /// @notice `composeMany` may name a survivor an earlier call in the same batch produced, and
    ///         `decomposeMany` unwinds the resulting tree parent before child.
    function test_Attempt4_NestedTreeThroughBatchEntrypoints() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 10);

        IShapes.ComposeCall[] memory calls = new IShapes.ComposeCall[](2);
        uint256[] memory a = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            a[i] = first + 1 + i;
        }
        calls[0] = IShapes.ComposeCall({survivorId: first, burnIds: a});

        uint256[] memory b = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            b[i] = first + 5 + i;
        }
        calls[1] = IShapes.ComposeCall({survivorId: first, burnIds: b});

        vm.prank(alice);
        shapes.composeMany(calls);
        assertEq(shapes.composeDepth(first), 2);
        assertEq(shapes.backingOf(first), DENOMS[2]);

        uint256[] memory unwind = new uint256[](2);
        unwind[0] = first;
        unwind[1] = first;
        vm.prank(alice);
        shapes.decomposeMany(unwind);
        assertEq(shapes.composeDepth(first), 0);
        assertEq(shapes.totalSupply(), 11, "genesis plus the ten restored tokens");
        _assertReserveInvariant();
    }

    /// @notice A split child keeps its split provenance through a later compose and decompose.
    function test_Attempt4_SplitProvenanceSurvivesRecomposition() public {
        uint256 parent = _mint(alice, DENOMS[1]);
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        (, uint256 parentIdBefore,,,,, uint256 childIndexBefore) = shapes.splitOriginOf(kids[1]);
        assertEq(parentIdBefore, parent);
        assertEq(childIndexBefore, 1);

        uint256[] memory burnIds = new uint256[](1);
        burnIds[0] = kids[1];
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, 2 * DENOMS[0]));
        shapes.compose(kids[0], burnIds);

        // Compose all four siblings into kid 0 instead, then decompose.
        uint256[] memory four = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            four[i] = kids[i + 1];
        }
        vm.prank(alice);
        shapes.compose(kids[0], four);
        vm.prank(alice);
        shapes.decompose(kids[0]);

        (, uint256 parentIdAfter,,,,, uint256 childIndexAfter) = shapes.splitOriginOf(kids[1]);
        assertEq(parentIdAfter, parentIdBefore, "split provenance changed across a round trip");
        assertEq(childIndexAfter, childIndexBefore);

        // A token that is not a split child has no entry.
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotASplitChild.selector, uint256(0)));
        shapes.splitOriginOf(0);
        _assertReserveInvariant();
    }

    /* ------------------------------------------------------------------ */
    /*  attempt 9: auction paths                                           */
    /* ------------------------------------------------------------------ */

    function test_Attempt9_OwnerTokenAsTheLot() public {
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(house));

        // Alice holds the owner token and lists it.
        shapes.transferFrom(address(this), alice, 0);
        assertEq(shapes.owner(), alice);

        vm.startPrank(alice);
        shapes.setApprovalForAll(address(house), true);
        uint256 auctionId = house.createAuction(address(shapes), 0, 1 days, 1, 500, 1 hours, 0);
        vm.stopPrank();

        assertEq(shapes.ownerOf(0), address(house), "the house holds the lot");
        assertEq(shapes.owner(), address(house), "owner() follows the owner token into escrow");
        assertEq(shapes.ownerToken(), 0, "the owner token id is unchanged");
        assertEq(shapes.admin(), address(this), "escrow gave the house no admin authority");

        // Bob bids two 0.01 cards, Carol outbids with four.
        address carol = makeAddr("carol");
        vm.deal(carol, 100 ether);
        uint256 bobFirst = _mintBatchTo(bob, DENOMS[0], 2);
        uint256 carolFirst = _mintBatchTo(carol, DENOMS[0], 4);

        uint256[] memory bobCards = new uint256[](2);
        bobCards[0] = bobFirst;
        bobCards[1] = bobFirst + 1;
        vm.startPrank(bob);
        shapes.setApprovalForAll(address(house), true);
        house.bid(auctionId, bobCards, 0);
        vm.stopPrank();
        assertEq(house.bidUnits(auctionId, bob), 2);

        uint256[] memory carolCards = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            carolCards[i] = carolFirst + i;
        }
        vm.startPrank(carol);
        shapes.setApprovalForAll(address(house), true);
        house.bid(auctionId, carolCards, 0);
        vm.stopPrank();

        // The seller cannot bid its own lot.
        vm.prank(alice);
        vm.expectRevert(IShapeAuctionHouse.SellerCannotBid.selector);
        house.bid(auctionId, new uint256[](0), 0);

        // Outbid bob withdraws his cards intact.
        vm.prank(bob);
        house.withdraw(auctionId);
        assertEq(shapes.ownerOf(bobFirst), bob);

        // The leader cannot withdraw.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, auctionId, carol));
        house.withdraw(auctionId);

        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionStillRunning.selector, auctionId));
        house.settle(auctionId);

        vm.warp(block.timestamp + 2 days);
        house.settle(auctionId);

        // Pull-based delivery: the seller claims the cards, the winner claims the lot.
        vm.prank(alice);
        house.claimProceeds(auctionId);
        assertEq(shapes.ownerOf(carolFirst), alice);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, auctionId, bob));
        house.claimLot(auctionId);

        vm.prank(carol);
        house.claimLot(auctionId);
        assertEq(shapes.ownerOf(0), carol);
        assertEq(shapes.owner(), carol, "collection ownership followed the lot to the winner");
        assertEq(shapes.admin(), address(this), "the auction never touched admin");
        _assertReserveInvariant();
    }

    function test_Attempt9_CancelAndBlackCards() public {
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));
        shapes.transferFrom(address(this), alice, 0);

        vm.startPrank(alice);
        shapes.setApprovalForAll(address(house), true);
        uint256 auctionId = house.createAuction(address(shapes), 0, 1 days, 1, 500, 0, 0);
        vm.stopPrank();

        // The same token cannot be listed twice while the house still holds it.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapeAuctionHouse.AuctionAlreadyExistsForToken.selector, address(shapes), uint256(0)
            )
        );
        house.createAuction(address(shapes), 0, 1 days, 1, 500, 0, 0);

        // A bid of no cards and no ETH is refused.
        vm.prank(bob);
        vm.expectRevert(IShapeCardEscrow.EmptyBid.selector);
        house.bid(auctionId, new uint256[](0), 0);

        // Cancel with no bidder, then the seller pulls the lot back.
        vm.prank(alice);
        house.cancelAuction(auctionId);
        vm.prank(alice);
        house.claimLot(auctionId);
        assertEq(shapes.ownerOf(0), alice);
        assertEq(shapes.owner(), alice);
        _assertReserveInvariant();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {PacksTest} from "./utils/PacksTest.sol";
import {IShapePacks, PackState} from "../src/interfaces/IShapePacks.sol";

/// @notice Additions to a live pack: owner-only, the creation rules minus the floor, value and
///         metadata update, and I3 (contents only grow, in order).
contract AddTest is PacksTest {
    address internal carol = address(0xCA401);

    /* ------------------------------ helpers ------------------------------ */

    function _create(address who, uint256[] memory ids, uint32[] memory counts)
        internal
        returns (uint256 packId)
    {
        uint256 cost = costOf(counts);
        vm.prank(who);
        packId = packs.createPack{value: cost}(ids, counts);
    }

    /// @dev A minted three-unit pack held by `who`.
    function _basePack(address who) internal returns (uint256 packId) {
        packId = _create(who, noIds(), mintsOf(0, 3));
    }

    function _add(address who, uint256 packId, uint256[] memory ids, uint32[] memory counts) internal {
        uint256 cost = costOf(counts);
        vm.prank(who);
        packs.addToPack{value: cost}(packId, ids, counts);
    }

    function _range(uint256 first, uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = first + i;
        }
    }

    function _concat(uint256[] memory a, uint256[] memory b) internal pure returns (uint256[] memory out) {
        out = new uint256[](a.length + b.length);
        for (uint256 i = 0; i < a.length; ++i) {
            out[i] = a[i];
        }
        for (uint256 i = 0; i < b.length; ++i) {
            out[a.length + i] = b[i];
        }
    }

    /// @dev I3: `before` is a prefix of the pack's contents now.
    function _assertPrefix(uint256 packId, uint256[] memory before) internal view {
        uint256[] memory now_ = packs.contentsOf(packId);
        assertGe(now_.length, before.length, "contents shrank");
        for (uint256 i = 0; i < before.length; ++i) {
            assertEq(now_[i], before[i], "old contents are a prefix");
        }
    }

    /// @dev I1 and I2 for one live pack, against Shapes' own state.
    function _assertConsistent(uint256 packId, address holder) internal view {
        assertEq(packs.ownerOf(packId), holder, "owner");
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 sum;
        uint32[] memory expectCounts = noMints();
        for (uint256 i = 0; i < contents.length; ++i) {
            assertEq(shapes.ownerOf(contents[i]), address(packs), "custody");
            assertEq(packs.packOf(contents[i]), packId, "packOf");
            sum += shapes.backingOf(contents[i]);
            expectCounts[shapes.denomIndexOf(contents[i])] += 1;
        }
        assertEq(packs.valueOf(packId), sum, "cached value equals the live sum");
        uint32[] memory makeup = packs.makeupOf(packId);
        for (uint256 d = 0; d < makeup.length; ++d) {
            assertEq(makeup[d], expectCounts[d], "makeup");
        }
        assertEq(address(packs).balance, 0, "no ETH held");
    }

    function _makeBlack(address who) internal returns (uint256 id) {
        uint256 amount = amountAt(0);
        uint256 units = 10_000;
        uint256 cost = units * (amount + MINT_FEE);
        vm.prank(who);
        uint256 first = shapes.mintBatchTo{value: cost}(amount, units, who);
        uint256[] memory burn = new uint256[](units - 1);
        for (uint256 i = 0; i < burn.length; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(who);
        id = shapes.compose(first, burn);
        vm.prank(who);
        shapes.burnBacking(id);
        assertTrue(shapes.isBlackShape(id), "black");
    }

    /* ------------------------------ happy paths ------------------------------ */

    function test_AddPulledShape() public {
        uint256 packId = _basePack(alice);
        uint256[] memory before = packs.contentsOf(packId);
        uint256 valueBefore = packs.valueOf(packId);
        uint256 extra = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory counts = noMints();
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 balBefore = alice.balance;

        // No floor on an addition: one 0.01 Shape is fine.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.PackExtended(packId, alice, ids1(extra), 1, unit(), valueBefore + unit());
        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.MetadataUpdate(packId);
        vm.prank(alice);
        packs.addToPack(packId, ids1(extra), counts);

        _assertPrefix(packId, before);
        _assertConsistent(packId, alice);
        uint256[] memory after_ = packs.contentsOf(packId);
        assertEq(after_.length, 4);
        assertEq(after_[3], extra, "appended at the end");
        assertEq(packs.valueOf(packId), valueBefore + unit());
        assertEq(packs.packOf(extra), packId);
        assertEq(shapes.ownerOf(extra), address(packs));
        assertEq(packs.packState(packId).mintedCount, 3, "pulled Shapes are not counted as minted");
        assertEq(shapes.feesOwedTo(feeRecipient), feesBefore, "no fee on a pulled Shape");
        assertEq(alice.balance, balBefore, "no ETH moved");
    }

    function test_AddMintedShapes() public {
        uint256 packId = _basePack(alice);
        uint256[] memory before = packs.contentsOf(packId);
        uint256 valueBefore = packs.valueOf(packId);
        uint32[] memory counts = noMints();
        counts[0] = 1;
        counts[1] = 1;
        uint256 first = shapes.totalMinted();
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 fee = shapes.mintFee();
        uint256 added = amountAt(0) + amountAt(1);

        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.PackExtended(packId, alice, _range(first, 2), 0, added, valueBefore + added);
        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.MetadataUpdate(packId);
        _add(alice, packId, noIds(), counts);

        _assertPrefix(packId, before);
        _assertConsistent(packId, alice);
        assertEq(packs.valueOf(packId), valueBefore + added);
        assertEq(packs.contentsOf(packId).length, 5);
        assertEq(packs.packState(packId).mintedCount, 5, "mintedCount grew by two");
        assertEq(packs.packOf(first), packId);
        assertEq(packs.packOf(first + 1), packId);
        assertEq(shapes.feesOwedTo(feeRecipient) - feesBefore, 2 * fee, "fee accrued for the minted Shapes");
        assertEq(packs.makeupOf(packId)[1], 1);
    }

    function test_AddMixedShapes() public {
        uint256 packId = _basePack(alice);
        uint256[] memory before = packs.contentsOf(packId);
        uint256 valueBefore = packs.valueOf(packId);
        uint256 big = mintShape(alice, 2); // 0.1
        uint256 small = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory counts = mintsOf(0, 2);
        uint256 first = shapes.totalMinted();
        uint256 added = amountAt(2) + amountAt(0) + 2 * amountAt(0);

        uint256[] memory pulled = ids2(small, big);
        uint256[] memory expectAdded = new uint256[](4);
        expectAdded[0] = small;
        expectAdded[1] = big;
        expectAdded[2] = first;
        expectAdded[3] = first + 1;

        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.PackExtended(packId, alice, expectAdded, 2, added, valueBefore + added);
        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.MetadataUpdate(packId);
        _add(alice, packId, pulled, counts);

        _assertPrefix(packId, before);
        _assertConsistent(packId, alice);
        assertEq(packs.valueOf(packId), valueBefore + added);
        uint256[] memory after_ = packs.contentsOf(packId);
        assertEq(after_.length, 7);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(after_[3 + i], expectAdded[i], "pulled then minted, appended in order");
        }
        assertEq(packs.packState(packId).mintedCount, 5);
    }

    function test_AddSingleIndexZeroShapeHasNoFloor() public {
        uint256 packId = _basePack(alice);
        uint32[] memory counts = mintsOf(0, 1);
        _add(alice, packId, noIds(), counts);
        assertEq(packs.valueOf(packId), 4 * unit());
        _assertConsistent(packId, alice);
    }

    function test_RepeatedAdditionsKeepEveryEarlierObservationAPrefix() public {
        uint256 packId = _basePack(alice);
        uint256[] memory seen0 = packs.contentsOf(packId);

        _add(alice, packId, noIds(), mintsOf(0, 1));
        uint256[] memory seen1 = packs.contentsOf(packId);
        _assertPrefix(packId, seen0);

        uint256 held = mintShape(alice, 1);
        approveAll(alice);
        _add(alice, packId, ids1(held), noMints());
        uint256[] memory seen2 = packs.contentsOf(packId);
        _assertPrefix(packId, seen1);
        _assertPrefix(packId, seen0);

        _add(alice, packId, noIds(), mintsOf(2, 1));
        _assertPrefix(packId, seen2);
        _assertPrefix(packId, seen1);
        _assertPrefix(packId, seen0);
        _assertConsistent(packId, alice);
        assertEq(packs.valueOf(packId), 3 * unit() + unit() + amountAt(1) + amountAt(2));
    }

    function test_AddEmitsExactlyOneMetadataUpdate() public {
        uint256 packId = _basePack(alice);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);

        vm.recordLogs();
        vm.prank(alice);
        packs.addToPack{value: cost}(packId, noIds(), counts);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 extended;
        uint256 meta;
        uint256 extendedAt;
        uint256 metaAt;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(packs)) continue;
            if (logs[i].topics[0] == IShapePacks.PackExtended.selector) {
                ++extended;
                extendedAt = i;
            }
            if (logs[i].topics[0] == IShapePacks.MetadataUpdate.selector) {
                ++meta;
                metaAt = i;
                assertEq(abi.decode(logs[i].data, (uint256)), packId);
            }
        }
        assertEq(extended, 1);
        assertEq(meta, 1);
        assertGt(metaAt, extendedAt, "MetadataUpdate follows PackExtended");
    }

    function test_AddedShapesChangeTheTokenUri() public {
        uint256 packId = _basePack(alice);
        string memory before = packs.tokenURI(packId);
        _add(alice, packId, noIds(), mintsOf(1, 1));
        string memory after_ = packs.tokenURI(packId);
        assertTrue(keccak256(bytes(before)) != keccak256(bytes(after_)), "metadata reflects the addition");
    }

    /* --------------------------------- reverts --------------------------------- */

    function test_RevertAddByNonOwner() public {
        uint256 packId = _basePack(alice);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.addToPack{value: cost}(packId, noIds(), counts);
    }

    function test_RevertAddByApprovedOperatorOfThePackToken() public {
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.approve(bob, packId);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.addToPack{value: cost}(packId, noIds(), counts);
    }

    function test_RevertAddByApprovalForAllOperator() public {
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.setApprovalForAll(bob, true);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.addToPack{value: cost}(packId, noIds(), counts);
    }

    function test_RevertAddToUnsealedPack() public {
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.unseal(packId, alice);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);

        // The pack token is burned: nobody owns it, not even the claimant.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, alice));
        vm.prank(alice);
        packs.addToPack{value: cost}(packId, noIds(), counts);
        assertEq(packs.contentsOf(packId).length, 3);
    }

    function test_RevertAddToOpenedPack() public {
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.open(packId);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, alice));
        vm.prank(alice);
        packs.addToPack{value: cost}(packId, noIds(), counts);
    }

    function test_RevertAddToNonexistentPack() public {
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, 999, alice));
        vm.prank(alice);
        packs.addToPack{value: cost}(999, noIds(), counts);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, 0, alice));
        vm.prank(alice);
        packs.addToPack{value: cost}(0, noIds(), counts);
    }

    function test_RevertOwnerCheckPrecedesEveryOtherRule() public {
        uint256 packId = _basePack(alice);
        uint32[] memory bad = new uint32[](2);
        uint32[] memory none = noMints();
        // Bob is not the owner: that is reported before a bad makeup, an empty addition, or bad payment.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.addToPack(packId, noIds(), bad);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.addToPack(packId, noIds(), none);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.addToPack{value: 1}(packId, noIds(), none);
    }

    function test_RevertAddMakeupLengthMismatch() public {
        uint256 packId = _basePack(alice);
        uint256 held = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory bad = new uint32[](3);
        vm.expectRevert(IShapePacks.MakeupLengthMismatch.selector);
        vm.prank(alice);
        packs.addToPack(packId, ids1(held), bad);
    }

    function test_RevertAddNoShapes() public {
        uint256 packId = _basePack(alice);
        uint32[] memory none = noMints();
        vm.expectRevert(IShapePacks.NoShapes.selector);
        vm.prank(alice);
        packs.addToPack(packId, noIds(), none);

        // Rule 2 before rule 3.
        vm.expectRevert(IShapePacks.NoShapes.selector);
        vm.prank(alice);
        packs.addToPack{value: 1}(packId, noIds(), none);
    }

    function test_RevertAddIncorrectPayment() public {
        uint256 packId = _basePack(alice);
        uint32[] memory counts = mintsOf(0, 2);
        uint256 cost = costOf(counts);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, cost, cost + 1));
        vm.prank(alice);
        packs.addToPack{value: cost + 1}(packId, noIds(), counts);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, cost, cost - 1));
        vm.prank(alice);
        packs.addToPack{value: cost - 1}(packId, noIds(), counts);
    }

    function test_RevertAddEthWithPulledOnlyAddition() public {
        uint256 packId = _basePack(alice);
        uint256 held = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory none = noMints();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, 0, 1));
        vm.prank(alice);
        packs.addToPack{value: 1}(packId, ids1(held), none);
    }

    function test_RevertAddWorthlessShapeBlack() public {
        uint256 packId = _basePack(alice);
        uint256 black = _makeBlack(alice);
        uint256 good = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory none = noMints();

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.WorthlessShape.selector, black));
        vm.prank(alice);
        packs.addToPack(packId, ids1(black), none);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.WorthlessShape.selector, black));
        vm.prank(alice);
        packs.addToPack(packId, ids2(good, black), none);

        assertEq(shapes.ownerOf(good), alice);
        assertEq(packs.contentsOf(packId).length, 3, "nothing was added");
        assertEq(packs.valueOf(packId), 3 * unit());
    }

    function test_RevertAddWorthlessShapeCheckedBeforeThePull() public {
        // No approval for the Black Shape: refused as worthless, not as unapproved.
        uint256 packId = _basePack(alice);
        uint256 black = _makeBlack(alice);
        uint32[] memory none = noMints();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.WorthlessShape.selector, black));
        vm.prank(alice);
        packs.addToPack(packId, ids1(black), none);
    }

    function test_RevertAddDeadId() public {
        uint256 packId = _basePack(alice);
        uint256 id = mintShape(alice, 0);
        vm.prank(alice);
        shapes.redeem(id);
        approveAll(alice);
        uint32[] memory none = noMints();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        vm.prank(alice);
        packs.addToPack(packId, ids1(id), none);
    }

    function test_RevertAddWithoutApproval() public {
        uint256 packId = _basePack(alice);
        uint256 id = mintShape(alice, 0);
        uint32[] memory none = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(packs), id)
        );
        vm.prank(alice);
        packs.addToPack(packId, ids1(id), none);
    }

    function test_RevertAddAShapeAlreadyInThePack() public {
        uint256 packId = _basePack(alice);
        uint256[] memory inside = packs.contentsOf(packId);
        approveAll(alice);
        uint32[] memory none = noMints();
        // The pack contract is its own owner for the pull, so it fails the `from` check.
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC721Errors.ERC721IncorrectOwner.selector, alice, inside[0], address(packs)
            )
        );
        vm.prank(alice);
        packs.addToPack(packId, ids1(inside[0]), none);
    }

    function test_RevertAddAnotherPacksShape() public {
        uint256 packA = _basePack(alice);
        uint256 packB = _basePack(alice);
        uint256[] memory inB = packs.contentsOf(packB);
        approveAll(alice);
        uint32[] memory none = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, inB[0], address(packs))
        );
        vm.prank(alice);
        packs.addToPack(packA, ids1(inB[0]), none);
        assertEq(packs.packOf(inB[0]), packB);
    }

    function test_RevertAddDuplicateId() public {
        uint256 packId = _basePack(alice);
        uint256 id = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory none = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, id, address(packs))
        );
        vm.prank(alice);
        packs.addToPack(packId, ids2(id, id), none);
    }

    /* --------------------------- ownership after transfer --------------------------- */

    function test_AfterTransferBobCanAddAndAliceCannot() public {
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.transferFrom(alice, bob, packId);

        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, alice));
        vm.prank(alice);
        packs.addToPack{value: cost}(packId, noIds(), counts);

        uint256 bobShape = mintShape(bob, 1);
        approveAll(bob);
        uint256[] memory before = packs.contentsOf(packId);
        uint256 valueBefore = packs.valueOf(packId);
        uint256 first = shapes.totalMinted();
        _add(bob, packId, ids1(bobShape), counts);

        _assertPrefix(packId, before);
        _assertConsistent(packId, bob);
        assertEq(packs.valueOf(packId), valueBefore + amountAt(1) + unit());
        uint256[] memory after_ = packs.contentsOf(packId);
        assertEq(after_[3], bobShape);
        assertEq(after_[4], first);
        assertEq(packs.creatorOf(packId), alice, "creator is unchanged by a later owner");
        assertEq(packs.packState(packId).creator, alice);
    }

    function test_AdditionByNewOwnerEmitsThemAsBy() public {
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.transferFrom(alice, bob, packId);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 first = shapes.totalMinted();
        uint256 valueBefore = packs.valueOf(packId);

        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.PackExtended(packId, bob, _range(first, 1), 0, unit(), valueBefore + unit());
        _add(bob, packId, noIds(), counts);
    }

    /* ---------------------------------- big packs ---------------------------------- */

    function test_FortyShapePackBuiltInFourAdditionsOpensInOneCall() public {
        // 1: create with 10 minted.
        uint256 packId = _create(alice, noIds(), mintsOf(0, 10));
        uint256[] memory expect = packs.contentsOf(packId);
        assertEq(expect.length, 10);

        // 2: add 10 pulled.
        uint256[] memory held = mintShapes(alice, 0, 10);
        approveAll(alice);
        _add(alice, packId, held, noMints());
        _assertPrefix(packId, expect);
        expect = _concat(expect, held);

        // 3: add 10 minted.
        uint256 first = shapes.totalMinted();
        _add(alice, packId, noIds(), mintsOf(0, 10));
        _assertPrefix(packId, expect);
        expect = _concat(expect, _range(first, 10));

        // 4: add 5 pulled and 5 minted.
        uint256[] memory held2 = mintShapes(alice, 0, 5);
        uint256 first2 = shapes.totalMinted();
        _add(alice, packId, held2, mintsOf(0, 5));
        _assertPrefix(packId, expect);
        expect = _concat(_concat(expect, held2), _range(first2, 5));

        uint256[] memory contents = packs.contentsOf(packId);
        assertEq(contents.length, 40);
        assertEq(packs.valueOf(packId), 40 * unit());
        assertEq(packs.packState(packId).mintedCount, 25);
        _assertConsistent(packId, alice);
        for (uint256 i = 0; i < 40; ++i) {
            assertEq(contents[i], expect[i], "order across four additions");
        }

        uint256 heldBefore = shapes.balanceOf(alice);
        vm.prank(alice);
        packs.open(packId);

        assertEq(shapes.balanceOf(alice), heldBefore + 40, "all 40 returned");
        for (uint256 i = 0; i < 40; ++i) {
            assertEq(shapes.ownerOf(expect[i]), alice);
            assertEq(packs.packOf(expect[i]), 0);
        }
        assertEq(shapes.balanceOf(address(packs)), 0);
        assertEq(packs.contentsOf(packId).length, 0);
        assertEq(address(packs).balance, 0);
    }

    function test_AdditionsAcrossHoldersKeepValueExact() public {
        vm.deal(carol, 100 ether);
        uint256 packId = _basePack(alice);
        vm.prank(alice);
        packs.transferFrom(alice, bob, packId);
        _add(bob, packId, noIds(), mintsOf(3, 1));
        vm.prank(bob);
        packs.transferFrom(bob, carol, packId);
        _add(carol, packId, noIds(), mintsOf(1, 2));

        assertEq(packs.valueOf(packId), 3 * unit() + amountAt(3) + 2 * amountAt(1));
        _assertConsistent(packId, carol);

        // Redeeming returns exactly the cached value.
        uint256 value = packs.valueOf(packId);
        uint256 before = carol.balance;
        vm.prank(carol);
        packs.redeem(packId);
        assertEq(carol.balance - before, value);
    }
}

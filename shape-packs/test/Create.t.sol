// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IShapes} from "shapes/interfaces/IShapes.sol";

import {PacksTest} from "./utils/PacksTest.sol";
import {IShapePacks, PackState} from "../src/interfaces/IShapePacks.sol";

/// @dev A contract with no receiver hook and no fallback: `_safeMint` to it reverts with empty data.
contract NoReceiver {}

/// @dev A receiver that answers with the wrong selector.
contract WrongSelectorReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return bytes4(0xdeadbeef);
    }
}

/// @notice Every creation rule and error: pulled, minted and mixed packs, exact payment, rule order.
contract CreateTest is PacksTest {
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

    function _createTo(address who, uint256[] memory ids, uint32[] memory counts, address to)
        internal
        returns (uint256 packId)
    {
        uint256 cost = costOf(counts);
        vm.prank(who);
        packId = packs.createPackTo{value: cost}(ids, counts, to);
    }

    function _range(uint256 first, uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = first + i;
        }
    }

    /// @dev Everything a live pack must expose, checked against Shapes' own state.
    function _assertPack(
        uint256 packId,
        address holder,
        address creator,
        uint256[] memory expectIds,
        uint256 expectValue,
        uint256 expectMinted
    ) internal view {
        assertEq(packs.ownerOf(packId), holder, "owner");
        assertTrue(packs.exists(packId), "exists");
        assertEq(packs.valueOf(packId), expectValue, "valueOf");
        assertEq(packs.creatorOf(packId), creator, "creatorOf");
        assertEq(address(packs).balance, 0, "pack holds no ETH");

        uint256[] memory contents = packs.contentsOf(packId);
        assertEq(contents.length, expectIds.length, "contents length");

        uint32[] memory expectCounts = noMints();
        uint256 sum;
        for (uint256 i = 0; i < expectIds.length; ++i) {
            assertEq(contents[i], expectIds[i], "contents order");
            assertEq(packs.packOf(contents[i]), packId, "packOf");
            assertEq(shapes.ownerOf(contents[i]), address(packs), "Shapes custody");
            expectCounts[shapes.denomIndexOf(contents[i])] += 1;
            sum += shapes.backingOf(contents[i]);
        }
        assertEq(sum, expectValue, "value is the sum of backing");

        uint32[] memory makeup = packs.makeupOf(packId);
        assertEq(makeup.length, expectCounts.length, "makeup length");
        for (uint256 d = 0; d < makeup.length; ++d) {
            assertEq(makeup[d], expectCounts[d], "makeup count");
        }

        PackState memory st = packs.packState(packId);
        assertEq(st.shapeIds.length, expectIds.length, "state ids length");
        for (uint256 i = 0; i < expectIds.length; ++i) {
            assertEq(st.shapeIds[i], expectIds[i], "state ids");
        }
        for (uint256 d = 0; d < makeup.length; ++d) {
            assertEq(st.counts[d], expectCounts[d], "state counts");
        }
        assertEq(st.valueWei, expectValue, "state value");
        assertEq(st.mintedCount, expectMinted, "state mintedCount");
        assertEq(st.creator, creator, "state creator");
    }

    /// @dev A genuine Black Shape, built the only way Shapes allows: 10,000 direct dust mints composed
    ///      into one apex Complete, then `burnBacking`. The same recipe Shapes' own suite uses.
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

    /* ------------------------- minted-only packs ------------------------- */

    function test_MintedPackAtFloor() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 first = shapes.totalMinted();
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 supplyBefore = shapes.totalSupply();
        uint256 balBefore = alice.balance;
        uint256 cost = costOf(counts);
        uint256 fee = shapes.mintFee();

        uint256 packId = _create(alice, noIds(), counts);

        assertEq(packId, 1, "first pack id");
        _assertPack(packId, alice, alice, _range(first, 3), 3 * unit(), 3);
        assertEq(shapes.feesOwedTo(feeRecipient) - feesBefore, fee * 3, "fee accrual");
        assertEq(shapes.totalSupply() - supplyBefore, 3, "three Shapes minted");
        assertEq(shapes.balanceOf(address(packs)), 3, "pack holds three");
        assertEq(balBefore - alice.balance, cost, "alice paid exactly the quote");
        assertEq(packs.totalMinted(), 1, "totalMinted");
        assertEq(packs.totalSupply(), 1, "totalSupply");
        assertEq(packs.MIN_PACK_VALUE(), 3 * unit(), "floor");
    }

    function test_MintedPackAboveFloorWithOneIndexOneShape() public {
        uint32[] memory counts = mintsOf(1, 1);
        uint256 first = shapes.totalMinted();
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 fee = shapes.mintFee();

        uint256 packId = _create(alice, noIds(), counts);

        _assertPack(packId, alice, alice, _range(first, 1), amountAt(1), 1);
        assertEq(shapes.feesOwedTo(feeRecipient) - feesBefore, fee, "fee accrual");
        assertEq(shapes.denomIndexOf(first), 1);
    }

    function test_MintedPackOfSeveralIndicesInOneMakeup() public {
        uint32[] memory counts = noMints();
        counts[0] = 2;
        counts[1] = 1;
        counts[2] = 1;
        counts[4] = 1;
        uint256 first = shapes.totalMinted();
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 fee = shapes.mintFee();
        uint256 expectValue = 2 * amountAt(0) + amountAt(1) + amountAt(2) + amountAt(4);

        uint256 packId = _create(alice, noIds(), counts);

        // Minted Shapes are ordered by ascending ladder index, each batch contiguous.
        _assertPack(packId, alice, alice, _range(first, 5), expectValue, 5);
        assertEq(shapes.denomIndexOf(first), 0);
        assertEq(shapes.denomIndexOf(first + 1), 0);
        assertEq(shapes.denomIndexOf(first + 2), 1);
        assertEq(shapes.denomIndexOf(first + 3), 2);
        assertEq(shapes.denomIndexOf(first + 4), 4);
        assertEq(shapes.feesOwedTo(feeRecipient) - feesBefore, fee * 5, "fee accrual");

        uint32[] memory makeup = packs.makeupOf(packId);
        for (uint256 d = 0; d < makeup.length; ++d) {
            assertEq(makeup[d], counts[d]);
        }
    }

    /* ------------------------- pulled-only packs ------------------------- */

    function test_PulledOnlyPackWithApprovalForAll() public {
        uint256[] memory held = mintShapes(alice, 0, 3);
        approveAll(alice);
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 supplyBefore = shapes.totalSupply();
        uint256 balBefore = alice.balance;
        uint32[] memory counts = noMints();

        vm.prank(alice);
        uint256 packId = packs.createPack(held, counts);

        _assertPack(packId, alice, alice, held, 3 * unit(), 0);
        assertEq(shapes.feesOwedTo(feeRecipient), feesBefore, "no fee on pulled Shapes");
        assertEq(shapes.totalSupply(), supplyBefore, "nothing minted");
        assertEq(alice.balance, balBefore, "no ETH moved");
        assertEq(shapes.balanceOf(alice), 0);
    }

    function test_PulledOnlyPackWithPerTokenApprove() public {
        uint256[] memory held = mintShapes(alice, 0, 3);
        for (uint256 i = 0; i < held.length; ++i) {
            vm.prank(alice);
            shapes.approve(address(packs), held[i]);
        }
        uint32[] memory counts = noMints();

        vm.prank(alice);
        uint256 packId = packs.createPack(held, counts);

        _assertPack(packId, alice, alice, held, 3 * unit(), 0);
    }

    function test_PulledSingleShapeAboveFloor() public {
        uint256 id = mintShape(alice, 1);
        approveAll(alice);
        uint32[] memory counts = noMints();

        vm.prank(alice);
        uint256 packId = packs.createPack(ids1(id), counts);

        _assertPack(packId, alice, alice, ids1(id), amountAt(1), 0);
    }

    /* ------------------------------ mixed packs ------------------------------ */

    function test_MixedPackPulledThenMinted() public {
        uint256 big = mintShape(alice, 1); // 0.05
        uint256 small = mintShape(alice, 0); // 0.01
        approveAll(alice);
        uint32[] memory counts = noMints();
        counts[0] = 2;
        counts[2] = 1;
        uint256 first = shapes.totalMinted();
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        uint256 fee = shapes.mintFee();
        uint256 expectValue = amountAt(1) + amountAt(0) + 2 * amountAt(0) + amountAt(2);

        // The caller's order is kept: [small, big] pulled, then the three minted.
        uint256[] memory pulled = ids2(small, big);
        uint256 packId = _create(alice, pulled, counts);

        uint256[] memory expect = new uint256[](5);
        expect[0] = small;
        expect[1] = big;
        expect[2] = first;
        expect[3] = first + 1;
        expect[4] = first + 2;
        _assertPack(packId, alice, alice, expect, expectValue, 3);
        assertEq(shapes.feesOwedTo(feeRecipient) - feesBefore, fee * 3, "fee only on minted Shapes");
    }

    /* ----------------------------- createPackTo ----------------------------- */

    function test_CreatePackToBob() public {
        uint256 held = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory counts = mintsOf(0, 2);
        uint256 first = shapes.totalMinted();
        uint256 cost = costOf(counts);
        uint256[] memory expect = new uint256[](3);
        expect[0] = held;
        expect[1] = first;
        expect[2] = first + 1;

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackCreated(1, alice, bob, expect, 1, 3 * unit());
        vm.expectEmit(true, true, true, true, address(packs));
        emit IERC721.Transfer(address(0), bob, 1);
        vm.prank(alice);
        uint256 packId = packs.createPackTo{value: cost}(ids1(held), counts, bob);

        _assertPack(packId, bob, alice, expect, 3 * unit(), 2);
        assertEq(shapes.balanceOf(alice), 0);
        assertEq(packs.balanceOf(alice), 0);
        assertEq(packs.balanceOf(bob), 1);
    }

    /* ------------------------------- events ------------------------------- */

    function test_PackCreatedEventExact() public {
        uint256 a = mintShape(alice, 0);
        uint256 b = mintShape(alice, 1);
        approveAll(alice);
        uint32[] memory counts = noMints();
        counts[0] = 1;
        counts[1] = 1;
        uint256 first = shapes.totalMinted();
        uint256 cost = costOf(counts);
        uint256 expectValue = amountAt(0) + amountAt(1) + amountAt(0) + amountAt(1);

        uint256[] memory expect = new uint256[](4);
        expect[0] = b;
        expect[1] = a;
        expect[2] = first;
        expect[3] = first + 1;

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackCreated(1, alice, alice, expect, 2, expectValue);
        vm.expectEmit(true, true, true, true, address(packs));
        emit IERC721.Transfer(address(0), alice, 1);
        vm.prank(alice);
        packs.createPack{value: cost}(ids2(b, a), counts);
    }

    function test_PackCreatedPrecedesTheMintTransfer() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);

        vm.recordLogs();
        vm.prank(alice);
        uint256 packId = packs.createPack{value: cost}(noIds(), counts);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        int256 createdAt = -1;
        int256 transferAt = -1;
        uint256 shapeTransfersIn;
        uint256 shapeMinted;
        for (uint256 i = 0; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics[0];
            if (logs[i].emitter == address(packs)) {
                if (sig == IShapePacks.PackCreated.selector) createdAt = int256(i);
                if (sig == IERC721.Transfer.selector && logs[i].topics[1] == bytes32(0)) {
                    transferAt = int256(i);
                    assertEq(uint256(logs[i].topics[3]), packId);
                }
            } else if (logs[i].emitter == address(shapes)) {
                if (
                    sig == IERC721.Transfer.selector
                        && logs[i].topics[2] == bytes32(uint256(uint160(address(packs))))
                ) {
                    ++shapeTransfersIn;
                }
                if (sig == IShapes.ShapeMinted.selector) {
                    ++shapeMinted;
                    assertEq(
                        address(uint160(uint256(logs[i].topics[2]))),
                        address(packs),
                        "ShapeMinted to the pack"
                    );
                }
            }
        }
        assertGe(createdAt, 0, "PackCreated emitted");
        assertGt(transferAt, createdAt, "Transfer comes after PackCreated");
        assertEq(uint256(transferAt), logs.length - 1, "the pack Transfer is the last log");
        assertEq(shapeTransfersIn, 3, "Shapes emitted a Transfer into the pack for each mint");
        assertEq(shapeMinted, 3, "Shapes emitted ShapeMinted with to == pack");
    }

    /* ------------------------ reverts, in the design's order ------------------------ */

    function test_RevertMakeupLengthMismatchWithValidShapeIds() public {
        uint256 id = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory bad = new uint32[](3);
        bad[0] = 3;

        vm.expectRevert(IShapePacks.MakeupLengthMismatch.selector);
        vm.prank(alice);
        packs.createPack(ids1(id), bad);
    }

    function test_RevertMakeupLengthMismatchTooLongAndEmpty() public {
        uint256 id = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory tooLong = new uint32[](uint256(shapes.denominationCount()) + 1);
        uint32[] memory empty = new uint32[](0);

        vm.expectRevert(IShapePacks.MakeupLengthMismatch.selector);
        vm.prank(alice);
        packs.createPack(ids1(id), tooLong);

        vm.expectRevert(IShapePacks.MakeupLengthMismatch.selector);
        vm.prank(alice);
        packs.createPack(ids1(id), empty);
    }

    function test_RevertMakeupLengthBeatsNoShapesAndPayment() public {
        uint32[] memory bad = new uint32[](2);
        // Wrong length, no Shapes at all, and a stray payment: rule 1 wins.
        vm.expectRevert(IShapePacks.MakeupLengthMismatch.selector);
        vm.prank(alice);
        packs.createPack{value: 1 ether}(noIds(), bad);
    }

    function test_RevertNoShapesEmptyIdsZeroCounts() public {
        uint32[] memory counts = noMints();
        vm.expectRevert(IShapePacks.NoShapes.selector);
        vm.prank(alice);
        packs.createPack(noIds(), counts);
    }

    function test_RevertNoShapesBeatsIncorrectPayment() public {
        uint32[] memory counts = noMints();
        // Rule 2 precedes rule 3: ETH with nothing to buy is NoShapes, not IncorrectPayment(0, 1).
        vm.expectRevert(IShapePacks.NoShapes.selector);
        vm.prank(alice);
        packs.createPack{value: 1}(noIds(), counts);
    }

    function test_RevertIncorrectPaymentOver() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, cost, cost + 1));
        vm.prank(alice);
        packs.createPack{value: cost + 1}(noIds(), counts);
    }

    function test_RevertIncorrectPaymentUnder() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, cost, cost - 1));
        vm.prank(alice);
        packs.createPack{value: cost - 1}(noIds(), counts);
    }

    function test_RevertIncorrectPaymentBackingOnlyIsNotEnough() public {
        // The fee is part of the price: sending backing alone is under by exactly the fee.
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, cost, 3 * unit()));
        vm.prank(alice);
        packs.createPack{value: 3 * unit()}(noIds(), counts);
    }

    function test_RevertIncorrectPaymentEthWithPulledOnlyPack() public {
        uint256[] memory held = mintShapes(alice, 0, 3);
        approveAll(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, 0, 1));
        vm.prank(alice);
        packs.createPack{value: 1}(held, counts);
    }

    function test_RevertPaymentIsCheckedBeforeAnyPull() public {
        // Bob's Shape could never be pulled by alice, but rule 3 fires first.
        uint256 bobs = mintShape(bob, 0);
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, cost, cost + 1));
        vm.prank(alice);
        packs.createPack{value: cost + 1}(ids1(bobs), counts);
    }

    function test_RevertWorthlessShapeForABlackShape() public {
        uint256 black = _makeBlack(alice);
        assertEq(shapes.backingOf(black), 0, "Black has zero backing");
        assertEq(shapes.denomIndexOf(black), 8, "but keeps the apex denomination index");
        approveAll(alice);
        uint256 good = mintShape(alice, 0);
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.WorthlessShape.selector, black));
        vm.prank(alice);
        packs.createPack{value: cost}(ids1(black), counts);

        // A valid Shape before it does not save the pack, and nothing is left behind.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.WorthlessShape.selector, black));
        vm.prank(alice);
        packs.createPack{value: cost}(ids2(good, black), counts);
        assertEq(shapes.ownerOf(good), alice);
        assertEq(packs.totalMinted(), 0);
    }

    function test_RevertWorthlessShapeIsCheckedBeforeThePull() public {
        // No approval at all: a pull would fail with ERC721InsufficientApproval, but rule 4 checks
        // backing first, so the Black Shape is refused as worthless.
        uint256 black = _makeBlack(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.WorthlessShape.selector, black));
        vm.prank(alice);
        packs.createPack(ids1(black), counts);
    }

    function test_EveryLiveDenominationHasNonzeroBacking() public {
        // WorthlessShape is reachable only through Black: every live non-Black Shape, at every rung,
        // reports its full denomination as backing.
        for (uint256 d = 0; d < shapes.denominationCount(); ++d) {
            uint256 id = mintShape(alice, d);
            assertEq(shapes.backingOf(id), amountAt(d), "backing equals denomination");
            assertGt(shapes.backingOf(id), 0);
        }
    }

    function test_RevertDeadIdFromBackingOf() public {
        uint256 id = mintShape(alice, 0);
        vm.prank(alice);
        shapes.redeem(id);
        assertFalse(shapes.exists(id));
        approveAll(alice);
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);

        // `backingOf` reverts on a dead id before `WorthlessShape` can be considered.
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        vm.prank(alice);
        packs.createPack{value: cost}(ids1(id), counts);
    }

    function test_RevertNeverMintedId() public {
        uint256 id = 123_456;
        approveAll(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        vm.prank(alice);
        packs.createPack(ids1(id), counts);
    }

    function test_RevertPullingAShapeAliceDoesNotOwnWithoutBobsApproval() public {
        // Alice approved the pack contract for her own Shapes, but Bob never did: the pack contract
        // is not authorised to move Bob's Shape, and OZ checks that before it checks `from`.
        uint256 bobs = mintShape(bob, 0);
        approveAll(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(packs), bobs)
        );
        vm.prank(alice);
        packs.createPack(ids1(bobs), counts);
    }

    function test_RevertPullingAShapeAliceDoesNotOwnEvenWhenBobApprovedThePack() public {
        // Bob approved the pack contract, so `_update` is authorised; the `from` check then fails:
        // the approval cannot be exercised by Alice's call.
        uint256 bobs = mintShape(bob, 0);
        approveAll(bob);
        approveAll(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, bobs, bob));
        vm.prank(alice);
        packs.createPack(ids1(bobs), counts);
        assertEq(shapes.ownerOf(bobs), bob);
    }

    function test_RevertPullingWithoutApproval() public {
        uint256[] memory held = mintShapes(alice, 0, 3);
        uint32[] memory counts = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(packs), held[0])
        );
        vm.prank(alice);
        packs.createPack(held, counts);
    }

    function test_RevertPullingOnlySomeApproved() public {
        uint256[] memory held = mintShapes(alice, 0, 3);
        vm.prank(alice);
        shapes.approve(address(packs), held[0]);
        vm.prank(alice);
        shapes.approve(address(packs), held[1]);
        // held[2] is not approved: the whole creation reverts and the first two stay with alice.
        uint32[] memory counts = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(packs), held[2])
        );
        vm.prank(alice);
        packs.createPack(held, counts);
        assertEq(shapes.ownerOf(held[0]), alice);
        assertEq(shapes.ownerOf(held[1]), alice);
    }

    function test_RevertDuplicateIdInShapeIds() public {
        // The first pull succeeds; the second finds the Shape already in the pack contract. The pack
        // contract is its own owner by then, so it passes OZ's authorisation and fails the `from`
        // check instead.
        uint256 id = mintShape(alice, 1);
        approveAll(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, id, address(packs))
        );
        vm.prank(alice);
        packs.createPack(ids2(id, id), counts);
        assertEq(shapes.ownerOf(id), alice, "everything rolled back");
    }

    function test_RevertPackBelowMinimumTwoMinted() public {
        uint32[] memory counts = mintsOf(0, 2);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.PackBelowMinimum.selector, 2 * unit(), 3 * unit()));
        vm.prank(alice);
        packs.createPack{value: cost}(noIds(), counts);
        assertEq(packs.totalMinted(), 0);
        assertEq(shapes.totalMinted(), 1, "the mint was rolled back");
    }

    function test_RevertPackBelowMinimumOnePulled() public {
        uint256 id = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory counts = noMints();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.PackBelowMinimum.selector, unit(), 3 * unit()));
        vm.prank(alice);
        packs.createPack(ids1(id), counts);
        assertEq(shapes.ownerOf(id), alice);
    }

    function test_RevertPackBelowMinimumMixedTwoUnits() public {
        uint256 id = mintShape(alice, 0);
        approveAll(alice);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.PackBelowMinimum.selector, 2 * unit(), 3 * unit()));
        vm.prank(alice);
        packs.createPack{value: cost}(ids1(id), counts);
    }

    function test_FloorIsInclusiveOfExactlyThreeUnits() public {
        // 2 units pulled + 1 unit minted is exactly the floor and passes.
        uint256[] memory held = mintShapes(alice, 0, 2);
        approveAll(alice);
        uint32[] memory counts = mintsOf(0, 1);
        uint256 packId = _create(alice, held, counts);
        assertEq(packs.valueOf(packId), 3 * unit());
    }

    function test_RevertPullFailureBeatsFloorCheck() public {
        // One unapproved unit-sized Shape is also below the floor, but the pull (rule 4) fails
        // before the floor (rule 6) is looked at.
        uint256 id = mintShape(alice, 0);
        uint32[] memory counts = noMints();
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(packs), id)
        );
        vm.prank(alice);
        packs.createPack(ids1(id), counts);
    }

    function test_RevertInvalidRecipientZero() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(0)));
        vm.prank(alice);
        packs.createPackTo{value: cost}(noIds(), counts, address(0));
    }

    function test_RevertSelfCustodyRejectedWhenRecipientIsThePack() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.SelfCustodyRejected.selector, 1));
        vm.prank(alice);
        packs.createPackTo{value: cost}(noIds(), counts, address(packs));
        assertEq(packs.totalMinted(), 0, "pack id not consumed");
    }

    function test_RevertRecipientContractWithoutReceiver() public {
        NoReceiver nr = new NoReceiver();
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(nr)));
        vm.prank(alice);
        packs.createPackTo{value: cost}(noIds(), counts, address(nr));
    }

    function test_RevertRecipientContractWithWrongSelector() public {
        WrongSelectorReceiver wr = new WrongSelectorReceiver();
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(wr)));
        vm.prank(alice);
        packs.createPackTo{value: cost}(noIds(), counts, address(wr));
    }

    function test_RevertedCreationLeavesNoTrace() public {
        uint256[] memory held = mintShapes(alice, 0, 2);
        approveAll(alice);
        uint32[] memory counts = mintsOf(0, 0); // nothing minted; 2 units pulled is below the floor
        uint256 supplyBefore = shapes.totalSupply();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.PackBelowMinimum.selector, 2 * unit(), 3 * unit()));
        vm.prank(alice);
        packs.createPack(held, counts);
        assertEq(shapes.totalSupply(), supplyBefore);
        assertEq(packs.packOf(held[0]), 0);
        assertEq(packs.packOf(held[1]), 0);
        assertEq(shapes.ownerOf(held[0]), alice);
        assertEq(packs.totalMinted(), 0);
        assertEq(packs.totalSupply(), 0);
    }

    /* --------------------------------- fee race --------------------------------- */

    function test_RevertFeeChangeBetweenQuoteAndSend() public {
        uint32[] memory counts = mintsOf(0, 3);
        (,, uint256 quotedTotal,) = packs.quoteMint(counts);
        assertEq(quotedTotal, costOf(counts));

        // Shapes' admin is the deployer, this contract.
        uint256 newFee = unit() / 5;
        assertGt(newFee, shapes.mintFee());
        shapes.setMintFee(newFee);

        uint256 newTotal = 3 * (amountAt(0) + newFee);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, newTotal, quotedTotal));
        vm.prank(alice);
        packs.createPack{value: quotedTotal}(noIds(), counts);

        // Paying the new quote works, and the new fee accrues.
        uint256 feesBefore = shapes.feesOwedTo(feeRecipient);
        vm.prank(alice);
        packs.createPack{value: newTotal}(noIds(), counts);
        assertEq(shapes.feesOwedTo(feeRecipient) - feesBefore, 3 * newFee);
    }

    function test_RevertFeeLoweredBetweenQuoteAndSend() public {
        uint32[] memory counts = mintsOf(0, 3);
        (,, uint256 quotedTotal,) = packs.quoteMint(counts);
        shapes.setMintFee(0);
        // Overpaying is refused too: ETH is never silently kept.
        vm.expectRevert(
            abi.encodeWithSelector(IShapePacks.IncorrectPayment.selector, 3 * amountAt(0), quotedTotal)
        );
        vm.prank(alice);
        packs.createPack{value: quotedTotal}(noIds(), counts);
    }

    /* --------------------------------- views --------------------------------- */

    function test_QuoteMintMatchesCostAndShapeCount() public view {
        uint32[] memory counts = noMints();
        counts[0] = 3;
        counts[1] = 2;
        counts[3] = 1;
        counts[8] = 4;
        (uint256 backing, uint256 feeWei, uint256 total, uint256 n) = packs.quoteMint(counts);
        assertEq(n, 10, "shape count");
        assertEq(backing, 3 * amountAt(0) + 2 * amountAt(1) + amountAt(3) + 4 * amountAt(8), "backing");
        assertEq(feeWei, 10 * shapes.mintFee(), "fee");
        assertEq(total, backing + feeWei, "total");
        assertEq(total, costOf(counts), "matches the fixture's cost");
    }

    function test_QuoteMintOfNothingIsZero() public view {
        uint32[] memory counts = noMints();
        (uint256 backing, uint256 feeWei, uint256 total, uint256 n) = packs.quoteMint(counts);
        assertEq(backing, 0);
        assertEq(feeWei, 0);
        assertEq(total, 0);
        assertEq(n, 0);
    }

    function test_RevertQuoteMintWrongLength() public {
        uint32[] memory bad = new uint32[](4);
        vm.expectRevert(IShapePacks.MakeupLengthMismatch.selector);
        packs.quoteMint(bad);
    }

    function test_DefaultMakeupThreeUnits() public view {
        uint32[] memory m = packs.defaultMakeup(3 * unit());
        assertEq(m.length, shapes.denominationCount());
        assertEq(m[0], 3);
        for (uint256 d = 1; d < m.length; ++d) {
            assertEq(m[d], 0);
        }
    }

    function test_DefaultMakeupEightUnits() public view {
        // 0.08 = 0.05 + 3 x 0.01
        uint32[] memory m = packs.defaultMakeup(8 * unit());
        assertEq(m[0], 3);
        assertEq(m[1], 1);
        for (uint256 d = 2; d < m.length; ++d) {
            assertEq(m[d], 0);
        }
    }

    function test_DefaultMakeupOneFiftySixUnits() public view {
        // 1.56 = 1 + 0.5 + 0.05 + 0.01
        uint32[] memory m = packs.defaultMakeup(156 * unit());
        assertEq(m[0], 1);
        assertEq(m[1], 1);
        assertEq(m[2], 0);
        assertEq(m[3], 1);
        assertEq(m[4], 1);
        for (uint256 d = 5; d < m.length; ++d) {
            assertEq(m[d], 0);
        }
    }

    function test_DefaultMakeupSumsToTheAmountAndIsGreedy() public view {
        uint256 amount = 98_765 * unit();
        uint32[] memory m = packs.defaultMakeup(amount);
        uint256 sum;
        for (uint256 d = 0; d < m.length; ++d) {
            sum += uint256(m[d]) * amountAt(d);
            if (d + 1 < m.length) {
                // Every smaller rung holds strictly fewer than the next rung needs to replace it.
                assertLt(uint256(m[d]) * amountAt(d), amountAt(d + 1), "greedy: remainder below next rung");
            }
        }
        assertEq(sum, amount);
    }

    function test_DefaultMakeupOfZeroIsEmptyMakeup() public view {
        uint32[] memory m = packs.defaultMakeup(0);
        assertEq(m.length, shapes.denominationCount());
        for (uint256 d = 0; d < m.length; ++d) {
            assertEq(m[d], 0);
        }
    }

    function test_DefaultMakeupBuildsAValidPack() public {
        uint32[] memory m = packs.defaultMakeup(156 * unit());
        uint256 first = shapes.totalMinted();
        uint256 packId = _create(alice, noIds(), m);
        assertEq(packs.valueOf(packId), 156 * unit());
        assertEq(packs.contentsOf(packId).length, 4);
        assertEq(shapes.denomIndexOf(first), 0);
    }

    function test_RevertDefaultMakeupNotAUnitMultiple() public {
        uint256 half = unit() / 2;
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotAUnitMultiple.selector, half));
        packs.defaultMakeup(half);

        uint256 off = 3 * unit() + 1;
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotAUnitMultiple.selector, off));
        packs.defaultMakeup(off);
    }

    /* ------------------------------- owner token ------------------------------- */

    function test_OwnerTokenFollowsThePackAndReturnsOnOpen() public {
        // Shape #0 carries collection ownership and is held by this contract (the deployer).
        assertEq(shapes.ownerToken(), 0);
        assertEq(shapes.owner(), address(this));
        shapes.setApprovalForAll(address(packs), true);

        uint32[] memory counts = mintsOf(0, 2);
        uint256 cost = costOf(counts);
        uint256 packId = packs.createPack{value: cost}(ids1(0), counts);

        assertEq(packs.ownerOf(packId), address(this));
        assertEq(shapes.ownerOf(0), address(packs));
        assertEq(packs.packOf(0), packId);
        assertEq(shapes.owner(), address(packs), "collection owner is the pack while packed");
        assertEq(packs.valueOf(packId), 3 * unit());

        packs.open(packId);

        assertEq(shapes.owner(), address(this), "ownership returns to the opener");
        assertEq(shapes.ownerOf(0), address(this));
        assertEq(packs.packOf(0), 0);
    }

    function test_OwnerTokenReturnsToWhoeverOpens() public {
        shapes.setApprovalForAll(address(packs), true);
        uint32[] memory counts = mintsOf(0, 2);
        uint256 cost = costOf(counts);
        uint256 packId = packs.createPackTo{value: cost}(ids1(0), counts, alice);
        assertEq(shapes.owner(), address(packs));

        vm.prank(alice);
        packs.open(packId);
        assertEq(shapes.owner(), alice);
    }

    /* ---------------------------------- fuzz ---------------------------------- */

    function testFuzz_MintedPackValue(uint8 idx, uint8 n) public {
        uint256 index = bound(uint256(idx), 0, 8);
        uint256 count = bound(uint256(n), 1, 12);
        uint256 expectValue = count * amountAt(index);
        vm.assume(expectValue >= 3 * unit());

        uint32[] memory counts = mintsOf(index, uint32(count));
        uint256 first = shapes.totalMinted();
        uint256 packId = _create(alice, noIds(), counts);

        assertEq(packs.valueOf(packId), expectValue);
        assertEq(packs.contentsOf(packId).length, count);
        assertEq(packs.packState(packId).mintedCount, count);
        assertEq(packs.makeupOf(packId)[index], count);
        assertEq(shapes.denomIndexOf(first), index);
        assertEq(address(packs).balance, 0);
    }
}

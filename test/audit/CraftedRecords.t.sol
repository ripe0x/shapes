// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AuditBase} from "./AuditBase.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {ComposeRecordView, ShapeChildPreview, ShapeState} from "../../src/ShapeTypes.sol";

/// @notice Required adversarial attempt 4: build a compose record or a split record through
///         legitimate calls whose later decompose or provenance read misbehaves. Duplicate ids,
///         id reuse, zero-length inputs and maximal batch sizes.
contract CraftedRecordsTest is AuditBase {
    /* ------------------------- rejected shapes of input ------------------------- */

    /// @notice A repeated id is rejected by the mutator and the preview with the same error.
    function test_DuplicateComposeInputRejectedOnBothSides() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 3);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 1;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, first + 1));
        shapes.compose(first, burn);

        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, first + 1));
        shapes.previewCompose(first, burn);

        // A repeat far apart in a long list is caught the same way: the check sorts.
        uint256 wide = _mintBatchTo(alice, DENOMS[0], 40);
        uint256[] memory many = new uint256[](39);
        for (uint256 i = 0; i < 39; ++i) {
            many[i] = wide + 1 + i;
        }
        many[38] = many[0];
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, many[0]));
        shapes.compose(wide, many);
    }

    /// @notice Zero-length input and self-burn are rejected on both sides. A burn of a token the
    ///         caller does not own is rejected by `compose` alone: the preview checks structure,
    ///         not ownership, so it answers for the same input set.
    function test_DegenerateComposeInputsRejectedOnBothSides() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 2);
        uint256[] memory empty = new uint256[](0);

        vm.prank(alice);
        vm.expectRevert(IShapes.NoComposeInputs.selector);
        shapes.compose(first, empty);
        vm.expectRevert(IShapes.NoComposeInputs.selector);
        shapes.previewCompose(first, empty);

        uint256[] memory selfBurn = new uint256[](1);
        selfBurn[0] = first;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, first));
        shapes.compose(first, selfBurn);
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, first));
        shapes.previewCompose(first, selfBurn);

        uint256 mine = _mintBatchTo(alice, DENOMS[0], 4);
        uint256 bobs = _mint(bob, DENOMS[0]);
        uint256[] memory notMine = new uint256[](4);
        for (uint256 i = 0; i < 3; ++i) {
            notMine[i] = mine + 1 + i;
        }
        notMine[3] = bobs;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, bobs, alice));
        shapes.compose(mine, notMine);
        assertEq(
            shapes.previewCompose(mine, notMine).denominationIndex, 1, "the preview applied an ownership gate"
        );
    }

    /* ---------------------------- maximal batches ---------------------------- */

    /// @notice The largest record the ladder can express: 10,000 dust folded into one apex, then
    ///         unwound. Ids are restored verbatim, none collides with a live id, and backing is
    ///         conserved at every step.
    function test_MaximalComposeRecordUnwindsExactly() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 10_000);
        uint256 reserve = shapes.redeemableBacking();

        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);

        assertEq(shapes.backingOf(first), DENOMS[8], "apex not reached");
        assertEq(shapes.originCountOf(first), 10_000, "origin count wrong");
        assertEq(shapes.redeemableBacking(), reserve, "compose moved backing");
        assertEq(shapes.composeDepth(first), 1, "one record expected");

        // A fresh mint takes the next id, above every id the record will restore.
        uint256 fresh = _mint(bob, DENOMS[0]);
        assertGt(fresh, first + 9_999, "fresh id collided with the record's range");

        vm.prank(alice);
        uint256[] memory restored = shapes.decompose(first);
        assertEq(restored.length, 9_999, "wrong restore count");
        for (uint256 i = 0; i < 9_999; ++i) {
            assertEq(restored[i], first + 1 + i, "restored id is not the original");
            assertEq(shapes.backingOf(restored[i]), DENOMS[0], "restored backing wrong");
            assertEq(shapes.ownerOf(restored[i]), alice, "restored owner wrong");
        }
        assertEq(shapes.ownerOf(fresh), bob, "the fresh token was clobbered");
        assertEq(shapes.redeemableBacking(), reserve + DENOMS[0], "decompose moved backing");
        assertEq(shapes.composeDepth(first), 0, "record not popped");
        _assertReserveInvariant();
    }

    /// @notice The largest split the ladder can express: one apex into 10,000 dust. Origins are
    ///         allocated exactly, every child carries a split reference, and backing is conserved.
    function test_MaximalSplitAllocatesOriginsExactly() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 10_000);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        uint256 reserve = shapes.redeemableBacking();

        uint8[] memory outs = new uint8[](10_000); // 10,000 x 0.01 == 100
        vm.prank(alice);
        uint256[] memory kids = shapes.splitTo(first, outs, alice);

        assertEq(kids.length, 10_000, "wrong child count");
        assertEq(shapes.redeemableBacking(), reserve, "split moved backing");

        uint256 originSum;
        for (uint256 i = 0; i < 10_000; ++i) {
            originSum += shapes.originCountOf(kids[i]);
            assertEq(shapes.backingOf(kids[i]), DENOMS[0], "child backing wrong");
        }
        assertEq(originSum, 10_000, "origins were created or destroyed by split");

        (,, uint8 parentDenomIndex, uint8 originDenomIndex,,, uint256 childIndex) =
            shapes.splitOriginOf(kids[9_999]);
        assertEq(parentDenomIndex, 8, "parent denomination wrong");
        assertEq(originDenomIndex, 8, "root split ancestor wrong");
        assertEq(childIndex, 9_999, "child index truncated");
        _assertReserveInvariant();
    }

    /* --------------------------- provenance reads --------------------------- */

    /// @notice A dangling record (survivor burned into another compose) is unreachable while its
    ///         survivor is dead, and fires exactly once when the survivor is revived.
    function test_DanglingRecordCannotBeReplayed() public {
        uint256 a = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnA = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnA[i] = a + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(a, burnA); // a is 0.05, depth 1

        uint256 c = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnC = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnC[i] = c + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(c, burnC); // c is 0.05, depth 1

        uint256[] memory burnAintoC = new uint256[](1);
        burnAintoC[0] = a;
        vm.prank(alice);
        shapes.compose(c, burnAintoC); // c is 0.1, depth 2; a's record dangles

        assertEq(shapes.composeDepth(a), 1, "a's record vanished");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, a));
        shapes.decompose(a);

        uint256 reserve = shapes.redeemableBacking();

        vm.prank(alice);
        shapes.decompose(c); // pops the a-record, a is live again with its own record intact
        assertEq(shapes.composeDepth(a), 1, "a's record was not carried through");

        vm.prank(alice);
        uint256[] memory back = shapes.decompose(a);
        assertEq(back.length, 4, "a's record restored the wrong count");
        assertEq(shapes.composeDepth(a), 0, "a's record fired twice");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NoComposeRecord.selector, a));
        shapes.decompose(a);

        assertEq(shapes.redeemableBacking(), reserve, "the unwind moved backing");
        _assertReserveInvariant();
    }

    /// @notice Stacked records unwind newest first, and each pop restores exactly its own record.
    function test_StackedRecordsUnwindLifo() public {
        uint256 s = _mintBatchTo(alice, DENOMS[0], 10);
        uint256[] memory first4 = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            first4[i] = s + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(s, first4); // s -> 0.05

        uint256[] memory next5 = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            next5[i] = s + 5 + i;
        }
        vm.prank(alice);
        shapes.compose(s, next5); // s -> 0.1
        assertEq(shapes.composeDepth(s), 2, "two records expected");

        ComposeRecordView memory top = shapes.composeRecordAt(s, 1);
        assertEq(top.inputs.length, 5, "top record is not the newest compose");
        assertEq(top.survivorDenominationIndex, 1, "top record's survivor snapshot wrong");

        ComposeRecordView memory bottom = shapes.composeRecordAt(s, 0);
        assertEq(bottom.inputs.length, 4, "bottom record wrong");
        assertEq(bottom.survivorDenominationIndex, 0, "bottom record's survivor snapshot wrong");
        assertEq(bottom.ownerTokenFrom, type(uint256).max, "record claims an owner token it never held");

        vm.expectRevert(abi.encodeWithSelector(IShapes.ComposeRecordOutOfRange.selector, s, 2, 2));
        shapes.composeRecordAt(s, 2);

        vm.prank(alice);
        uint256[] memory popped = shapes.decompose(s);
        assertEq(popped.length, 5, "LIFO order broken");
        assertEq(shapes.backingOf(s), DENOMS[1], "survivor not restored to the newest snapshot");

        vm.prank(alice);
        popped = shapes.decompose(s);
        assertEq(popped.length, 4, "second pop wrong");
        assertEq(shapes.backingOf(s), DENOMS[0], "survivor not restored to its original state");
        _assertReserveInvariant();
    }

    /// @notice `splitOriginOf` refuses a token that was never a split child and keeps naming the
    ///         root split ancestor across nested splits.
    function test_SplitProvenanceDoesNotMisreport() public {
        uint256 parent = _mint(alice, DENOMS[3]); // 0.5

        vm.expectRevert(abi.encodeWithSelector(IShapes.NotASplitChild.selector, parent));
        shapes.splitOriginOf(parent);

        uint8[] memory outs = new uint8[](5);
        for (uint256 i = 0; i < 5; ++i) {
            outs[i] = 2; // 5 x 0.1 == 0.5
        }
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        uint8[] memory outs2 = new uint8[](2);
        outs2[0] = 1;
        outs2[1] = 1; // 0.05 + 0.05 == 0.1
        vm.prank(alice);
        uint256[] memory grandkids = shapes.split(kids[0], outs2);

        (,,, uint8 rootDenom,,,) = shapes.splitOriginOf(grandkids[0]);
        assertEq(rootDenom, 3, "root split ancestor was lost across the second split");

        (, uint256 parentId, uint8 parentDenom,,,, uint256 idx) = shapes.splitOriginOf(grandkids[1]);
        assertEq(parentId, kids[0], "parent id wrong");
        assertEq(parentDenom, 2, "immediate parent denomination wrong");
        assertEq(idx, 1, "child index wrong");
        _assertReserveInvariant();
    }

    /// @notice A split whose outputs do not sum to the parent's backing, or which names an index
    ///         off the ladder, is rejected on both the mutator and the preview.
    function test_MalformedSplitRejectedOnBothSides() public {
        uint256 parent = _mint(alice, DENOMS[2]); // 0.1

        uint8[] memory one = new uint8[](1);
        vm.prank(alice);
        vm.expectRevert(IShapes.SplitTooFewOutputs.selector);
        shapes.split(parent, one);
        vm.expectRevert(IShapes.SplitTooFewOutputs.selector);
        shapes.previewSplit(parent, one);

        uint8[] memory wrongSum = new uint8[](2);
        wrongSum[0] = 0;
        wrongSum[1] = 0; // 0.02 != 0.1
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitSumMismatch.selector, DENOMS[2], DENOMS[0] * 2));
        shapes.split(parent, wrongSum);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitSumMismatch.selector, DENOMS[2], DENOMS[0] * 2));
        shapes.previewSplit(parent, wrongSum);

        uint8[] memory offLadder = new uint8[](2);
        offLadder[0] = 9;
        offLadder[1] = 0;
        vm.prank(alice);
        vm.expectRevert();
        shapes.split(parent, offLadder);
        vm.expectRevert();
        shapes.previewSplit(parent, offLadder);

        assertEq(shapes.backingOf(parent), DENOMS[2], "a rejected split still touched the parent");
        _assertReserveInvariant();
    }

    /// @notice The preview and the mutator agree on the survivor state a compose would produce,
    ///         including for a survivor that already carries materialized geometry.
    function test_PreviewMatchesExecutionOnAMaterializedSurvivor() public {
        uint256 s = _mintBatchTo(alice, DENOMS[0], 10);
        uint256[] memory firstFour = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            firstFour[i] = s + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(s, firstFour); // s is materialized now

        uint256[] memory nextFive = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            nextFive[i] = s + 5 + i;
        }

        ShapeState memory predicted = shapes.previewCompose(s, nextFive);
        vm.prank(alice);
        shapes.compose(s, nextFive);
        ShapeState memory actual = shapes.shapeState(s);

        assertEq(predicted.denominationIndex, actual.denominationIndex, "denomination drifted");
        assertEq(predicted.originCount, actual.originCount, "origin count drifted");
        assertEq(predicted.inkGene, actual.inkGene, "ink gene drifted");
        assertEq(predicted.faceValueWei, actual.faceValueWei, "face value drifted");
        assertEq(keccak256(predicted.modules), keccak256(actual.modules), "modules drifted");
    }

    /// @notice Same for split, over a parent with a compose record (the record-pool branch).
    function test_PreviewSplitMatchesExecution() public {
        uint256 s = _mintBatchTo(alice, DENOMS[0], 10);
        uint256[] memory nine = new uint256[](9);
        for (uint256 i = 0; i < 9; ++i) {
            nine[i] = s + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(s, nine); // s -> 0.1, with a record

        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        ShapeChildPreview[] memory predicted = shapes.previewSplit(s, outs);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(s, outs);

        for (uint256 i = 0; i < 2; ++i) {
            ShapeState memory got = shapes.shapeState(kids[i]);
            assertEq(predicted[i].seed, got.seed, "child seed drifted");
            assertEq(predicted[i].denominationIndex, got.denominationIndex, "child denomination drifted");
            assertEq(predicted[i].originCount, got.originCount, "child origin count drifted");
            assertEq(predicted[i].inkGene, got.inkGene, "child ink gene drifted");
            assertEq(keccak256(predicted[i].modules), keccak256(got.modules), "child modules drifted");
        }
    }
}

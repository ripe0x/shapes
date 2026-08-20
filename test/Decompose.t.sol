// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ShapesBase} from "./Shapes.t.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {ShapeRevivalPreview} from "../src/interfaces/IShapeCapabilities.sol";

/// @notice `decompose`: the exact inverse of `compose`. The survivor keeps its id and seed and
///         reverts to its pre-compose state; every burned input is re-minted under its original id
///         and seed. Stacked composes on one survivor unwind newest first (LIFO).
contract DecomposeTest is ShapesBase {
    /// @dev Mint `k` 0.01 dust to alice; ids are `first .. first + k - 1`.
    function _mintDust(uint256 k) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: k * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, k);
    }

    /// @dev Compose the `k` dust starting at `first` into survivor `first`.
    function _composeDust(uint256 first, uint256 k) internal returns (uint256 survivor) {
        uint256[] memory burn = new uint256[](k - 1);
        for (uint256 i = 0; i < k - 1; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    /* ------------------------------ round trip ------------------------------ */

    function test_RoundTripRestoresOriginalIdsSeedsAndState() public {
        uint256 first = _mintDust(5);

        // Snapshot the four inputs' seeds before they are burned.
        bytes32[4] memory seeds;
        uint8[4] memory genes;
        for (uint256 i = 0; i < 4; ++i) {
            seeds[i] = shapes.seedOf(first + 1 + i);
            genes[i] = shapes.inkGeneOf(first + 1 + i);
        }
        bytes32 survivorSeed = shapes.seedOf(first);
        uint8 survivorGene = shapes.inkGeneOf(first);

        uint256 survivor = _composeDust(first, 5);
        assertEq(survivor, first, "survivor keeps its id");
        assertEq(shapes.backingOf(survivor), 0.05 ether, "grew to 0.05");
        assertEq(shapes.composeDepth(survivor), 1, "one record pushed");
        assertEq(shapes.totalSupply(), 1, "four inputs burned");

        vm.prank(alice);
        uint256[] memory restored = shapes.decompose(survivor);

        // Survivor reverted exactly.
        assertEq(shapes.backingOf(survivor), 0.01 ether, "survivor back to 0.01");
        assertEq(shapes.originCountOf(survivor), 1, "survivor origins restored");
        assertEq(shapes.seedOf(survivor), survivorSeed, "survivor seed never changed");
        assertEq(shapes.inkGeneOf(survivor), survivorGene, "survivor gene restored");
        assertEq(shapes.composeDepth(survivor), 0, "record popped");

        // Inputs re-minted under their original ids, seeds, state.
        assertEq(restored.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(restored[i], first + 1 + i, "original id restored, in order");
            assertEq(shapes.ownerOf(first + 1 + i), alice, "re-minted to caller");
            assertEq(shapes.seedOf(first + 1 + i), seeds[i], "original seed restored");
            assertEq(shapes.inkGeneOf(first + 1 + i), genes[i], "original gene restored");
            assertEq(shapes.backingOf(first + 1 + i), 0.01 ether, "original denom restored");
            assertEq(shapes.originCountOf(first + 1 + i), 1, "original origins restored");
        }

        assertEq(shapes.totalSupply(), 5, "all five live again");
        assertEq(shapes.totalMinted(), 5, "totalMinted not bumped: ids reused");
        assertEq(shapes.redeemableBacking(), 0.05 ether, "backing conserved");
        _assertSolvent();
    }

    function test_EmitsDecomposedWithSurvivorState() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);

        uint256[] memory expectedIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            expectedIds[i] = first + 1 + i;
        }

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.Decomposed(survivor, expectedIds, 0, 1); // reverts to denomIndex 0, origin 1
        vm.prank(alice);
        shapes.decompose(survivor);
    }

    /* ------------------------------ stacked LIFO ------------------------------ */

    function test_StackedComposesUnwindNewestFirst() public {
        // Build a 0.05 survivor, then merge a second 0.05 into it to reach 0.1.
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5); // 0.05, depth 1

        uint256 secondFirst = _mintDust(5);
        uint256 second = _composeDust(secondFirst, 5); // a separate 0.05

        uint256[] memory burn = new uint256[](1);
        burn[0] = second;
        vm.prank(alice);
        shapes.compose(survivor, burn); // 0.1, depth 2
        assertEq(shapes.backingOf(survivor), 0.1 ether);
        assertEq(shapes.composeDepth(survivor), 2, "two stacked records");

        // First pop: reverse the newest merge -> back to 0.05, `second` re-minted (still 0.05).
        vm.prank(alice);
        shapes.decompose(survivor);
        assertEq(shapes.backingOf(survivor), 0.05 ether, "reverted one tier");
        assertEq(shapes.composeDepth(survivor), 1, "one record left");
        assertEq(shapes.ownerOf(second), alice, "second re-minted");
        assertEq(shapes.backingOf(second), 0.05 ether, "second at its merged denom");
        assertEq(shapes.composeDepth(second), 1, "second's own record survived");

        // Second pop: reverse the original build -> back to 0.01, the four dust re-minted.
        vm.prank(alice);
        shapes.decompose(survivor);
        assertEq(shapes.backingOf(survivor), 0.01 ether, "back to dust");
        assertEq(shapes.composeDepth(survivor), 0);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(first + 1 + i), alice, "original dust re-minted");
        }
        _assertSolvent();
    }

    /* ------------------------------ nested ------------------------------ */

    function test_NestedDecomposeUnwindsBottomUp() public {
        // A: a 0.05 survivor with its own record.
        uint256 firstA = _mintDust(5);
        uint256 a = _composeDust(firstA, 5); // depth(a) == 1

        // C: another 0.05 survivor; then A is burned INTO C.
        uint256 firstC = _mintDust(5);
        uint256 c = _composeDust(firstC, 5);

        uint256[] memory burn = new uint256[](1);
        burn[0] = a;
        vm.prank(alice);
        shapes.compose(c, burn); // c -> 0.1, a burned as input; depth(c) == 2, depth(a) still 1

        assertEq(shapes.composeDepth(c), 2);
        assertEq(shapes.composeDepth(a), 1, "A's record persists while A is burned");

        // Reverse C's outer merge: A comes back at 0.05, its record intact.
        vm.prank(alice);
        shapes.decompose(c);
        assertEq(shapes.ownerOf(a), alice, "A re-minted");
        assertEq(shapes.backingOf(a), 0.05 ether, "A restored to its merged denom");
        assertEq(shapes.composeDepth(a), 1, "A still reversible");

        // Now unwind A itself.
        vm.prank(alice);
        shapes.decompose(a);
        assertEq(shapes.backingOf(a), 0.01 ether, "A back to dust");
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(firstA + 1 + i), alice, "A's dust re-minted");
        }
        _assertSolvent();
    }

    /* ------------------------------ guards ------------------------------ */

    function test_RevertsForNonOwner() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, survivor, bob));
        shapes.decompose(survivor);
    }

    function test_RevertsWithNoRecord() public {
        uint256 id = _mint(alice, 1 ether); // never composed
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NoComposeRecord.selector, id));
        shapes.decompose(id);
    }

    function test_RevertsOnSecondDecomposeOfDepthOne() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        vm.prank(alice);
        shapes.decompose(survivor);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NoComposeRecord.selector, survivor));
        shapes.decompose(survivor);
    }

    function test_SplitAbandonsRecordAndDecomposeReverts() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5); // 0.05

        uint8[] memory outs = new uint8[](5);
        // all default to index 0 (five 0.01): sums to 0.05
        vm.prank(alice);
        shapes.split(survivor, outs); // survivor burned into fresh ids

        // The record is now inert: the survivor no longer exists.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, survivor));
        shapes.decompose(survivor);
    }

    /* --------------------------- id reuse safety --------------------------- */

    function test_ReusedIdsDoNotCollideWithFreshMints() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        vm.prank(alice);
        shapes.decompose(survivor); // re-mints ids first+1..first+4

        // A fresh mint takes `totalMinted`, above every id already issued; no collision with the
        // reused ids.
        uint256 fresh = _mint(alice, 1 ether);
        assertEq(fresh, 5, "fresh mint takes totalMinted");
        assertEq(shapes.totalMinted(), 6);
    }

    function test_ReMintedInputIsFullyUsable() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        vm.prank(alice);
        shapes.decompose(survivor);

        // A re-minted input transfers like any token.
        vm.prank(alice);
        shapes.transferFrom(alice, bob, first + 2);
        assertEq(shapes.ownerOf(first + 2), bob, "re-minted input transfers");

        // ...and redeems for its exact backing.
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        shapes.redeem(first + 1);
        assertEq(alice.balance, balBefore + 0.01 ether, "re-minted input redeems normally");
        _assertSolvent();
    }

    function test_ComposeAfterDecomposeIsReversibleAgain() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        vm.prank(alice);
        shapes.decompose(survivor);
        assertEq(shapes.composeDepth(survivor), 0);

        // Compose again with the same re-minted inputs: a new record, decomposable again.
        uint256 survivor2 = _composeDust(first, 5);
        assertEq(survivor2, first);
        assertEq(shapes.composeDepth(survivor), 1, "new record after re-compose");
        vm.prank(alice);
        shapes.decompose(survivor);
        assertEq(shapes.backingOf(survivor), 0.01 ether, "reversible again");
        _assertSolvent();
    }

    /* ------------------------------ batch ------------------------------ */

    function test_DecomposeManyPopsStackedRecordsInOneTx() public {
        // Survivor with two stacked records (0.01 -> 0.05 -> 0.1).
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        uint256 secondFirst = _mintDust(5);
        uint256 second = _composeDust(secondFirst, 5);
        uint256[] memory burn = new uint256[](1);
        burn[0] = second;
        vm.prank(alice);
        shapes.compose(survivor, burn); // depth 2
        assertEq(shapes.composeDepth(survivor), 2);

        // Pop both records in one call by naming the survivor twice.
        uint256[] memory ids = new uint256[](2);
        ids[0] = survivor;
        ids[1] = survivor;
        vm.prank(alice);
        shapes.decomposeMany(ids);

        assertEq(shapes.composeDepth(survivor), 0, "both records popped");
        assertEq(shapes.backingOf(survivor), 0.01 ether, "fully unwound");
        assertEq(shapes.ownerOf(second), alice, "second re-minted");
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(first + 1 + i), alice, "original dust re-minted");
        }
        _assertSolvent();
    }

    function test_DecomposeManyUnwindsNestedTreeInOrder() public {
        // C swallows A; batch reverses C then A in one tx (parent before child).
        uint256 firstA = _mintDust(5);
        uint256 a = _composeDust(firstA, 5);
        uint256 firstC = _mintDust(5);
        uint256 c = _composeDust(firstC, 5);
        uint256[] memory burn = new uint256[](1);
        burn[0] = a;
        vm.prank(alice);
        shapes.compose(c, burn); // c depth 2, a burned

        uint256[] memory ids = new uint256[](2);
        ids[0] = c; // re-mints a
        ids[1] = a; // a now exists, unwind it
        vm.prank(alice);
        shapes.decomposeMany(ids);

        assertEq(shapes.backingOf(a), 0.01 ether, "A fully unwound");
        assertEq(shapes.backingOf(c), 0.05 ether, "C reverted one tier");
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(firstA + 1 + i), alice, "A's dust re-minted");
        }
        _assertSolvent();
    }

    function test_DecomposeManyRevertsWholeBatchOnBadItem() public {
        uint256 first = _mintDust(5);
        uint256 survivor = _composeDust(first, 5);
        uint256 plain = _mint(alice, 1 ether); // no record

        uint256[] memory ids = new uint256[](2);
        ids[0] = survivor;
        ids[1] = plain; // reverts NoComposeRecord -> whole batch reverts
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NoComposeRecord.selector, plain));
        shapes.decomposeMany(ids);

        // Atomic: the first item did not persist.
        assertEq(shapes.composeDepth(survivor), 1, "batch rolled back");
        assertEq(shapes.backingOf(survivor), 0.05 ether);
    }

    function test_ComposeManyBuildsUpLadderInOneTx() public {
        // Build 0.1 from ten dust via two ladder steps in a single batch:
        //   step 1: five dust -> 0.05 (survivor = firstA)
        //   step 2: firstA (0.05) + a second 0.05 -> 0.1
        uint256 firstA = _mintDust(5); // ids A..A+4
        uint256 firstB = _mintDust(5); // ids B..B+4
        // Pre-build the second 0.05 so its id is known for step 2's burn list.
        uint256 secondFive = _composeDust(firstB, 5); // = firstB, now 0.05

        IShapes.ComposeCall[] memory calls = new IShapes.ComposeCall[](2);
        uint256[] memory b1 = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            b1[i] = firstA + 1 + i;
        }
        calls[0] = IShapes.ComposeCall({survivorId: firstA, burnIds: b1});
        uint256[] memory b2 = new uint256[](1);
        b2[0] = secondFive;
        calls[1] = IShapes.ComposeCall({survivorId: firstA, burnIds: b2});

        vm.prank(alice);
        uint256[] memory outIds = shapes.composeMany(calls);

        assertEq(outIds[0], firstA);
        assertEq(outIds[1], firstA);
        assertEq(shapes.backingOf(firstA), 0.1 ether, "built to 0.1 in one tx");
        assertEq(shapes.composeDepth(firstA), 2, "two records, both reversible");

        // And the whole thing unwinds in one batch.
        uint256[] memory ids = new uint256[](2);
        ids[0] = firstA;
        ids[1] = firstA;
        vm.prank(alice);
        shapes.decomposeMany(ids);
        assertEq(shapes.backingOf(firstA), 0.01 ether, "round-trips fully");
        assertEq(shapes.ownerOf(secondFive), alice, "second 0.05 re-minted");
        _assertSolvent();
    }

    function test_BatchRevertsOnEmpty() public {
        uint256[] memory ids = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(IShapes.ZeroQuantity.selector);
        shapes.decomposeMany(ids);

        IShapes.ComposeCall[] memory calls = new IShapes.ComposeCall[](0);
        vm.prank(alice);
        vm.expectRevert(IShapes.ZeroQuantity.selector);
        shapes.composeMany(calls);
    }
}

/// @notice Every adjacent denomination transition, exercised in all four directions with exact
///         state assertions: compose up / decompose back, and split down. Covers
///         the 5/10/50/100 ETH tiers the hand-written suite otherwise leaves to invariant fuzzing.
contract LadderMatrixTest is ShapesBase {
    /// @dev compose `ratio` tokens of tier i into one tier i+1, then decompose it back to the exact
    ///      inputs. Asserts backing, origins, ids and seeds at every step, for i = 0..7.
    function test_ComposeThenDecomposeEveryTier() public {
        for (uint256 i = 0; i < 8; ++i) {
            uint256 lo = DENOMS[i];
            uint256 hi = DENOMS[i + 1];
            uint256 ratio = hi / lo; // 2 or 5

            // Mint `ratio` tier-i tokens; survivor is the first, `ratio - 1` are burned in.
            vm.prank(alice);
            uint256 first = shapes.mintBatch{value: ratio * (lo + feeOf(lo))}(lo, ratio);

            bytes32[] memory seeds = new bytes32[](ratio - 1);
            for (uint256 j = 0; j < ratio - 1; ++j) {
                seeds[j] = shapes.seedOf(first + 1 + j);
            }
            bytes32 survivorSeed = shapes.seedOf(first);

            uint256[] memory burn = new uint256[](ratio - 1);
            for (uint256 j = 0; j < ratio - 1; ++j) {
                burn[j] = first + 1 + j;
            }

            vm.prank(alice);
            uint256 survivor = shapes.compose(first, burn);
            assertEq(shapes.backingOf(survivor), hi, "composed up to tier i+1");
            assertEq(shapes.originCountOf(survivor), ratio, "origins summed");
            assertEq(shapes.composeDepth(survivor), 1, "one record");

            vm.prank(alice);
            uint256[] memory restored = shapes.decompose(survivor);

            assertEq(shapes.backingOf(survivor), lo, "survivor back to tier i");
            assertEq(shapes.originCountOf(survivor), 1, "survivor origins restored");
            assertEq(shapes.seedOf(survivor), survivorSeed, "survivor seed intact");
            assertEq(restored.length, ratio - 1);
            for (uint256 j = 0; j < ratio - 1; ++j) {
                assertEq(restored[j], first + 1 + j, "original id restored");
                assertEq(shapes.seedOf(first + 1 + j), seeds[j], "original seed restored");
                assertEq(shapes.backingOf(first + 1 + j), lo, "restored at tier i");
                assertEq(shapes.originCountOf(first + 1 + j), 1, "origin restored");
                assertEq(shapes.ownerOf(first + 1 + j), alice);
            }
            assertEq(shapes.composeDepth(survivor), 0, "record popped");
            _assertSolvent();
        }
    }

    /// @dev Split one tier-i token into `ratio` tier-(i-1) tokens, asserting backing and the
    ///      origin partition at every step, for i = 1..8.
    function test_SplitEveryTier() public {
        for (uint256 i = 1; i < 9; ++i) {
            uint256 hi = DENOMS[i];
            uint256 lo = DENOMS[i - 1];
            uint256 ratio = hi / lo;

            uint256 parent = _mint(alice, hi); // originCount 1
            uint8[] memory outs = new uint8[](ratio);
            for (uint256 j = 0; j < ratio; ++j) {
                outs[j] = uint8(i - 1);
            }

            vm.prank(alice);
            uint256[] memory kids = shapes.split(parent, outs);
            assertEq(kids.length, ratio, "split into ratio children");
            uint256 originSum;
            for (uint256 j = 0; j < ratio; ++j) {
                assertEq(shapes.backingOf(kids[j]), lo, "child at tier i-1");
                originSum += shapes.originCountOf(kids[j]);
            }
            assertEq(originSum, 1, "one parent origin partitioned across children");
            _assertSolvent();
        }
    }

    /// @dev The multi-tier jump the coordinator originally asked about: 100 x 0.01 composed into one
    ///      1 ETH token (a five-tier jump, index 0 -> 4) in a single compose, then decomposed back
    ///      to the exact 100 dust under their original ids and seeds.
    function test_MultiTierJumpComposeDecomposeRoundTrip() public {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 100 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 100);

        bytes32[] memory seeds = new bytes32[](99);
        for (uint256 j = 0; j < 99; ++j) {
            seeds[j] = shapes.seedOf(first + 1 + j);
        }

        uint256[] memory burn = new uint256[](99);
        for (uint256 j = 0; j < 99; ++j) {
            burn[j] = first + 1 + j;
        }

        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);
        assertEq(shapes.backingOf(survivor), 1 ether, "100 x 0.01 -> 1 ETH");
        assertEq(shapes.originCountOf(survivor), 100, "all 100 origins on the survivor");

        vm.prank(alice);
        uint256[] memory restored = shapes.decompose(survivor);

        assertEq(shapes.backingOf(survivor), 0.01 ether, "survivor back to dust");
        assertEq(restored.length, 99);
        for (uint256 j = 0; j < 99; ++j) {
            assertEq(restored[j], first + 1 + j, "original id restored");
            assertEq(shapes.seedOf(first + 1 + j), seeds[j], "original seed restored");
            assertEq(shapes.backingOf(first + 1 + j), 0.01 ether, "back to 0.01");
        }
        assertEq(shapes.totalSupply(), 100, "all 100 live again");
        assertEq(shapes.totalMinted(), 100, "no fresh ids issued");
        _assertSolvent();
    }
}

/// @notice `previewDecompose`: the stored record read back, which is the only correct source for
///         what a decompose will revive. Reconstructing it from event history is possible and easy
///         to get wrong, which is the bug this view exists to make unnecessary.
contract PreviewDecomposeTest is ShapesBase {
    function _dust(uint256 k) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: k * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, k);
    }

    function test_EmptyWhenNothingStands() public {
        uint256 id = _mint(alice, 1 ether);
        assertEq(shapes.previewDecompose(id).length, 0, "a state, not an error");
    }

    /// @notice The preview matches what decompose actually does, field for field.
    function test_MatchesTheRealDecompose() public {
        uint256 first = _dust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);

        ShapeRevivalPreview[] memory p = shapes.previewDecompose(first);
        assertEq(p.length, 4);

        vm.prank(alice);
        uint256[] memory revived = shapes.decompose(first);

        for (uint256 i = 0; i < 4; ++i) {
            assertEq(p[i].tokenId, revived[i], "id diverged");
            assertEq(p[i].seed, shapes.seedOf(revived[i]), "seed diverged");
            assertEq(p[i].denominationIndex, 0, "denomination diverged");
            assertEq(p[i].faceValueWei, shapes.backingOf(revived[i]), "face value diverged");
            assertEq(p[i].originCount, shapes.originCountOf(revived[i]), "origins diverged");
            assertEq(p[i].inkGene, shapes.inkGeneOf(revived[i]), "gene diverged");
        }
    }

    /// @notice The case the front end got wrong. An input composed up before being absorbed is
    ///         revived at the denomination it held when burned, not the one it was born at.
    function test_ReportsTheStateAtBurnNotAtBirth() public {
        uint256 first = _dust(10); // ids 0..9, each 0.01

        // #0 absorbs 1..4 and becomes 0.05.
        uint256[] memory inner = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            inner[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, inner);
        assertEq(shapes.backingOf(first), 0.05 ether);

        // #5 then absorbs the composed #0 plus 6..9, reaching 0.1.
        uint256[] memory outer = new uint256[](5);
        outer[0] = first;
        for (uint256 i = 0; i < 4; ++i) {
            outer[i + 1] = first + 6 + i;
        }
        vm.prank(alice);
        shapes.compose(first + 5, outer);

        ShapeRevivalPreview[] memory p = shapes.previewDecompose(first + 5);
        assertEq(p[0].tokenId, first, "#0 is the first input");
        assertEq(p[0].denominationIndex, 1, "reported birth denomination, not burn denomination");
        assertEq(p[0].faceValueWei, 0.05 ether, "#0 comes back at 0.05, not 0.01");

        vm.prank(alice);
        shapes.decompose(first + 5);
        assertEq(shapes.backingOf(first), 0.05 ether, "the chain agrees with the preview");
    }

    /// @notice Stacked composes preview newest first, matching the order decompose pops them.
    function test_PreviewsTheTopOfTheStack() public {
        uint256 first = _dust(10);
        uint256[] memory inner = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            inner[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, inner);

        uint256[] memory outer = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            outer[i] = first + 5 + i;
        }
        vm.prank(alice);
        shapes.compose(first, outer);

        ShapeRevivalPreview[] memory p = shapes.previewDecompose(first);
        assertEq(p.length, 5, "the newest record, not the oldest");
        assertEq(p[0].tokenId, first + 5);

        vm.prank(alice);
        shapes.decompose(first);
        assertEq(shapes.previewDecompose(first).length, 4, "now the inner record is on top");
    }
}

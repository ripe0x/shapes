// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ShapesBase} from "./Shapes.t.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {
    ComposeInputView,
    ComposeRecordView,
    ShapeChildPreview,
    ShapeFormation,
    ShapeState
} from "../src/ShapeTypes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {InkGenes} from "../src/lib/InkGenes.sol";
import {GeometrySampling} from "../src/lib/GeometrySampling.sol";
import {GrammarV1Modules} from "../src/lib/GrammarV1Modules.sol";
import {ModuleCodec} from "../src/lib/ModuleCodec.sol";

/// @notice Uneven splits, mixed-denomination composes and the interaction between them: the
///         existing suite exercises equal-outDenoms splits and same-denomination compose burn
///         sets exclusively. This covers the heterogeneous paths through the same mechanisms
///         (SAMPLING_SPEC.md sections 5 and 6, DECOMPOSE_SPEC.md).
contract HeterogeneousTest is ShapesBase {
    function _containsByte(bytes memory hay, bytes1 needle) internal pure returns (bool) {
        for (uint256 i = 0; i < hay.length; ++i) {
            if (hay[i] == needle) return true;
        }
        return false;
    }

    /// @dev Rebuilds a split's compose-record pool (SAMPLING_SPEC.md section 6, D3'): the
    ///      survivor's pre-compose effective modules first, then the inputs' effective modules
    ///      sorted ascending by id (the record stores them in calldata order).
    function _reconstructSplitRecordPool(bytes32 parentSeed, ComposeRecordView memory rec)
        internal
        pure
        returns (bytes memory)
    {
        uint256 n = rec.inputs.length;
        GeometrySampling.Donor[] memory inputDonors = new GeometrySampling.Donor[](n);
        for (uint256 i = 0; i < n; ++i) {
            ComposeInputView memory inp = rec.inputs[i];
            inputDonors[i] = GeometrySampling.Donor({
                id: inp.id,
                units: 0,
                seed: inp.seed,
                denomIndex: inp.denominationIndex,
                inkGene: inp.inkGene,
                modules: inp.modules
            });
        }
        inputDonors = GeometrySampling.sortDonorsById(inputDonors);
        return GeometrySampling.buildSplitRecordPool(
            rec.survivorModules, parentSeed, rec.survivorDenominationIndex, rec.survivorInkGene, inputDonors
        );
    }

    /* ==================================================================== *
     *  Uneven split
     * ==================================================================== */

    /// @notice An original (never-composed) parent split into non-equal output denominations:
    ///         the grammar branch (SAMPLING_SPEC.md section 6, D3'), each child sampling from the
    ///         parent seed's grammar v1 expression at its OWN denomination.
    function test_SplitUnevenOriginalParent() public {
        uint256 parent = _mint(alice, DENOMS[4]); // 1 ETH, originCount 1, no compose record
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8 parentGene = shapes.inkGeneOf(parent);
        assertEq(shapes.composeDepth(parent), 0, "direct mint carries no compose record");

        uint8[] memory outs = new uint8[](6);
        outs[0] = 3; // 0.5 ETH
        outs[1] = 2; // 0.1 ETH
        outs[2] = 2;
        outs[3] = 2;
        outs[4] = 2;
        outs[5] = 2;
        // sum: 0.5 + 5 x 0.1 = 1 ETH

        ShapeChildPreview[] memory preview = lens.previewSplit(parent, outs);

        uint256 reserveBefore = shapes.redeemableBacking();
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        assertEq(kids.length, 6, "six children");
        uint32[6] memory expectedGive = [uint32(1), 0, 0, 0, 0, 0];
        for (uint256 i = 0; i < 6; ++i) {
            uint8 childDenom = outs[i];
            assertEq(shapes.backingOf(kids[i]), DENOMS[childDenom], "child backing");
            assertEq(shapes.originCountOf(kids[i]), expectedGive[i], "origin allocation");
            assertEq(shapes.seedOf(kids[i]), shapes.childSeed(parentSeed, i), "child seed derivation");
            assertEq(shapes.inkGeneOf(kids[i]), parentGene, "ink gene copied verbatim");

            (uint256 cols, uint256 rows) = lens.gridForAmount(DENOMS[childDenom]);
            bytes memory modules = shapes.modulesOf(kids[i]);
            assertEq(modules.length, cols * rows, "materialized length matches child's own grid");

            bytes memory pool = GrammarV1Modules.all(parentSeed, childDenom, parentGene);
            for (uint256 j = 0; j < modules.length; ++j) {
                assertTrue(ModuleCodec.isValid(modules[j]), "invalid module byte");
                assertTrue(
                    _containsByte(pool, modules[j]), "module byte outside the child-denom grammar pool"
                );
            }

            ShapeState memory st = lens.shapeState(kids[i]);
            assertEq(preview[i].seed, st.seed, "preview seed matches executed child");
            assertEq(preview[i].denominationIndex, st.denominationIndex, "preview denomination matches");
            assertEq(preview[i].originCount, st.originCount, "preview origin count matches");
            assertEq(preview[i].inkGene, st.inkGene, "preview ink gene matches");
            assertEq(preview[i].faceValueWei, st.faceValueWei, "preview face value matches");
            assertEq(preview[i].modules, modules, "preview modules match stored child modules");
        }

        assertEq(shapes.redeemableBacking(), reserveBefore, "split moves no ETH");
        assertEq(shapes.totalSupply(), 6, "parent burned, six children live");
        assertFalse(lens.exists(parent), "parent burned");
        _assertSolvent();
    }

    /// @notice A materialized parent (a compose survivor with originCount 10) split unevenly: the
    ///         record branch. The per-child origin allocation fills each output's capacity in
    ///         listed order regardless of denomination, and every child draws from the same
    ///         compose-record donor pool, reconstructed independently here and compared byte for
    ///         byte against the stored geometry.
    function test_SplitUnevenOriginAllocationFillsCapsInOrder() public {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 10 * (DENOMS[2] + feeOf(DENOMS[2]))}(DENOMS[2], 10);
        uint256[] memory burn = new uint256[](9);
        for (uint256 i = 0; i < 9; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 parent = shapes.compose(first, burn);
        assertEq(shapes.backingOf(parent), DENOMS[4], "1 ETH");
        assertEq(shapes.originCountOf(parent), 10, "ten origins");
        uint256 depth = shapes.composeDepth(parent);
        assertGt(depth, 0, "compose record present: record branch");

        bytes32 parentSeed = shapes.seedOf(parent);
        ComposeRecordView memory rec = lens.composeRecordAt(parent, depth - 1);
        bytes memory pool = _reconstructSplitRecordPool(parentSeed, rec);

        uint8[] memory outs = new uint8[](11);
        outs[0] = 0;
        outs[1] = 0;
        outs[2] = 0;
        outs[3] = 0;
        outs[4] = 0; // 5 x 0.01 = 0.05
        outs[5] = 1; // 0.05
        outs[6] = 2;
        outs[7] = 2;
        outs[8] = 2;
        outs[9] = 2; // 4 x 0.1 = 0.4
        outs[10] = 3; // 0.5
        // sum: 0.05 + 0.05 + 0.4 + 0.5 = 1.0 ETH

        ShapeChildPreview[] memory preview = lens.previewSplit(parent, outs);

        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        // Caps by output denomination: [1,1,1,1,1,5,10,10,10,10,50]. Ten origins fill the first
        // six caps exactly and leave nothing for the rest.
        uint32[11] memory expectedGive = [uint32(1), 1, 1, 1, 1, 5, 0, 0, 0, 0, 0];
        uint256 originSum;
        for (uint256 i = 0; i < 11; ++i) {
            assertEq(shapes.originCountOf(kids[i]), expectedGive[i], "origin give at index");
            originSum += shapes.originCountOf(kids[i]);

            assertEq(preview[i].originCount, expectedGive[i], "preview origin allocation matches");
            assertEq(preview[i].seed, shapes.seedOf(kids[i]), "preview seed matches");
            assertEq(preview[i].denominationIndex, outs[i], "preview denomination matches");
            assertEq(preview[i].inkGene, shapes.inkGeneOf(kids[i]), "preview gene matches");
            assertEq(preview[i].faceValueWei, shapes.backingOf(kids[i]), "preview face value matches");

            bytes memory modules = shapes.modulesOf(kids[i]);
            bytes memory expected = GeometrySampling.sampleSplitChild(pool, parentSeed, outs[i], i);
            assertEq(modules, expected, "record-branch child must match the compose record's donor pool");
            assertEq(preview[i].modules, modules, "preview modules match stored child modules");
        }
        assertEq(originSum, 10, "all ten origins partitioned");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, parent));
        shapes.decompose(parent);
        _assertSolvent();
    }

    /// @notice The origin fill is positional, not grouped by denomination: naming the larger
    ///         output last still puts every origin on the first-listed child.
    function test_SplitUnevenReverseOrderPutsOriginOnFirstChild() public {
        uint256 parent = _mint(alice, DENOMS[4]); // 1 ETH, originCount 1

        uint8[] memory outs = new uint8[](6);
        outs[0] = 2;
        outs[1] = 2;
        outs[2] = 2;
        outs[3] = 2;
        outs[4] = 2;
        outs[5] = 3;
        // sum: 5 x 0.1 + 0.5 = 1 ETH

        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        uint32[6] memory expectedGive = [uint32(1), 0, 0, 0, 0, 0];
        for (uint256 i = 0; i < 6; ++i) {
            assertEq(shapes.originCountOf(kids[i]), expectedGive[i], "origin fill is positional");
            assertEq(shapes.backingOf(kids[i]), DENOMS[outs[i]], "child backing");
        }
        _assertSolvent();
    }

    /// @notice `previewSplit`'s module bytes on the two branches `test_SplitUnevenOriginalParent`
    ///         and `test_SplitUnevenOriginAllocationFillsCapsInOrder` do not cover: a materialized
    ///         but recordless parent (a split child split again, grammar branch at each child's
    ///         own denomination, ignoring the parent's stored bytes), and a parent with a stacked
    ///         compose record (depth 2, record branch off the TOP record only).
    function test_PreviewSplitMatchesGrammarBranchOnRecordlessParentAndRecordBranchOnStackedRecord() public {
        // -------- (a) materialized, recordless parent: grammar branch --------
        uint256 grandparent = _mint(alice, DENOMS[2]); // 0.1 ETH
        uint8[] memory firstOuts = new uint8[](2);
        firstOuts[0] = 1; // 0.05
        firstOuts[1] = 1;
        vm.prank(alice);
        uint256[] memory firstKids = shapes.split(grandparent, firstOuts);
        uint256 recordlessParent = firstKids[0]; // materialized split child, no compose record
        assertGt(shapes.modulesOf(recordlessParent).length, 0, "split child is materialized");
        assertEq(shapes.composeDepth(recordlessParent), 0, "split child never composed");

        uint8[] memory outsA = new uint8[](5); // 5 x 0.01 ETH
        ShapeChildPreview[] memory previewA = lens.previewSplit(recordlessParent, outsA);

        vm.prank(alice);
        uint256[] memory kidsA = shapes.split(recordlessParent, outsA);

        for (uint256 i = 0; i < kidsA.length; ++i) {
            assertEq(
                previewA[i].modules,
                shapes.modulesOf(kidsA[i]),
                "grammar-branch preview must match stored child modules"
            );
        }

        // -------- (b) parent with a stacked compose record (depth 2): TOP record only --------
        uint256 first = _mint(alice, DENOMS[0]); // 0.01 ETH
        uint256[] memory burnsRound1 = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnsRound1[i] = _mint(alice, DENOMS[0]);
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burnsRound1); // 0.05 ETH, depth 1

        uint256[] memory burnsRound2 = new uint256[](1);
        burnsRound2[0] = _mint(alice, DENOMS[1]); // 0.05 ETH
        vm.prank(alice);
        shapes.compose(survivor, burnsRound2); // 0.1 ETH, depth 2 (stacked on the same survivor)
        assertEq(shapes.composeDepth(survivor), 2, "two stacked compose records");

        uint8[] memory outsB = new uint8[](2);
        outsB[0] = 1; // 0.05
        outsB[1] = 1;

        ShapeChildPreview[] memory previewB = lens.previewSplit(survivor, outsB);

        vm.prank(alice);
        uint256[] memory kidsB = shapes.split(survivor, outsB);

        for (uint256 i = 0; i < kidsB.length; ++i) {
            assertEq(
                previewB[i].modules,
                shapes.modulesOf(kidsB[i]),
                "record-branch preview must match stored child modules, drawn from the top record"
            );
        }
        _assertSolvent();
    }

    /* ==================================================================== *
     *  Mixed-denomination compose
     * ==================================================================== */

    /// @notice A 0.5 ETH survivor composed with five 0.1 ETH burns (a heterogeneous burn set, and
    ///         a burn side with a denomination different from the survivor's). Checks the sampled
    ///         geometry against the union of every donor's effective modules, checks
    ///         `previewCompose` against the executed result, checks the ink gene against an
    ///         independent recomputation of the pool statistic and the compose walk, and round-
    ///         trips through `decompose`.
    function test_ComposeMixedDenominations_HalfPlusFiveTenths() public {
        uint256 survivor = _mint(alice, DENOMS[3]); // 0.5 ETH, originCount 1
        uint256[] memory burns = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            burns[i] = _mint(alice, DENOMS[2]); // 0.1 ETH, originCount 1
        }

        bytes32 survivorSeed = shapes.seedOf(survivor);
        uint8 survivorGene = shapes.inkGeneOf(survivor);
        bytes memory survivorMods = GrammarV1Modules.all(survivorSeed, 3, survivorGene);

        uint256 burnSeedFold;
        uint256 sumW = uint256(survivorGene) * Denominations.unitsAt(3);
        uint256 unitsTotal = Denominations.unitsAt(3);
        uint8 best = survivorGene;
        uint8 worst = survivorGene;
        bytes[] memory burnMods = new bytes[](5);
        for (uint256 i = 0; i < 5; ++i) {
            bytes32 s = shapes.seedOf(burns[i]);
            uint8 g = shapes.inkGeneOf(burns[i]);
            burnMods[i] = GrammarV1Modules.all(s, 2, g);
            burnSeedFold ^= uint256(s);
            uint256 units = Denominations.unitsAt(2);
            sumW += uint256(g) * units;
            unitsTotal += units;
            if (g > best) best = g;
            if (g < worst) worst = g;
        }

        ShapeState memory preview = lens.previewCompose(survivor, burns);

        vm.prank(alice);
        shapes.compose(survivor, burns);

        assertEq(shapes.backingOf(survivor), DENOMS[4], "0.5 + 5 x 0.1 = 1 ETH");
        assertEq(shapes.originCountOf(survivor), 6, "six origins summed");
        assertEq(uint8(shapes.formationOf(survivor)), uint8(ShapeFormation.Composed), "Composed formation");
        assertEq(shapes.composeDepth(survivor), 1, "one compose record");

        bytes memory modules = shapes.modulesOf(survivor);
        (uint256 cols, uint256 rows) = lens.gridForAmount(DENOMS[4]);
        assertEq(modules.length, cols * rows, "9 modules at 1 ETH");
        for (uint256 i = 0; i < modules.length; ++i) {
            assertTrue(ModuleCodec.isValid(modules[i]), "invalid module byte");
            bool found = _containsByte(survivorMods, modules[i]);
            for (uint256 d = 0; d < 5 && !found; ++d) {
                found = _containsByte(burnMods[d], modules[i]);
            }
            assertTrue(found, "sampled byte outside the donor union");
        }

        assertEq(modules, preview.modules, "preview modules match executed");
        assertEq(shapes.inkGeneOf(survivor), preview.inkGene, "preview gene matches executed");
        assertEq(shapes.originCountOf(survivor), preview.originCount, "preview origin count matches executed");
        assertEq(
            shapes.denomIndexOf(survivor), preview.denominationIndex, "preview denomination matches executed"
        );

        uint8 centerGene = InkGenes.center(sumW, unitsTotal);
        uint8 expectedGene =
            InkGenes.geneAtCompose(survivorSeed, burnSeedFold, survivorGene, 3, 4, best, worst, centerGene);
        assertEq(shapes.inkGeneOf(survivor), expectedGene, "gene matches independent recomputation");

        vm.prank(alice);
        uint256[] memory restored = shapes.decompose(survivor);
        assertEq(shapes.backingOf(survivor), DENOMS[3], "survivor back to 0.5");
        assertEq(shapes.originCountOf(survivor), 1, "survivor origin restored");
        assertEq(shapes.modulesOf(survivor).length, 0, "survivor unmaterialized again");
        assertEq(restored.length, 5);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(restored[i], burns[i], "original id restored");
            assertEq(shapes.backingOf(burns[i]), DENOMS[2], "restored at 0.1");
            assertEq(shapes.originCountOf(burns[i]), 1, "restored origin");
            assertEq(shapes.ownerOf(burns[i]), alice);
        }
        assertEq(shapes.totalSupply(), 6, "all six live again");
        _assertSolvent();
    }

    /// @notice The compose result is independent of the burn set's calldata order, exercised on a
    ///         mixed-denomination burn set instead of the homogeneous ones the rest of the suite
    ///         uses.
    function test_ComposeMixedDenominations_BurnOrderInvariant() public {
        uint256 survivor = _mint(alice, DENOMS[3]);
        uint256[] memory burns = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            burns[i] = _mint(alice, DENOMS[2]);
        }

        uint256 snapshot = vm.snapshotState();

        vm.prank(alice);
        shapes.compose(survivor, burns);
        bytes memory modulesAscending = shapes.modulesOf(survivor);
        uint8 geneAscending = shapes.inkGeneOf(survivor);

        vm.revertToState(snapshot);

        uint256[] memory reversed = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            reversed[i] = burns[4 - i];
        }
        vm.prank(alice);
        shapes.compose(survivor, reversed);
        bytes memory modulesReversed = shapes.modulesOf(survivor);
        uint8 geneReversed = shapes.inkGeneOf(survivor);

        assertEq(modulesAscending, modulesReversed, "burn order changed the sampled modules");
        assertEq(geneAscending, geneReversed, "burn order changed the ink gene");
    }

    /// @notice A two-rung jump (0.01 -> 0.1) with an uneven donor split: one 0.05 burn (5 units)
    ///         and four 0.01 burns (1 unit each), composed onto a 0.01 survivor.
    function test_ComposeMixedTiersDustAndNickelJumpsTwoRungs() public {
        uint256 survivor = _mint(alice, DENOMS[0]); // 0.01 dust
        uint256 nickel = _mint(alice, DENOMS[1]); // 0.05
        uint256[] memory dust = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            dust[i] = _mint(alice, DENOMS[0]);
        }
        uint256[] memory burns = new uint256[](5);
        burns[0] = nickel;
        for (uint256 i = 0; i < 4; ++i) {
            burns[1 + i] = dust[i];
        }

        bytes32 survivorSeed = shapes.seedOf(survivor);
        uint8 survivorGene = shapes.inkGeneOf(survivor);
        bytes memory survivorMods = GrammarV1Modules.all(survivorSeed, 0, survivorGene);

        uint8[5] memory burnDenom = [uint8(1), 0, 0, 0, 0];
        uint256 burnSeedFold;
        uint256 sumW = uint256(survivorGene) * Denominations.unitsAt(0);
        uint256 unitsTotal = Denominations.unitsAt(0);
        uint8 best = survivorGene;
        uint8 worst = survivorGene;
        bytes[] memory burnMods = new bytes[](5);
        for (uint256 i = 0; i < 5; ++i) {
            bytes32 s = shapes.seedOf(burns[i]);
            uint8 g = shapes.inkGeneOf(burns[i]);
            burnMods[i] = GrammarV1Modules.all(s, burnDenom[i], g);
            burnSeedFold ^= uint256(s);
            uint256 units = Denominations.unitsAt(burnDenom[i]);
            sumW += uint256(g) * units;
            unitsTotal += units;
            if (g > best) best = g;
            if (g < worst) worst = g;
        }

        ShapeState memory preview = lens.previewCompose(survivor, burns);

        vm.prank(alice);
        shapes.compose(survivor, burns);

        assertEq(shapes.backingOf(survivor), DENOMS[2], "0.01 + 0.05 + 4 x 0.01 = 0.1");
        assertEq(shapes.originCountOf(survivor), 6, "six origins summed");
        assertEq(shapes.composeDepth(survivor), 1);

        bytes memory modules = shapes.modulesOf(survivor);
        (uint256 cols, uint256 rows) = lens.gridForAmount(DENOMS[2]);
        assertEq(modules.length, cols * rows, "16 modules at 0.1 ETH");
        for (uint256 i = 0; i < modules.length; ++i) {
            assertTrue(ModuleCodec.isValid(modules[i]), "invalid module byte");
            bool found = _containsByte(survivorMods, modules[i]);
            for (uint256 d = 0; d < 5 && !found; ++d) {
                found = _containsByte(burnMods[d], modules[i]);
            }
            assertTrue(found, "sampled byte outside the donor union");
        }

        assertEq(modules, preview.modules, "preview modules match executed");
        assertEq(shapes.inkGeneOf(survivor), preview.inkGene, "preview gene matches executed");
        assertEq(shapes.originCountOf(survivor), preview.originCount, "preview origin count matches executed");
        assertEq(
            shapes.denomIndexOf(survivor), preview.denominationIndex, "preview denomination matches executed"
        );

        uint8 centerGene = InkGenes.center(sumW, unitsTotal);
        uint8 expectedGene =
            InkGenes.geneAtCompose(survivorSeed, burnSeedFold, survivorGene, 0, 2, best, worst, centerGene);
        assertEq(shapes.inkGeneOf(survivor), expectedGene, "gene matches independent recomputation");

        vm.prank(alice);
        uint256[] memory restored = shapes.decompose(survivor);
        assertEq(shapes.backingOf(survivor), DENOMS[0], "survivor back to dust");
        assertEq(restored.length, 5);
        assertEq(restored[0], nickel, "the 0.05 input restored under its original id");
        assertEq(shapes.backingOf(nickel), DENOMS[1], "restored at 0.05");
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(restored[1 + i], dust[i], "dust input restored under its original id");
            assertEq(shapes.backingOf(dust[i]), DENOMS[0], "restored at 0.01");
        }
        assertEq(shapes.totalSupply(), 6, "all six live again");
        _assertSolvent();
    }

    /// @notice A mixed-denomination compose followed by an uneven split of the survivor: the
    ///         survivor is burned by the split, so its compose record is left inert (not popped)
    ///         and `decompose` on the burned id reverts on nonexistence rather than replaying the
    ///         reversal. Every child's split-origin metadata names the survivor as its parent.
    function test_ComposeMixedThenSplitUnevenThenDecomposeIsBlockedOnlyForBurnedParent() public {
        uint256 survivor = _mint(alice, DENOMS[3]);
        uint256[] memory burns = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            burns[i] = _mint(alice, DENOMS[2]);
        }
        vm.prank(alice);
        shapes.compose(survivor, burns); // -> 1 ETH, composeDepth 1

        uint8[] memory outs = new uint8[](6);
        outs[0] = 3;
        outs[1] = 2;
        outs[2] = 2;
        outs[3] = 2;
        outs[4] = 2;
        outs[5] = 2;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(survivor, outs);

        assertFalse(lens.exists(survivor), "the split burns the survivor");
        assertEq(shapes.composeDepth(survivor), 1, "the compose record is left inert, not popped");
        for (uint256 i = 0; i < kids.length; ++i) {
            assertEq(shapes.ownerOf(kids[i]), alice, "child live");
        }

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, survivor));
        shapes.decompose(survivor);

        for (uint256 i = 0; i < kids.length; ++i) {
            (, uint256 parentId, uint8 parentDenomIndex, uint8 originDenomIndex,,, uint256 childIndex) =
                lens.splitOriginOf(kids[i]);
            assertEq(parentId, survivor, "split origin parent id");
            assertEq(parentDenomIndex, 4, "split origin parent denomination");
            assertEq(originDenomIndex, 4, "root split origin denomination");
            assertEq(childIndex, i, "child index");
        }
        _assertSolvent();
    }
}

/* ==================================================================== *
 *  Black Shape negative paths
 * ==================================================================== */

/// @notice Additional Black-token rejection paths beyond `test_PreviewsRejectBlackToMatchExecution`
///         in Shapes.t.sol: a Black compose burn input against solvency/supply invariants, a
///         Black inside `redeemBatch`, and `decompose`/`decomposeMany` of a Black survivor whose
///         compose record predates the sacrifice, including after the token is transferred and
///         then burned for zero.
contract BlackPathsTest is ShapesBase {
    /// @dev A genuine apex Complete: 10,000 direct 0.01 mints composed into one 100 ETH token
    ///      carrying 10,000 origins, then sacrificed. Mirrors `BlackShapeTest._buildApexComplete`
    ///      in Shapes.t.sol.
    function _buildApexComplete() internal returns (uint256 id) {
        vm.prank(alice);
        uint256 first =
            shapes.mintBatchTo{value: 10_000 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 10_000, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        id = shapes.compose(first, burn);
    }

    /// @notice `test_PreviewsRejectBlackToMatchExecution` (Shapes.t.sol) already proves a Black
    ///         burn input reverts on both `compose` and `previewCompose`. This adds what that test
    ///         does not: the rejected attempt leaves reserve, supply and ownership untouched.
    function test_BlackIsRejectedAsAComposeBurnInput() public {
        uint256 black = _buildApexComplete();
        vm.prank(alice);
        shapes.sacrifice(black);

        uint256 survivor = _mint(alice, DENOMS[0]);
        uint256[] memory burn = new uint256[](1);
        burn[0] = black;

        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        shapes.compose(survivor, burn);

        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        lens.previewCompose(survivor, burn);

        assertEq(shapes.redeemableBacking(), reserveBefore, "rejected compose moves no backing");
        assertEq(shapes.totalSupply(), supplyBefore, "rejected compose changes no supply");
        assertEq(shapes.ownerOf(black), alice, "Black stays put");
        assertEq(shapes.ownerOf(survivor), alice, "survivor stays put");
    }

    /// @notice A Black id anywhere in a `redeemBatch` call reverts the whole batch, leaving every
    ///         token in the call, live or Black, exactly as it was.
    function test_RedeemBatchContainingABlackReverts() public {
        uint256 black = _buildApexComplete();
        vm.prank(alice);
        shapes.sacrifice(black);

        uint256 live = _mint(alice, DENOMS[4]);

        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();

        uint256[] memory mixed = new uint256[](2);
        mixed[0] = live;
        mixed[1] = black;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        shapes.redeemBatch(mixed);

        uint256[] memory onlyBlack = new uint256[](1);
        onlyBlack[0] = black;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        shapes.redeemBatch(onlyBlack);

        assertEq(shapes.redeemableBacking(), reserveBefore, "reserve unchanged");
        assertEq(shapes.totalSupply(), supplyBefore, "supply unchanged");
        assertEq(shapes.ownerOf(live), alice, "live token unredeemed");
        assertEq(shapes.ownerOf(black), alice, "Black unredeemed");
    }

    /// @notice `decompose` and `decomposeMany` both refuse a Black survivor even though its
    ///         compose record (built before the sacrifice) is still there, on either owner across
    ///         a transfer. The record survives the Black token's own zero-value `burn`, but the
    ///         burned id can no longer be decomposed at all.
    function test_DecomposeOfABlackSurvivorIsRefusedAndRecordStaysInert() public {
        uint256 black = _buildApexComplete();
        vm.prank(alice);
        shapes.sacrifice(black);
        assertEq(shapes.composeDepth(black), 1, "apex build left one compose record");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        shapes.decompose(black);

        uint256[] memory ids = new uint256[](1);
        ids[0] = black;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        shapes.decomposeMany(ids);

        assertEq(shapes.composeDepth(black), 1, "record untouched by the rejected decomposes");

        vm.prank(alice);
        shapes.transferFrom(alice, bob, black);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, black));
        shapes.decompose(black);

        uint256 blackShapeCountBefore = shapes.blackShapeCount();
        uint256 sacrificedBefore = shapes.burnedBacking();

        vm.prank(bob);
        shapes.burn(black); // zero-value burn, allowed for Black

        assertEq(shapes.composeDepth(black), 1, "the record count survives the id's own burn");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, black));
        shapes.decompose(black);

        assertEq(
            shapes.blackShapeCount(), blackShapeCountBefore - 1, "burning a Black Shape lowers the live count"
        );
        assertEq(shapes.burnedBacking(), sacrificedBefore, "burnedBacking unaffected by the burn");
        _assertSolvent();
    }
}

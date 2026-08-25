// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";

import {ShapesBase} from "./Shapes.t.sol";
import {ComposeInputView, ComposeRecordView} from "../src/interfaces/IShapeCapabilities.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {GeometrySampling} from "../src/lib/GeometrySampling.sol";
import {GrammarV1Modules} from "../src/lib/GrammarV1Modules.sol";

/// @notice SAMPLING_SPEC.md "Provenance views": `composeRecordAt` and `splitOriginOf` expose the
///         storage a caller needs to re-run the compose and split sampling procedures off-chain
///         and reproduce a live token's materialized modules from its donors, without an indexer.
contract ProvenanceTest is ShapesBase {
    /// @dev Mint `k` 0.01 dust to alice; ids are `first .. first + k - 1`.
    function _mintDust(uint256 k) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: k * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], k);
    }

    /* ==================================================================== *
     *  composeRecordAt
     * ==================================================================== */

    function test_ComposeRecordAtReturnsSurvivorAndInputSnapshots() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        // Snapshot everything before compose burns the inputs.
        bytes32 survivorSeedBefore = shapes.seedOf(first);
        uint8 survivorGeneBefore = shapes.inkGeneOf(first);
        bytes32[4] memory inputSeeds;
        uint8[4] memory inputGenes;
        for (uint256 i = 0; i < 4; ++i) {
            inputSeeds[i] = shapes.seedOf(burn[i]);
            inputGenes[i] = shapes.inkGeneOf(burn[i]);
        }

        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);

        ComposeRecordView memory rec = lens.composeRecordAt(survivor, 0);
        assertEq(rec.survivorDenominationIndex, 0, "pre-compose denom was 0.01 ETH");
        assertEq(rec.survivorOriginCount, 1, "pre-compose origin count");
        assertEq(rec.survivorInkGene, survivorGeneBefore, "pre-compose gene");
        assertEq(rec.survivorModules.length, 0, "survivor was unmaterialized before this compose");
        assertEq(rec.inputs.length, 4, "one entry per burned input");

        for (uint256 i = 0; i < 4; ++i) {
            ComposeInputView memory inp = rec.inputs[i];
            assertEq(inp.id, burn[i], "input id, calldata order");
            assertEq(inp.seed, inputSeeds[i], "input seed");
            assertEq(inp.denominationIndex, 0, "input denom");
            assertEq(inp.originCount, 1, "input origin count");
            assertEq(inp.inkGene, inputGenes[i], "input gene");
            assertEq(inp.modules.length, 0, "input was unmaterialized");
        }

        assertEq(shapes.seedOf(survivor), survivorSeedBefore, "compose never touches the seed");
    }

    function test_ComposeRecordAtStackedDepthsOldestFirst() public {
        uint256 firstA = _mintDust(5);
        uint256[] memory burnA = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnA[i] = firstA + 1 + i;
        }
        vm.prank(alice);
        uint256 a = shapes.compose(firstA, burnA); // depth 1, inner record

        uint256 firstB = _mintDust(5);
        uint256[] memory burnB = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnB[i] = firstB + 1 + i;
        }
        vm.prank(alice);
        uint256 b = shapes.compose(firstB, burnB);

        uint256[] memory burnOuter = new uint256[](1);
        burnOuter[0] = b;
        vm.prank(alice);
        shapes.compose(a, burnOuter); // depth 2, outer record

        assertEq(shapes.composeDepth(a), 2);

        ComposeRecordView memory inner = lens.composeRecordAt(a, 0);
        assertEq(inner.survivorDenominationIndex, 0, "depth 0 is the oldest (0.01 -> 0.05) record");
        assertEq(inner.inputs.length, 4);

        ComposeRecordView memory outer = lens.composeRecordAt(a, 1);
        assertEq(outer.survivorDenominationIndex, 1, "depth 1 is the newest (0.05 -> 0.1) record");
        assertEq(outer.inputs.length, 1);
        assertEq(outer.inputs[0].id, b);
    }

    function test_ComposeRecordAtRevertsOutOfRange() public {
        uint256 first = _mintDust(5);

        // No compose yet: even depth 0 is out of range.
        vm.expectRevert(abi.encodeWithSelector(IShapes.ComposeRecordOutOfRange.selector, first, 0, 0));
        lens.composeRecordAt(first, 0);

        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);

        // Depth 0 now exists; depth 1 (== depthAvailable) does not.
        lens.composeRecordAt(survivor, 0);
        vm.expectRevert(abi.encodeWithSelector(IShapes.ComposeRecordOutOfRange.selector, survivor, 1, 1));
        lens.composeRecordAt(survivor, 1);
    }

    function test_ComposeRecordAtShrinksAfterDecompose() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);
        assertEq(shapes.composeDepth(survivor), 1);
        lens.composeRecordAt(survivor, 0); // does not revert

        vm.prank(alice);
        shapes.decompose(survivor);
        assertEq(shapes.composeDepth(survivor), 0, "record popped");

        vm.expectRevert(abi.encodeWithSelector(IShapes.ComposeRecordOutOfRange.selector, survivor, 0, 0));
        lens.composeRecordAt(survivor, 0);
    }

    /// @notice Reconstruction round-trip (SAMPLING_SPEC.md "Provenance views"): rebuild the donor
    ///         array from `composeRecordAt` alone (survivor pre-state first, inputs sorted
    ///         ascending by id since they are stored in calldata order), recompute `burnSeedFold`
    ///         from the recorded input seeds, and re-run `GeometrySampling.sampleCompose`. The
    ///         result must equal the survivor's live materialized bytes, proving the view carries
    ///         everything an off-chain reconstruction needs.
    function test_ComposeRecordAtReconstructionMatchesLiveModules() public {
        uint256 first = _mintDust(5);
        // Calldata order deliberately not ascending, so the round-trip must sort the inputs
        // exactly as `_compose` does before sampling.
        uint256[] memory shuffled = new uint256[](4);
        shuffled[0] = first + 3;
        shuffled[1] = first + 1;
        shuffled[2] = first + 4;
        shuffled[3] = first + 2;

        vm.prank(alice);
        uint256 survivor = shapes.compose(first, shuffled);

        ComposeRecordView memory rec = lens.composeRecordAt(survivor, 0);
        bytes memory reconstructed = _reconstructCompose(survivor, rec);

        assertEq(reconstructed, lens.shapeState(survivor).modules, "reconstruction != live modules");
    }

    /// @notice Same round-trip one tier up: the survivor's own snapshot inside the record is
    ///         itself a materialized array (a prior compose), exercising the branch where donor 0
    ///         does not fall back to grammar v1.
    function test_ComposeRecordAtReconstructionMatchesLiveModules_MaterializedSurvivorDonor() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn); // materialized 0.05

        uint256 extra = _mint(alice, DENOMS[1]);
        uint256[] memory burnOuter = new uint256[](1);
        burnOuter[0] = extra;
        vm.prank(alice);
        shapes.compose(survivor, burnOuter); // 0.1, depth 2; donor 0 is now materialized

        ComposeRecordView memory rec = lens.composeRecordAt(survivor, 1);
        assertGt(rec.survivorModules.length, 0, "outer record's survivor snapshot is materialized");
        bytes memory reconstructed = _reconstructCompose(survivor, rec);

        assertEq(reconstructed, lens.shapeState(survivor).modules, "reconstruction != live modules");
    }

    /// @dev Rebuilds the donor array from a `ComposeRecordView` plus the survivor's own live seed
    ///      (unchanged by compose) and current denomination index, then re-runs `sampleCompose`.
    function _reconstructCompose(uint256 survivorId, ComposeRecordView memory rec)
        internal
        view
        returns (bytes memory)
    {
        bytes32 survivorSeed = shapes.seedOf(survivorId); // seed never changes across compose
        uint8 newIndex = lens.shapeState(survivorId).denominationIndex; // survivor's current denom

        uint256 n = rec.inputs.length;
        GeometrySampling.Donor[] memory burnDonors = new GeometrySampling.Donor[](n);
        uint256 burnSeedFold;
        for (uint256 i = 0; i < n; ++i) {
            ComposeInputView memory inp = rec.inputs[i];
            burnSeedFold ^= uint256(inp.seed);
            burnDonors[i] = GeometrySampling.Donor({
                id: inp.id,
                units: Denominations.unitsAt(inp.denominationIndex),
                seed: inp.seed,
                denomIndex: inp.denominationIndex,
                inkGene: inp.inkGene,
                modules: inp.modules
            });
        }
        burnDonors = GeometrySampling.sortDonorsById(burnDonors);

        GeometrySampling.Donor[] memory donors = new GeometrySampling.Donor[](n + 1);
        donors[0] = GeometrySampling.Donor({
            id: survivorId,
            units: Denominations.unitsAt(rec.survivorDenominationIndex),
            seed: survivorSeed,
            denomIndex: rec.survivorDenominationIndex,
            inkGene: rec.survivorInkGene,
            modules: rec.survivorModules
        });
        for (uint256 i = 0; i < n; ++i) {
            donors[i + 1] = burnDonors[i];
        }

        return GeometrySampling.sampleCompose(donors, survivorSeed, burnSeedFold, newIndex);
    }

    /* ==================================================================== *
     *  splitOriginOf
     * ==================================================================== */

    function test_SplitOriginOfChildrenOfOriginalParent() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8 parentGene = shapes.inkGeneOf(parent);
        bytes memory expectedParentModules = GrammarV1Modules.all(parentSeed, 2, parentGene);

        uint8[] memory outs = new uint8[](2);
        outs[0] = 1; // 0.05
        outs[1] = 1;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        for (uint256 i = 0; i < 2; ++i) {
            (bytes32 pSeed, uint8 pDenom, uint8 pGene, bytes memory pMods, uint256 childIndex) =
                lens.splitOriginOf(kids[i]);
            assertEq(pSeed, parentSeed, "parent seed");
            assertEq(pDenom, 2, "parent denom index (0.1 ETH)");
            assertEq(pGene, parentGene, "parent gene");
            assertEq(pMods, expectedParentModules, "parent effective modules (grammar v1)");
            assertEq(childIndex, i, "child index");
        }
    }

    function test_SplitOriginOfChildrenOfMaterializedParent() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn); // materialized 0.05
        bytes32 parentSeed = shapes.seedOf(survivor);
        uint8 parentGene = shapes.inkGeneOf(survivor);
        bytes memory expectedParentModules = lens.shapeState(survivor).modules;
        assertGt(expectedParentModules.length, 0, "parent must be materialized for this case");

        uint8[] memory outs = new uint8[](5); // 5 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.split(survivor, outs);

        for (uint256 i = 0; i < 5; ++i) {
            (bytes32 pSeed, uint8 pDenom, uint8 pGene, bytes memory pMods, uint256 childIndex) =
                lens.splitOriginOf(kids[i]);
            assertEq(pSeed, parentSeed);
            assertEq(pDenom, 1, "parent denom index (0.05 ETH)");
            assertEq(pGene, parentGene);
            assertEq(pMods, expectedParentModules, "parent effective modules (stored bytes)");
            assertEq(childIndex, i);
        }
    }

    /// @notice The 100 ETH -> 2x50 ETH case: the parent has exactly one module.
    function test_SplitOriginOfChildrenOf100EthOneModuleParent() public {
        uint256 parent = _mint(alice, DENOMS[8]);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8 parentGene = shapes.inkGeneOf(parent);
        bytes memory expectedParentModules = GrammarV1Modules.all(parentSeed, 8, parentGene);
        assertEq(expectedParentModules.length, 1, "apex denomination has exactly one module");

        uint8[] memory outs = new uint8[](2);
        outs[0] = 7; // 50 ETH
        outs[1] = 7;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        for (uint256 i = 0; i < 2; ++i) {
            (bytes32 pSeed, uint8 pDenom, uint8 pGene, bytes memory pMods, uint256 childIndex) =
                lens.splitOriginOf(kids[i]);
            assertEq(pSeed, parentSeed);
            assertEq(pDenom, 8, "parent denom index (100 ETH)");
            assertEq(pGene, parentGene);
            assertEq(pMods, expectedParentModules);
            assertEq(childIndex, i);
        }
    }

    /// @notice Reconstruction round-trip: `sampleSplitChild(parentModules, parentSeed, childDenom,
    ///         childIndex)` from `splitOriginOf` alone must equal each child's stored modules.
    ///         `childDenom` is the child's own live denomination index, valid here because none of
    ///         the children have been mutated since the split.
    function test_SplitOriginOfReconstructionMatchesStoredChildModules() public {
        uint256 parent = _mint(alice, DENOMS[3]);
        uint8[] memory outs = new uint8[](5);
        for (uint256 i = 0; i < 5; ++i) {
            outs[i] = 2; // 5 x 0.1 ETH = 0.5 ETH
        }
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        for (uint256 i = 0; i < 5; ++i) {
            (bytes32 pSeed,,, bytes memory pMods, uint256 childIndex) = lens.splitOriginOf(kids[i]);
            uint8 childDenom = lens.shapeState(kids[i]).denominationIndex;
            bytes memory reconstructed =
                GeometrySampling.sampleSplitChild(pMods, pSeed, childDenom, childIndex);
            assertEq(
                reconstructed, lens.shapeState(kids[i]).modules, "reconstruction != stored child modules"
            );
        }
    }

    function test_SplitOriginOfRevertsForNonSplitChild() public {
        uint256 original = _mint(alice, DENOMS[4]);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotASplitChild.selector, original));
        lens.splitOriginOf(original);

        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotASplitChild.selector, survivor));
        lens.splitOriginOf(survivor);
    }

    /// @notice Decompose re-mints a burned compose input under its original id, but that id was
    ///         never a split child (DECOMPOSE_SPEC.md: re-minted ids are always previously-burned
    ///         compose inputs, never previously-issued split-child ids reused for anything else),
    ///         so it carries no split-origin entry.
    function test_SplitOriginOfRevertsForDecomposedInput() public {
        uint256 first = _mintDust(5);
        uint256 other = first + 1;
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);

        vm.prank(alice);
        shapes.decompose(survivor); // re-mints `other` under its original id

        vm.expectRevert(abi.encodeWithSelector(IShapes.NotASplitChild.selector, other));
        lens.splitOriginOf(other);
    }

    /// @notice A split child later used as a compose survivor keeps answering with its original
    ///         split origin, even though its live materialized modules have since moved on to the
    ///         later compose's result.
    function test_SplitOriginOfSurvivesChildLaterUsedAsComposeSurvivor() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1; // 0.05
        outs[1] = 1;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        uint256 child = kids[0];

        (
            bytes32 pSeedBefore,
            uint8 pDenomBefore,
            uint8 pGeneBefore,
            bytes memory pModsBefore,
            uint256 idxBefore
        ) = lens.splitOriginOf(child);
        bytes memory splitModules = lens.shapeState(child).modules;

        uint256 extra = _mint(alice, DENOMS[1]);
        uint256[] memory burnList = new uint256[](1);
        burnList[0] = extra;
        vm.prank(alice);
        shapes.compose(child, burnList); // child becomes a 0.1 ETH compose survivor

        bytes memory postComposeModules = lens.shapeState(child).modules;
        assertTrue(
            keccak256(postComposeModules) != keccak256(splitModules),
            "compose must resample the child's live modules"
        );

        (bytes32 pSeedAfter, uint8 pDenomAfter, uint8 pGeneAfter, bytes memory pModsAfter, uint256 idxAfter) =
            lens.splitOriginOf(child);
        assertEq(pSeedAfter, pSeedBefore, "split origin seed unchanged by the later compose");
        assertEq(pDenomAfter, pDenomBefore, "split origin denom unchanged");
        assertEq(pGeneAfter, pGeneBefore, "split origin gene unchanged");
        assertEq(pModsAfter, pModsBefore, "split origin parent modules unchanged");
        assertEq(idxAfter, idxBefore, "split origin child index unchanged");
    }

    /// @notice A split child later burned as a compose input, then restored by decompose under
    ///         the same id, still answers with its original split origin: the mapping is never
    ///         deleted, and the id is never reissued to a different creation event.
    function test_SplitOriginOfSurvivesChildBurnedAsComposeInputThenDecomposed() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        uint256 child0 = kids[0];

        (
            bytes32 pSeedBefore,
            uint8 pDenomBefore,
            uint8 pGeneBefore,
            bytes memory pModsBefore,
            uint256 idxBefore
        ) = lens.splitOriginOf(child0);

        uint256 other = _mint(alice, DENOMS[1]);
        uint256[] memory burnList = new uint256[](1);
        burnList[0] = child0;
        vm.prank(alice);
        uint256 outerSurvivor = shapes.compose(other, burnList); // child0 burned as an input

        vm.prank(alice);
        shapes.decompose(outerSurvivor); // re-mints child0 under its original id

        (bytes32 pSeedAfter, uint8 pDenomAfter, uint8 pGeneAfter, bytes memory pModsAfter, uint256 idxAfter) =
            lens.splitOriginOf(child0);
        assertEq(pSeedAfter, pSeedBefore);
        assertEq(pDenomAfter, pDenomBefore);
        assertEq(pGeneAfter, pGeneBefore);
        assertEq(pModsAfter, pModsBefore);
        assertEq(idxAfter, idxBefore);
    }

    /* ==================================================================== *
     *  gas
     * ==================================================================== */

    /// @notice Rough sanity ceiling on the split-record write's cost, not a tight bound. The
    ///         report captures the measured absolute cost for a 2-way split so the reviewer can
    ///         see the marginal overhead of the new record and mapping write.
    function test_GasSplitWithProvenanceRecordIsBounded() public {
        uint256 parent = _mint(alice, DENOMS[8]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 7;
        outs[1] = 7;

        vm.prank(alice);
        uint256 gasBefore = gasleft();
        shapes.split(parent, outs);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("split (2-way, 100 ETH -> 2x50 ETH) gas used:", gasUsed);
        assertLt(gasUsed, 500_000, "split gas grew unexpectedly large with provenance recording");
    }
}

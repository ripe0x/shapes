// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapesBase} from "./Shapes.t.sol";
import {ComposeInputView, ComposeRecordView, ShapeState} from "../src/ShapeTypes.sol";
import {ModuleCodec} from "../src/lib/ModuleCodec.sol";
import {GeometrySampling} from "../src/lib/GeometrySampling.sol";
import {GrammarV1Modules} from "../src/lib/GrammarV1Modules.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice SAMPLING_SPEC.md: compose and split materialize a token's geometry into a compact
///         byte array sampled from the merged cards' modules, instead of re-deriving from the
///         survivor's seed at the new denomination. Covers the invariants in §10: materialized
///         arrays are the right length and every byte valid (1), every sampled byte traces back
///         to some input's effective modules (2), decompose restores bit-exactly (3), and an
///         original mint is never materialized and renders byte-identically to grammar v1 (4).
contract SamplingTest is ShapesBase {
    function _mintDust(uint256 k) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: k * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], k);
    }

    /// @dev A token's effective module byte array: its materialized bytes if any, otherwise the
    ///      grammar v1 sequence read back through the renderer. Reading it through
    ///      `ShapeRenderer.moduleAt` rather than importing `GrammarV1Modules` directly makes this
    ///      a genuine cross-check of the on-chain module-derivation contract, not a re-assertion
    ///      of `Shapes`'s own internal helper.
    function _effectiveModules(uint256 id) internal view returns (bytes memory out) {
        bytes memory stored = shapes.shapeState(id).modules;
        if (stored.length != 0) return stored;

        bytes32 seed = shapes.seedOf(id);
        uint256 amount = shapes.backingOf(id);
        uint8 gene = shapes.inkGeneOf(id);
        uint256 n = _modulesForAmount(amount);
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            (uint8 kind, bool solid, uint16 rotation,,,,) = renderer.moduleAt(seed, amount, gene, i);
            out[i] = ModuleCodec.encode(kind, solid, rotation / 90);
        }
    }

    function _containsByte(bytes memory hay, bytes1 needle) internal pure returns (bool) {
        for (uint256 i = 0; i < hay.length; ++i) {
            if (hay[i] == needle) return true;
        }
        return false;
    }

    /// @dev Rebuilds a split's compose-record pool (SAMPLING_SPEC.md §6, D3'): the survivor's
    ///      pre-compose effective modules first, then the inputs' effective modules sorted
    ///      ascending by id (the record stores them in calldata order).
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

    /// @dev `GrammarV1Modules` duplicates the renderer's module-identity draws so compose
    ///      sampling cannot depend on the admin-replaceable renderer address. This pins the two
    ///      implementations to each other across every denomination and gene.
    function testFuzz_GrammarV1MirrorMatchesRenderer(bytes32 seed, uint8 denomIndex, uint8 inkGene)
        public
        view
    {
        denomIndex = uint8(bound(denomIndex, 0, Denominations.COUNT - 1));
        inkGene = uint8(bound(inkGene, 0, 6));
        uint256 amount = Denominations.amountAt(denomIndex);

        bytes memory mirror = GrammarV1Modules.all(seed, denomIndex, inkGene);
        (uint256 cols, uint256 rows) = Denominations.gridAt(denomIndex);
        assertEq(mirror.length, cols * rows, "mirror length");
        for (uint256 i = 0; i < mirror.length; ++i) {
            (uint8 kind, bool solid, uint16 rotation,,,,) = renderer.moduleAt(seed, amount, inkGene, i);
            assertEq(mirror[i], ModuleCodec.encode(kind, solid, rotation / 90), "mirror module");
        }
    }

    /// @notice `decode` does not validate, so `isValid` is the only thing standing between a
    ///         stray byte and a module the grammar does not define. It rejects a set bit 7, a
    ///         kind past the ten defined kinds, and a rotation index the kind does not take.
    function test_ModuleCodecRejectsEveryMalformedByteClass() public pure {
        assertTrue(ModuleCodec.isValid(ModuleCodec.encode(9, true, 1)), "a byte from encode is valid");
        assertTrue(ModuleCodec.isValid(ModuleCodec.encode(0, false, 0)), "circle at its only rotation");

        assertFalse(ModuleCodec.isValid(bytes1(uint8(0x80))), "bit 7 set is never valid");
        assertFalse(ModuleCodec.isValid(bytes1(uint8(0xFF))), "bit 7 wins over everything else");
        assertFalse(ModuleCodec.isValid(bytes1(uint8(10))), "kind 10 is past the grammar");
        assertFalse(ModuleCodec.isValid(bytes1(uint8(15))), "kind 15 is past the grammar");
        assertFalse(ModuleCodec.isValid(bytes1(uint8((1 << 5) | 0))), "a circle has one rotation");
        assertFalse(ModuleCodec.isValid(bytes1(uint8((2 << 5) | 9))), "the diagonal has two");
        assertTrue(ModuleCodec.isValid(bytes1(uint8((1 << 5) | 9))), "and the second one is valid");
    }

    /* ------------------------------ original mints ------------------------------ */

    function test_OriginalMintsAreNeverMaterialized() public {
        for (uint256 i = 0; i < 9; ++i) {
            uint256 id = _mint(alice, DENOMS[i]);
            assertEq(shapes.shapeState(id).modules.length, 0, "original mint must not be materialized");
        }
    }

    function test_OriginalMintTokenUriMatchesGrammarV1Renderer() public {
        uint256 id = _mint(alice, DENOMS[4]);
        bytes32 seed = shapes.seedOf(id);
        string memory expected = renderer.tokenURI(
            seed,
            DENOMS[4],
            id,
            1,
            false,
            shapes.inkGeneOf(id),
            0,
            collection.tokenNamePrefix(),
            collection.description(),
            false
        );
        assertEq(shapes.tokenURI(id), expected, "an unmaterialized token must render via grammar v1");
    }

    /* ------------------------------ compose materializes ------------------------------ */

    function test_ComposeMaterializesValidArrayFromInputs() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        // Snapshot every donor's effective modules before compose burns the inputs.
        bytes[] memory donorMods = new bytes[](5);
        donorMods[0] = _effectiveModules(first);
        for (uint256 i = 0; i < 4; ++i) {
            donorMods[i + 1] = _effectiveModules(burn[i]);
        }

        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);

        bytes memory got = shapes.shapeState(survivor).modules;
        (uint256 cols, uint256 rows) = _gridForAmount(shapes.backingOf(survivor));
        assertEq(got.length, cols * rows, "materialized length != new grid cell count");
        assertGt(got.length, 0, "compose must materialize a nonempty array");

        for (uint256 i = 0; i < got.length; ++i) {
            assertTrue(ModuleCodec.isValid(got[i]), "invalid module byte");
            bool found;
            for (uint256 d = 0; d < donorMods.length && !found; ++d) {
                found = _containsByte(donorMods[d], got[i]);
            }
            assertTrue(found, "sampled byte not present in any donor's effective modules");
        }
    }

    /// @notice Same invariant, one tier up: donors include an already-materialized survivor
    ///         (itself the product of a prior compose), so the union spans both an original
    ///         donor's grammar-v1 modules and a materialized donor's stored bytes.
    function test_ComposeMaterializesFromMixedOriginalAndMaterializedDonors() public {
        uint256 firstA = _mintDust(5);
        uint256[] memory burnA = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnA[i] = firstA + 1 + i;
        }
        vm.prank(alice);
        uint256 a = shapes.compose(firstA, burnA); // materialized 0.05

        uint256 b = _mint(alice, DENOMS[1]); // original 0.05

        bytes memory modsA = _effectiveModules(a);
        bytes memory modsB = _effectiveModules(b);

        uint256[] memory burnOuter = new uint256[](1);
        burnOuter[0] = b;
        vm.prank(alice);
        shapes.compose(a, burnOuter); // 0.1, mixed donor set

        bytes memory got = shapes.shapeState(a).modules;
        (uint256 cols, uint256 rows) = _gridForAmount(DENOMS[2]);
        assertEq(got.length, cols * rows);
        for (uint256 i = 0; i < got.length; ++i) {
            assertTrue(ModuleCodec.isValid(got[i]));
            assertTrue(
                _containsByte(modsA, got[i]) || _containsByte(modsB, got[i]),
                "sampled byte not present in either donor's effective modules"
            );
        }
    }

    /* ------------------------------ preview matches execution ------------------------------ */

    function test_PreviewComposeModulesMatchExecution() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        ShapeState memory preview = shapes.previewCompose(first, burn);
        vm.prank(alice);
        shapes.compose(first, burn);
        bytes memory actual = shapes.shapeState(first).modules;
        assertEq(actual, preview.modules, "preview bytes must equal executed bytes");
    }

    /* ------------------------------ calldata order independence ------------------------------ */

    function test_ComposeSampledResultIndependentOfBurnIdsOrder() public {
        uint256 first = _mintDust(5);
        uint256 snapshot = vm.snapshotState();

        uint256[] memory forward = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            forward[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, forward);
        bytes memory modsForward = shapes.shapeState(first).modules;

        vm.revertToState(snapshot);

        uint256[] memory shuffled = new uint256[](4);
        shuffled[0] = first + 3;
        shuffled[1] = first + 1;
        shuffled[2] = first + 4;
        shuffled[3] = first + 2;
        vm.prank(alice);
        shapes.compose(first, shuffled);
        bytes memory modsShuffled = shapes.shapeState(first).modules;

        assertEq(modsForward, modsShuffled, "burnIds calldata order changed the sampled modules");
    }

    /* ------------------------------ decompose round-trip ------------------------------ */

    function test_DecomposeRestoresModulesBitExactly_SingleLevel() public {
        uint256 first = _mintDust(5);
        assertEq(shapes.shapeState(first).modules.length, 0, "fresh mint starts unmaterialized");

        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);
        bytes memory composed = shapes.shapeState(survivor).modules;
        assertGt(composed.length, 0, "compose must materialize");

        vm.prank(alice);
        shapes.decompose(survivor);
        assertEq(
            shapes.shapeState(survivor).modules.length, 0, "decompose restores the empty (seed-derived) state"
        );

        for (uint256 i = 0; i < 4; ++i) {
            assertEq(
                shapes.shapeState(first + 1 + i).modules.length, 0, "restored input stays unmaterialized"
            );
        }
    }

    function test_DecomposeRestoresModulesBitExactly_Stacked() public {
        uint256 firstA = _mintDust(5);
        uint256[] memory burnA = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnA[i] = firstA + 1 + i;
        }
        vm.prank(alice);
        uint256 a = shapes.compose(firstA, burnA); // materialized, depth 1
        bytes memory level1 = shapes.shapeState(a).modules;

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
        shapes.compose(a, burnOuter); // a -> 0.1, depth 2
        bytes memory level2 = shapes.shapeState(a).modules;
        assertTrue(keccak256(level2) != keccak256(level1), "the second compose should resample");

        vm.prank(alice);
        shapes.decompose(a); // pop outer record -> a must equal its depth-1 array exactly
        assertEq(shapes.shapeState(a).modules, level1, "stacked decompose did not restore bit-exactly");

        vm.prank(alice);
        shapes.decompose(a); // pop inner record -> a must be unmaterialized again
        assertEq(shapes.shapeState(a).modules.length, 0, "fully unwound compose must be unmaterialized");
    }

    /* ------------------------------ split ------------------------------ */

    /// @notice The 100 ETH -> 2x50 ETH case, direct-mint parent (no compose record): grammar
    ///         branch (SAMPLING_SPEC.md §6, D3'). The parent's own apex module is irrelevant:
    ///         each child samples from `grammarSplitPool(parentSeed, childDenom, gene)`, the
    ///         grammar v1 expression at the CHILD's own denomination, which escapes the apex's
    ///         one-module monoculture (issue #21B).
    function test_SplitChildrenOfDirectMintApexUseGrammarPool_100to50x2() public {
        uint256 parent = _mint(alice, DENOMS[8]);
        bytes memory parentMods = _effectiveModules(parent);
        assertEq(parentMods.length, 1, "apex denomination has exactly one module");
        assertEq(shapes.composeDepth(parent), 0, "direct mint has no compose record: grammar branch");

        bytes32 parentSeed = shapes.seedOf(parent);
        uint8 parentGene = shapes.inkGeneOf(parent);

        uint8[] memory outs = new uint8[](2);
        outs[0] = 7; // 50 ETH
        outs[1] = 7;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        (uint256 cols, uint256 rows) = _gridForAmount(DENOMS[7]);
        bytes memory pool = GeometrySampling.grammarSplitPool(parentSeed, 7, parentGene);
        for (uint256 i = 0; i < 2; ++i) {
            bytes memory childMods = shapes.shapeState(kids[i]).modules;
            assertEq(childMods.length, cols * rows, "child length != 50 ETH grid cell count");
            bytes memory expected = GeometrySampling.sampleSplitChild(pool, parentSeed, 7, i);
            assertEq(
                childMods, expected, "grammar-branch child must match the pool sample, not the apex byte"
            );
            for (uint256 j = 0; j < childMods.length; ++j) {
                assertTrue(ModuleCodec.isValid(childMods[j]), "invalid child module byte");
            }
        }
    }

    /// @notice A materialized (compose-survivor) parent uses the record branch (SAMPLING_SPEC.md
    ///         §6, D3'): each child draws from the parent's top compose record's donor pool
    ///         (pre-compose survivor's effective modules, then inputs ascending by id), not from
    ///         the parent's own post-compose stored bytes.
    function test_SplitChildrenOfMaterializedParentDrawFromComposeRecordPool() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn); // materialized 0.05, one compose record
        uint256 depth = shapes.composeDepth(survivor);
        assertGt(depth, 0, "compose survivor has a compose record: record branch");

        bytes32 parentSeed = shapes.seedOf(survivor);
        ComposeRecordView memory rec = shapes.composeRecordAt(survivor, depth - 1);
        bytes memory pool = _reconstructSplitRecordPool(parentSeed, rec);

        uint8[] memory outs = new uint8[](5); // 5 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.split(survivor, outs);
        for (uint256 i = 0; i < 5; ++i) {
            bytes memory childMods = shapes.shapeState(kids[i]).modules;
            assertEq(childMods.length, 25, "0.01 ETH grid is 5x5");
            bytes memory expected = GeometrySampling.sampleSplitChild(pool, parentSeed, 0, i);
            assertEq(childMods, expected, "record-branch child must match the compose record's donor pool");
            for (uint256 j = 0; j < 25; ++j) {
                assertTrue(ModuleCodec.isValid(childMods[j]));
                assertTrue(
                    _containsByte(pool, childMods[j]), "split child byte not drawn from the record pool"
                );
            }
        }
    }

    /// @notice The split stream takes the untruncated child index (SAMPLING_SPEC.md §6). A uint8
    ///         index would give children k and k + 256 of one split, at one denomination, the same
    ///         stream and so byte-identical stored modules, while their token ids and seeds differ.
    function test_SplitChildIndexDoesNotAliasEvery256() public {
        uint256 parent = _mint(alice, DENOMS[5]);
        uint8[] memory outs = new uint8[](500); // 500 x 0.01 ETH, all denomination index 0

        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        assertEq(kids.length, 500, "split must produce one child per output denomination");

        for (uint256 k = 0; k < 500 - 256; ++k) {
            bytes memory a = shapes.shapeState(kids[k]).modules;
            bytes memory b = shapes.shapeState(kids[k + 256]).modules;
            assertEq(a.length, 25, "0.01 ETH grid is 5x5");
            assertTrue(shapes.seedOf(kids[k]) != shapes.seedOf(kids[k + 256]), "child seeds differ");
            assertTrue(keccak256(a) != keccak256(b), "children 256 apart share a sampling stream");
        }
    }

    /* ------------------------------ burn clears materialized geometry ------------------------------ */

    /// @dev Raw read of `_sampledModules[tokenId]` (storage slot 7). The public getter requires
    ///      the token to exist, so a burned id's leftover state is only observable here. Every
    ///      materialized array is at most 25 bytes, a short `bytes` that lives entirely in the
    ///      mapping slot, so one `vm.load` is the whole value.
    function _rawSampledModulesSlot(uint256 tokenId) internal view returns (bytes32) {
        return vm.load(address(shapes), keccak256(abi.encode(tokenId, uint256(7))));
    }

    function test_RedeemClearsMaterializedModules() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1; // 0.05
        outs[1] = 1;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        assertGt(shapes.shapeState(kids[0]).modules.length, 0, "split child must be materialized");
        assertTrue(_rawSampledModulesSlot(kids[0]) != bytes32(0), "materialized slot is nonzero");

        vm.prank(alice);
        shapes.redeem(kids[0]);
        assertEq(_rawSampledModulesSlot(kids[0]), bytes32(0), "redeem left materialized geometry behind");
    }

    /// @notice D3' (SAMPLING_SPEC.md §6): children of an original (never-composed) parent also
    ///         materialize, sampling from the grammar branch: the parent seed's grammar v1
    ///         expression at the CHILD's own denomination, not the parent's own grammar sequence
    ///         at the parent's denomination.
    function test_SplitChildrenOfOriginalParentAlsoMaterialize() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        assertEq(shapes.composeDepth(parent), 0, "direct mint has no compose record: grammar branch");
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8 parentGene = shapes.inkGeneOf(parent);

        uint8[] memory outs = new uint8[](2);
        outs[0] = 1; // 0.05
        outs[1] = 1;
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        bytes memory pool = GeometrySampling.grammarSplitPool(parentSeed, 1, parentGene);
        for (uint256 i = 0; i < 2; ++i) {
            bytes memory childMods = shapes.shapeState(kids[i]).modules;
            assertGt(childMods.length, 0, "split child of an original parent must materialize");
            bytes memory expected = GeometrySampling.sampleSplitChild(pool, parentSeed, 1, i);
            assertEq(childMods, expected, "grammar-branch child must match the child-denom grammar pool");
            for (uint256 j = 0; j < childMods.length; ++j) {
                assertTrue(_containsByte(pool, childMods[j]));
            }
        }
    }

    /* ------------------------------ materialized burned input round-trip ------------------------------ */

    /// @notice Decompose restores a materialized burned input byte for byte, not just the
    ///         survivor. A split child is materialized on creation, so burning one into a compose
    ///         and decomposing exercises the `ComposeInput.modules` snapshot path end to end.
    function test_DecomposeRestoresMaterializedBurnedInputBitExactly() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](10); // 10 x 0.01 ETH
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        uint256 input = kids[3];
        ShapeState memory before = shapes.shapeState(input);
        assertGt(before.modules.length, 0, "a split child is materialized");
        uint256 faceValue = shapes.backingOf(input);

        // 5 x 0.01 ETH compose to 0.05 ETH; `input` is one of the four burned inputs.
        uint256 survivor = kids[0];
        uint256[] memory burn = new uint256[](4);
        burn[0] = kids[1];
        burn[1] = kids[2];
        burn[2] = input;
        burn[3] = kids[4];
        vm.prank(alice);
        shapes.compose(survivor, burn);
        vm.expectRevert();
        shapes.ownerOf(input);

        vm.prank(alice);
        shapes.decompose(survivor);

        ShapeState memory restored = shapes.shapeState(input);
        assertEq(shapes.ownerOf(input), alice, "decompose re-mints the input to the caller");
        assertEq(restored.seed, before.seed, "seed");
        assertEq(restored.denominationIndex, before.denominationIndex, "denomIndex");
        assertEq(restored.originCount, before.originCount, "originCount");
        assertEq(restored.inkGene, before.inkGene, "inkGene");
        assertEq(restored.isBlack, before.isBlack, "isBlack");
        assertEq(uint8(restored.formation), uint8(before.formation), "formation");
        assertEq(restored.faceValueWei, before.faceValueWei, "faceValue");
        assertEq(restored.redeemableValueWei, before.redeemableValueWei, "redeemableValue");
        assertEq(restored.modules, before.modules, "materialized modules must return byte-identical");

        uint256 balanceBefore = alice.balance;
        vm.prank(alice);
        shapes.redeem(input);
        assertEq(alice.balance - balanceBefore, faceValue, "restored input redeems for its face value");
        _assertSolvent();
    }
}

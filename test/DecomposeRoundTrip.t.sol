// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShapesBase} from "./Shapes.t.sol";
import {ShapeState} from "../src/ShapeTypes.sol";

/// @notice Fuzzes mint/split/nested-compose setups of varying tier, materialization and stack
///         depth, then proves `decompose`/`decomposeMany` restores every observable fact of the
///         survivor and of every burned input to exactly its pre-compose value.
contract DecomposeRoundTripTest is ShapesBase {
    /// @dev Keeps `ownerToken()`/`owner()` live so the round trip can assert them unaffected too.
    function _keepGenesisShape() internal pure override returns (bool) {
        return true;
    }

    struct Snapshot {
        ShapeState state;
        address owner;
        string tokenURI;
        string svg;
        string metadataJSON;
        uint256 cols;
        uint256 rows;
        uint256 moduleCount;
        bytes effectiveModules;
        bool isBlack;
        uint256 composeDepth;
        bool hasSplitOrigin;
        bytes32 splitParentSeed;
        uint256 splitParentId;
        uint8 splitParentDenomIndex;
        uint8 splitOriginDenomIndex;
        uint8 splitParentInkGene;
        bytes splitParentModules;
        uint256 splitChildIndex;
    }

    function _snapshot(uint256 id) internal view returns (Snapshot memory s) {
        s.state = shapes.shapeState(id);
        s.owner = shapes.ownerOf(id);
        s.tokenURI = shapes.tokenURI(id);
        s.svg = shapes.svg(id);
        s.metadataJSON = shapes.metadataJSON(id);
        (s.cols, s.rows, s.moduleCount) = shapes.geometryOf(id);
        s.effectiveModules = shapes.effectiveModulesOf(id);
        s.isBlack = shapes.isBlackShape(id);
        s.composeDepth = shapes.composeDepth(id);
        try shapes.splitOriginOf(id) returns (
            bytes32 pSeed,
            uint256 pId,
            uint8 pDenom,
            uint8 oDenom,
            uint8 pGene,
            bytes memory pModules,
            uint256 cIdx
        ) {
            s.hasSplitOrigin = true;
            s.splitParentSeed = pSeed;
            s.splitParentId = pId;
            s.splitParentDenomIndex = pDenom;
            s.splitOriginDenomIndex = oDenom;
            s.splitParentInkGene = pGene;
            s.splitParentModules = pModules;
            s.splitChildIndex = cIdx;
        } catch {
            s.hasSplitOrigin = false;
        }
    }

    function _assertUnchanged(uint256 id, Snapshot memory before) internal view {
        Snapshot memory current = _snapshot(id);
        assertEq(current.owner, before.owner, "owner");
        assertEq(current.state.seed, before.state.seed, "seed");
        assertEq(current.state.denominationIndex, before.state.denominationIndex, "denomIndex");
        assertEq(current.state.originCount, before.state.originCount, "originCount");
        assertEq(current.state.inkGene, before.state.inkGene, "inkGene");
        assertEq(current.state.isBlack, before.state.isBlack, "state.isBlack");
        assertEq(uint8(current.state.formation), uint8(before.state.formation), "formation");
        assertEq(current.state.faceValueWei, before.state.faceValueWei, "faceValueWei");
        assertEq(current.state.redeemableValueWei, before.state.redeemableValueWei, "redeemableValueWei");
        assertEq(current.state.modules, before.state.modules, "modules");
        assertEq(keccak256(bytes(current.tokenURI)), keccak256(bytes(before.tokenURI)), "tokenURI");
        assertEq(keccak256(bytes(current.svg)), keccak256(bytes(before.svg)), "svg");
        assertEq(
            keccak256(bytes(current.metadataJSON)), keccak256(bytes(before.metadataJSON)), "metadataJSON"
        );
        assertEq(current.cols, before.cols, "cols");
        assertEq(current.rows, before.rows, "rows");
        assertEq(current.moduleCount, before.moduleCount, "moduleCount");
        assertEq(current.effectiveModules, before.effectiveModules, "effectiveModules");
        assertEq(current.isBlack, before.isBlack, "isBlackShape");
        assertEq(current.composeDepth, before.composeDepth, "composeDepth");
        assertEq(current.hasSplitOrigin, before.hasSplitOrigin, "hasSplitOrigin");
        if (before.hasSplitOrigin) {
            assertEq(current.splitParentSeed, before.splitParentSeed, "splitParentSeed");
            assertEq(current.splitParentId, before.splitParentId, "splitParentId");
            assertEq(current.splitParentDenomIndex, before.splitParentDenomIndex, "splitParentDenomIndex");
            assertEq(current.splitOriginDenomIndex, before.splitOriginDenomIndex, "splitOriginDenomIndex");
            assertEq(current.splitParentInkGene, before.splitParentInkGene, "splitParentInkGene");
            assertEq(current.splitParentModules, before.splitParentModules, "splitParentModules");
            assertEq(current.splitChildIndex, before.splitChildIndex, "splitChildIndex");
        }
    }

    /// @dev Builds one live token backed at `DENOMS[tierIdx]`, chosen by `seed % 3`: a plain mint,
    ///      a materialized split child (a tier-up parent split evenly down into this tier, so its
    ///      modules are stored bytes rather than derived from its seed), or a composed survivor of
    ///      its own (a tier-down group merged up, composeDepth 1). Covers plain, split-materialized
    ///      and already-composed burned inputs across the fuzz runs.
    function _buildTokenAtBacking(uint256 tierIdx, uint256 seed) internal returns (uint256 id) {
        uint256 backing = DENOMS[tierIdx];
        uint256 mode = seed % 3;
        if (mode == 1 && tierIdx < 8) {
            uint256 parentTier = tierIdx + 1;
            uint256 ratio = DENOMS[parentTier] / backing;
            uint256 parent = _mint(alice, DENOMS[parentTier]);
            uint8[] memory outs = new uint8[](ratio);
            for (uint256 j = 0; j < ratio; ++j) {
                outs[j] = uint8(tierIdx);
            }
            vm.prank(alice);
            uint256[] memory kids = shapes.split(parent, outs);
            return kids[0];
        }
        if (mode == 2 && tierIdx > 0) {
            uint256 childTier = tierIdx - 1;
            uint256 ratio = backing / DENOMS[childTier];
            uint256[] memory kids = new uint256[](ratio);
            for (uint256 j = 0; j < ratio; ++j) {
                kids[j] = _mint(alice, DENOMS[childTier]);
            }
            uint256[] memory kidBurn = new uint256[](ratio - 1);
            for (uint256 j = 0; j < ratio - 1; ++j) {
                kidBurn[j] = kids[1 + j];
            }
            vm.prank(alice);
            return shapes.compose(kids[0], kidBurn);
        }
        return _mint(alice, backing);
    }

    /// @dev Builds a survivor stacked `depth` compose records deep starting at `DENOMS[baseTier]`,
    ///      each level's extra inputs a mix of plain mints, split-materialized tokens and
    ///      already-composed tokens (see `_buildTokenAtBacking`), snapshots the survivor and every
    ///      burned input right before its compose, then unwinds the whole stack in one
    ///      `decomposeMany` call and asserts every snapshot still matches exactly.
    function testFuzz_DecomposeRestoresEveryObservableFact(uint256 seed) public {
        uint256 baseTier = bound(seed, 0, 7);
        uint256 maxDepth = 8 - baseTier < 3 ? 8 - baseTier : 3;
        uint256 depth = bound(seed >> 16, 1, maxDepth);

        Snapshot[3] memory survivorPre;
        Snapshot[][] memory burnPre = new Snapshot[][](depth);
        uint256[][] memory burnIds = new uint256[][](depth);
        uint256 survivor;
        uint256 curTier = baseTier;

        for (uint256 d = 0; d < depth; ++d) {
            uint256 ratio = DENOMS[curTier + 1] / DENOMS[curTier];
            uint256[] memory ids = new uint256[](ratio);
            if (d == 0) {
                // The base survivor itself always starts fresh (composeDepth 0): only the burned
                // inputs vary by build mode, so the final `composeDepth(survivor) == 0` assertion
                // after fully unwinding is not confounded by the survivor arriving pre-composed.
                ids[0] = _mint(alice, DENOMS[curTier]);
                for (uint256 j = 1; j < ratio; ++j) {
                    ids[j] = _buildTokenAtBacking(curTier, uint256(keccak256(abi.encode(seed, d, j))));
                }
                survivor = ids[0];
            } else {
                ids[0] = survivor;
                for (uint256 j = 1; j < ratio; ++j) {
                    ids[j] = _buildTokenAtBacking(curTier, uint256(keccak256(abi.encode(seed, d, j))));
                }
            }

            survivorPre[d] = _snapshot(survivor);
            uint256[] memory burn = new uint256[](ratio - 1);
            Snapshot[] memory bpre = new Snapshot[](ratio - 1);
            for (uint256 j = 0; j < ratio - 1; ++j) {
                burn[j] = ids[j + 1];
                bpre[j] = _snapshot(burn[j]);
            }
            burnIds[d] = burn;
            burnPre[d] = bpre;

            vm.prank(alice);
            survivor = shapes.compose(survivor, burn);
            curTier += 1;
        }

        uint256 ownerTokenBefore = shapes.ownerToken();
        address ownerBefore = shapes.owner();
        uint256 totalMintedBefore = shapes.totalMinted();

        uint256[] memory decomposeIds = new uint256[](depth);
        for (uint256 d = 0; d < depth; ++d) {
            decomposeIds[d] = survivor;
        }
        vm.prank(alice);
        uint256[][] memory restored = shapes.decomposeMany(decomposeIds);

        assertEq(shapes.totalMinted(), totalMintedBefore, "decompose issues no new ids");
        assertEq(shapes.ownerToken(), ownerTokenBefore, "ownerToken unaffected");
        assertEq(shapes.owner(), ownerBefore, "owner unaffected");
        assertEq(shapes.composeDepth(survivor), 0, "record fully unwound");

        // decomposeMany pops newest-first: restored[0] is the last level built, restored[depth-1]
        // is the original base group.
        for (uint256 k = 0; k < depth; ++k) {
            uint256 level = depth - 1 - k;
            assertEq(restored[k].length, burnIds[level].length, "restored count for level");
            for (uint256 j = 0; j < restored[k].length; ++j) {
                assertEq(restored[k][j], burnIds[level][j], "restored id order/value");
                _assertUnchanged(burnIds[level][j], burnPre[level][j]);
            }
        }
        _assertUnchanged(survivor, survivorPre[0]);
        _assertSolvent();
    }
}

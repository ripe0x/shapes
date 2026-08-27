// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IShapes} from "./interfaces/IShapes.sol";
import {IShapeRenderer} from "./interfaces/IShapeRenderer.sol";
import {IShapeLens} from "./interfaces/IShapeLens.sol";
import {
    ComposeInputView,
    ComposeRecordView,
    ShapeChildPreview,
    ShapeFormation,
    ShapeState
} from "./interfaces/IShapeCapabilities.sol";
import {Denominations} from "./lib/Denominations.sol";
import {InkGenes} from "./lib/InkGenes.sol";
import {GeometrySampling} from "./lib/GeometrySampling.sol";
import {ComposeCompute} from "./lib/ComposeCompute.sol";

/// @title ShapeLens
/// @notice Read-only periphery for `Shapes`, deployed separately to keep the core token's runtime
///         bytecode under the EIP-170 size limit.
/// @dev Holds no state and no owner. Every view here reads token state through `Shapes`'s own
///      getters (`isBlack`, `seedOf`, `denomIndexOf`, `originCountOf`, `inkGeneOf`, `modulesOf`) and
///      recomputes its result with the same externally linked libraries `Shapes` links and
///      executes with (`GeometrySampling`, `ComposeCompute`, `InkGenes`), so `previewCompose` and
///      `previewSplit` are bit-identical to what `Shapes.compose` / `Shapes.split` would produce,
///      and `shapeState` is bit-identical to what `Shapes` itself has stored. Reverts propagate
///      the same custom errors `Shapes` declares (`IShapes.TokenIsBlack`, and so on), since this
///      contract applies the identical validation before computing a result.
contract ShapeLens is IShapeLens {
    IShapes public immutable shapes;

    constructor(address shapes_) {
        require(shapes_ != address(0), "shapes is zero");
        shapes = IShapes(shapes_);
    }

    /* ------------------------------ shapeState ------------------------------ */

    /// @inheritdoc IShapeLens
    function shapeState(uint256 tokenId) external view returns (ShapeState memory) {
        bool black = shapes.isBlack(tokenId); // reverts if tokenId does not exist
        return _shapeState(
            shapes.seedOf(tokenId),
            shapes.denomIndexOf(tokenId),
            uint32(shapes.originCountOf(tokenId)),
            shapes.inkGeneOf(tokenId),
            black,
            shapes.modulesOf(tokenId)
        );
    }

    function _shapeState(
        bytes32 seed,
        uint8 denomIndex,
        uint32 originCount,
        uint8 inkGene,
        bool black,
        bytes memory modules
    ) private pure returns (ShapeState memory state) {
        uint256 faceValue = Denominations.amountAt(denomIndex);
        state = ShapeState({
            seed: seed,
            denominationIndex: denomIndex,
            originCount: originCount,
            inkGene: inkGene,
            isBlack: black,
            formation: _formation(denomIndex, originCount, black),
            faceValueWei: faceValue,
            redeemableValueWei: black ? 0 : faceValue,
            modules: modules
        });
    }

    function _formation(uint8 denomIndex, uint32 originCount, bool black)
        private
        pure
        returns (ShapeFormation)
    {
        if (black) return ShapeFormation.Black;
        uint256 units = Denominations.unitsAt(denomIndex);
        if (units > 1 && originCount == units) return ShapeFormation.Complete;
        if (originCount == 0) return ShapeFormation.Fragment;
        if (originCount == 1) return ShapeFormation.Direct;
        return ShapeFormation.Composed;
    }

    /* ----------------------------- previewCompose ---------------------------- */

    /// @dev Mirrors `Shapes.BurnPoolAccum`: the same pool statistics, folded here from external
    ///      reads instead of storage.
    struct BurnPoolAccum {
        uint256 total;
        uint256 origins;
        uint256 burnSeedFold;
        uint8 best;
        uint8 worst;
        uint256 sumW;
        uint256 unitsTotal;
    }

    /// @inheritdoc IShapeLens
    function previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory result)
    {
        uint256 n = burnIds.length;
        if (n == 0) revert IShapes.EmptyRecomposition();

        if (shapes.isBlack(survivorId)) revert IShapes.TokenIsBlack(survivorId); // also existence

        uint8 oldIndex = shapes.denomIndexOf(survivorId);
        bytes memory survivorModules = shapes.modulesOf(survivorId);
        bytes32 survivorSeed = shapes.seedOf(survivorId);
        uint32 survivorOriginCount = uint32(shapes.originCountOf(survivorId));
        uint8 survivorInkGene = shapes.inkGeneOf(survivorId);

        uint256 survivorUnits = Denominations.unitsAt(oldIndex);
        BurnPoolAccum memory acc;
        acc.total = Denominations.amountAt(oldIndex);
        acc.origins = survivorOriginCount;
        acc.best = survivorInkGene;
        acc.worst = survivorInkGene;
        acc.sumW = uint256(survivorInkGene) * survivorUnits;
        acc.unitsTotal = survivorUnits;

        GeometrySampling.Donor[] memory burnDonors = new GeometrySampling.Donor[](n);

        for (uint256 i = 0; i < n; ++i) {
            uint256 burnId = burnIds[i];
            if (burnId == survivorId) revert IShapes.CannotComposeWithSelf(burnId);
            for (uint256 j = 0; j < i; ++j) {
                if (burnIds[j] == burnId) revert IShapes.DuplicateComposeInput(burnId);
            }
            if (shapes.isBlack(burnId)) revert IShapes.TokenIsBlack(burnId); // also existence

            burnDonors[i] = _accumulateBurnDonor(burnId, acc);
        }

        uint8 newDenomIndex = uint8(Denominations.requireIndexOf(acc.total));
        uint8 centerGene = InkGenes.center(acc.sumW, acc.unitsTotal);
        (uint8 newGene, bytes memory sampled) = ComposeCompute.composeSampleAndGene(
            GeometrySampling.Donor({
                id: survivorId,
                units: survivorUnits,
                seed: survivorSeed,
                denomIndex: oldIndex,
                inkGene: survivorInkGene,
                modules: survivorModules
            }),
            burnDonors,
            acc.burnSeedFold,
            newDenomIndex,
            acc.best,
            acc.worst,
            centerGene
        );

        return _shapeState(survivorSeed, newDenomIndex, uint32(acc.origins), newGene, false, sampled);
    }

    /// @dev One burn-side donor's contribution to `acc`, plus its `Donor` snapshot for module
    ///      sampling. Mirrors `Shapes._accumulateBurnDonor`, reading the donor's fields through
    ///      `Shapes`'s getters instead of storage.
    function _accumulateBurnDonor(uint256 burnId, BurnPoolAccum memory acc)
        private
        view
        returns (GeometrySampling.Donor memory donor)
    {
        uint8 denomIndex = shapes.denomIndexOf(burnId);
        bytes memory modules = shapes.modulesOf(burnId);
        uint32 originCount = uint32(shapes.originCountOf(burnId));
        bytes32 seed = shapes.seedOf(burnId);
        uint8 inkGene = shapes.inkGeneOf(burnId);

        acc.total += Denominations.amountAt(denomIndex);
        acc.origins += originCount;
        // Fold order-invariantly (XOR), matching `Shapes._accumulateBurnDonor`.
        acc.burnSeedFold ^= uint256(seed);
        if (inkGene > acc.best) acc.best = inkGene;
        if (inkGene < acc.worst) acc.worst = inkGene;
        uint256 units = Denominations.unitsAt(denomIndex);
        acc.sumW += uint256(inkGene) * units;
        acc.unitsTotal += units;

        donor = GeometrySampling.Donor({
            id: burnId, units: units, seed: seed, denomIndex: denomIndex, inkGene: inkGene, modules: modules
        });
    }

    /* ------------------------------ previewSplit ----------------------------- */

    /// @inheritdoc IShapeLens
    function previewSplit(uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert IShapes.EmptyRecomposition();

        if (shapes.isBlack(tokenId)) revert IShapes.TokenIsBlack(tokenId); // also existence

        uint8 denomIndex = shapes.denomIndexOf(tokenId);
        uint32 originCount = uint32(shapes.originCountOf(tokenId));
        bytes32 seed = shapes.seedOf(tokenId);
        uint8 inkGene = shapes.inkGeneOf(tokenId);

        uint256 parentBacking = Denominations.amountAt(denomIndex);
        _requireSplitSumMatches(parentBacking, outDenoms);
        uint32[] memory give = _allocateSplitOrigins(originCount, outDenoms);

        children = new ShapeChildPreview[](k);
        for (uint256 i = 0; i < k; ++i) {
            children[i] = ShapeChildPreview({
                seed: _childSeed(seed, i),
                denominationIndex: outDenoms[i],
                originCount: give[i],
                inkGene: inkGene,
                faceValueWei: Denominations.amountAt(outDenoms[i])
            });
        }
    }

    /// @dev Mirrors `Shapes._requireSplitSumMatches`.
    function _requireSplitSumMatches(uint256 parentBacking, uint8[] calldata outDenoms) private pure {
        uint256 sum;
        for (uint256 i = 0; i < outDenoms.length; ++i) {
            sum += Denominations.amountAt(outDenoms[i]);
        }
        if (sum != parentBacking) revert IShapes.SplitMismatch(parentBacking, sum);
    }

    /// @dev Mirrors `Shapes._allocateSplitOrigins`.
    function _allocateSplitOrigins(uint256 originCount, uint8[] calldata outDenoms)
        private
        pure
        returns (uint32[] memory give)
    {
        uint256 k = outDenoms.length;
        give = new uint32[](k);
        uint256 remaining = originCount;
        for (uint256 i = 0; i < k; ++i) {
            uint256 cap = Denominations.unitsAt(outDenoms[i]);
            uint256 g = remaining < cap ? remaining : cap;
            remaining -= g;
            give[i] = uint32(g);
        }
        // Sum of capacities == parentBacking/UNIT >= parent origin count, so the fill exhausts it.
        assert(remaining == 0);
    }

    /// @dev Mirrors `Shapes._childSeed`.
    function _childSeed(bytes32 parentSeed, uint256 childIndex) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentSeed, childIndex));
    }

    /* ------------------------------ unicodeCard ------------------------------ */

    /// @inheritdoc IShapeLens
    function unicodeCard(uint256 tokenId) external view returns (string memory) {
        uint8 denomIndex = shapes.denomIndexOf(tokenId);
        uint8 inkGene = shapes.inkGeneOf(tokenId);
        bytes memory modules = shapes.modulesOf(tokenId);
        uint256 amountWei = Denominations.amountAt(denomIndex);
        IShapeRenderer r = IShapeRenderer(shapes.renderer());
        if (modules.length != 0) {
            return r.renderUnicodeSampled(modules, amountWei, inkGene);
        }
        return r.renderUnicode(shapes.seedOf(tokenId), amountWei, inkGene);
    }

    /* --------------------------- provenance views ---------------------------- */

    /// @inheritdoc IShapeLens
    function composeRecordAt(uint256 survivorId, uint256 depth)
        external
        view
        returns (ComposeRecordView memory)
    {
        uint256 depthAvailable = shapes.composeDepth(survivorId);
        if (depth >= depthAvailable) {
            revert IShapes.ComposeRecordOutOfRange(survivorId, depth, depthAvailable);
        }

        (
            uint8 survivorDenomIndex,
            uint32 survivorOriginCount,
            uint8 survivorInkGene,
            bytes memory survivorModules,
            uint256 inputCount
        ) = shapes.composeRecordHeaderAt(survivorId, depth);

        ComposeInputView[] memory inputs = new ComposeInputView[](inputCount);
        for (uint256 i = 0; i < inputCount; ++i) {
            (
                uint256 id,
                bytes32 seed,
                uint8 denomIndex,
                uint32 originCount,
                uint8 inkGene,
                bytes memory modules
            ) = shapes.composeRecordInputAt(survivorId, depth, i);
            inputs[i] = ComposeInputView({
                id: id,
                seed: seed,
                denominationIndex: denomIndex,
                originCount: originCount,
                inkGene: inkGene,
                modules: modules
            });
        }

        return ComposeRecordView({
            survivorDenominationIndex: survivorDenomIndex,
            survivorOriginCount: survivorOriginCount,
            survivorInkGene: survivorInkGene,
            survivorModules: survivorModules,
            inputs: inputs
        });
    }

    /// @inheritdoc IShapeLens
    function splitOriginOf(uint256 childId)
        external
        view
        returns (
            bytes32 parentSeed,
            uint8 parentDenomIndex,
            uint8 parentInkGene,
            bytes memory parentModules,
            uint256 childIndex
        )
    {
        return shapes.splitOriginRaw(childId);
    }
}

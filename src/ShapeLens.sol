// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IShapes} from "./interfaces/IShapes.sol";
import {IShapeRenderer} from "./interfaces/IShapeRenderer.sol";
import {IShapeLens} from "./interfaces/IShapeLens.sol";
import {IShapePositionResolver} from "./interfaces/IShapePositionResolver.sol";
import {
    ComposeInputView,
    ComposeRecordView,
    ShapeChildPreview,
    ShapeState
} from "./interfaces/IShapeCapabilities.sol";
import {Denominations} from "./lib/Denominations.sol";
import {InkGenes} from "./lib/InkGenes.sol";
import {GeometrySampling} from "./lib/GeometrySampling.sol";
import {ComposeCompute} from "./lib/ComposeCompute.sol";
import {ShapeMath} from "./lib/ShapeMath.sol";

/// @title ShapeLens
/// @notice Read-only periphery for `Shapes`, deployed separately to keep the core token's runtime
///         bytecode under the EIP-170 size limit.
/// @dev Holds no state and no owner. Every view here reads token state through `Shapes`'s own
///      getters (`isBlack`, `seedOf`, `denomIndexOf`, `originCountOf`, `inkGeneOf`, `modulesOf`,
///      `composeDepth`, `composeRecordHeaderAt`, `composeRecordInputAt`) and recomputes its result
///      with the same externally linked libraries `Shapes` links and executes with
///      (`GeometrySampling`, `ComposeCompute`, `InkGenes`), so `previewCompose` and `previewSplit`
///      are bit-identical to what `Shapes.compose` / `Shapes.split` would produce, module bytes
///      included, and `shapeState` is bit-identical to what `Shapes` itself has stored. Reverts
///      propagate the same custom errors `Shapes` declares (`IShapes.TokenIsBlack`, and so on),
///      since this contract applies the identical validation before computing a result.
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
            formation: ShapeMath.formation(denomIndex, originCount, black),
            faceValueWei: faceValue,
            redeemableValueWei: black ? 0 : faceValue,
            modules: modules
        });
    }

    /* ----------------------------- previewCompose ---------------------------- */

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

        ShapeMath.BurnPoolAccum memory acc;
        uint256 survivorUnits = ShapeMath.initPool(acc, oldIndex, survivorOriginCount, survivorInkGene);

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
    function _accumulateBurnDonor(uint256 burnId, ShapeMath.BurnPoolAccum memory acc)
        private
        view
        returns (GeometrySampling.Donor memory donor)
    {
        uint8 denomIndex = shapes.denomIndexOf(burnId);
        bytes memory modules = shapes.modulesOf(burnId);
        uint32 originCount = uint32(shapes.originCountOf(burnId));
        bytes32 seed = shapes.seedOf(burnId);
        uint8 inkGene = shapes.inkGeneOf(burnId);

        uint256 units = ShapeMath.addDonor(acc, seed, denomIndex, originCount, inkGene);

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
        if (k < 2) revert IShapes.SplitTooFewOutputs();

        if (shapes.isBlack(tokenId)) revert IShapes.TokenIsBlack(tokenId); // also existence

        uint8 denomIndex = shapes.denomIndexOf(tokenId);
        uint32 originCount = uint32(shapes.originCountOf(tokenId));
        bytes32 seed = shapes.seedOf(tokenId);
        uint8 inkGene = shapes.inkGeneOf(tokenId);

        uint256 parentBacking = Denominations.amountAt(denomIndex);
        ShapeMath.requireSplitSumMatches(parentBacking, outDenoms);
        uint32[] memory give = ShapeMath.allocateSplitOrigins(originCount, outDenoms);

        // Split's sampling pool (SAMPLING_SPEC.md §6, D3'): the parent's top compose record's
        // donor pool when it has one (child-denomination-independent, built once and reused by
        // every child below), else grammar v1 at each child's own denomination (denomination-
        // dependent, read fresh per child by `sampleSplitChildFromPool`). Mirrors
        // `Shapes._splitTo`'s branch decision.
        uint256 depth = shapes.composeDepth(tokenId);
        bool hasRecordPool = depth > 0;
        bytes memory recordPool = hasRecordPool ? _splitRecordPool(tokenId, depth, seed) : bytes("");

        children = new ShapeChildPreview[](k);
        for (uint256 i = 0; i < k; ++i) {
            bytes memory childModules = GeometrySampling.sampleSplitChildFromPool(
                hasRecordPool, recordPool, seed, inkGene, outDenoms[i], i
            );
            children[i] = ShapeChildPreview({
                seed: ShapeMath.childSeed(seed, i),
                denominationIndex: outDenoms[i],
                originCount: give[i],
                inkGene: inkGene,
                faceValueWei: Denominations.amountAt(outDenoms[i]),
                modules: childModules
            });
        }
    }

    /// @dev Assembles a materialized-parent split's sampling pool from `parentId`'s top compose
    ///      record (SAMPLING_SPEC.md §6, D3'), mirroring `Shapes._buildSplitRecordPool`: the
    ///      record's pre-compose survivor effective modules first, then its inputs' effective
    ///      modules ascending by donor id. `depth` is `shapes.composeDepth(parentId)`; the top
    ///      record is at index `depth - 1`.
    function _splitRecordPool(uint256 parentId, uint256 depth, bytes32 parentSeed)
        private
        view
        returns (bytes memory)
    {
        (
            uint8 survivorDenomIndex,,
            uint8 survivorInkGene,,
            bytes memory survivorModules,
            uint256 inputCount
        ) = shapes.composeRecordHeaderAt(parentId, depth - 1);

        ComposeInputView[] memory inputs = _readComposeInputs(parentId, depth - 1, inputCount);
        GeometrySampling.Donor[] memory inputDonors = new GeometrySampling.Donor[](inputCount);
        for (uint256 i = 0; i < inputCount; ++i) {
            ComposeInputView memory inp = inputs[i];
            inputDonors[i] = GeometrySampling.Donor({
                id: inp.id,
                units: 0, // unused: split's pool concatenates every donor's modules, no weighting
                seed: inp.seed,
                denomIndex: inp.denominationIndex,
                inkGene: inp.inkGene,
                modules: inp.modules
            });
        }
        return GeometrySampling.buildSplitRecordPoolSorted(
            survivorModules, parentSeed, survivorDenomIndex, survivorInkGene, inputDonors
        );
    }

    /// @dev Reads every input of one compose record via `Shapes.composeRecordInputAt`. Shared by
    ///      `composeRecordAt` and `_splitRecordPool`.
    function _readComposeInputs(uint256 survivorId, uint256 depth, uint256 inputCount)
        private
        view
        returns (ComposeInputView[] memory inputs)
    {
        inputs = new ComposeInputView[](inputCount);
        for (uint256 i = 0; i < inputCount; ++i) {
            ComposeInputView memory inp = inputs[i];
            (inp.id, inp.seed, inp.denominationIndex, inp.originCount, inp.inkGene, inp.modules) =
                shapes.composeRecordInputAt(survivorId, depth, i);
        }
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
            uint96 rawOwnerTokenFrom,
            bytes memory survivorModules,
            uint256 inputCount
        ) = shapes.composeRecordHeaderAt(survivorId, depth);

        ComposeInputView[] memory inputs = _readComposeInputs(survivorId, depth, inputCount);

        return ComposeRecordView({
            survivorDenominationIndex: survivorDenomIndex,
            survivorOriginCount: survivorOriginCount,
            survivorInkGene: survivorInkGene,
            survivorModules: survivorModules,
            ownerTokenFrom: rawOwnerTokenFrom == 0 ? type(uint256).max : uint256(rawOwnerTokenFrom) - 1,
            inputs: inputs
        });
    }

    /// @inheritdoc IShapeLens
    function splitOriginOf(uint256 childId)
        external
        view
        returns (
            bytes32 parentSeed,
            uint256 parentId,
            uint8 parentDenomIndex,
            uint8 originDenomIndex,
            uint8 parentInkGene,
            bytes memory parentModules,
            uint256 childIndex
        )
    {
        return shapes.splitOriginRaw(childId);
    }

    /* --------------------------- denomination table --------------------------- */

    /// @inheritdoc IShapeLens
    /// @dev Moved off `Shapes` with the rest of this contract's periphery surface
    ///      (SAMPLING_SPEC.md §12): a pure denomination-table lookup with no dependency on token
    ///      state, kept here rather than on the core token to help it stay under the EIP-170
    ///      runtime size limit.
    function isSupportedDenomination(uint256 amountWei) external pure returns (bool) {
        return Denominations.isSupported(amountWei);
    }

    /// @inheritdoc IShapeLens
    function gridForAmount(uint256 amountWei) external pure returns (uint256 cols, uint256 rows) {
        return Denominations.gridAt(Denominations.requireIndexOf(amountWei));
    }

    /// @inheritdoc IShapeLens
    function modulesForAmount(uint256 amountWei) external pure returns (uint256) {
        (uint256 cols, uint256 rows) = Denominations.gridAt(Denominations.requireIndexOf(amountWei));
        return cols * rows;
    }

    /* ------------------------------ positionOf ------------------------------ */

    /// @dev Gas forwarded to the untrusted positions contract. Ample for a mapping read; bounds a
    ///      hostile target's ability to consume the caller's stipend.
    uint256 private constant POSITIONS_GAS = 50_000;

    /// @inheritdoc IShapeLens
    /// @dev The positions contract is untrusted. Reverts, out-of-gas and malformed address returns
    ///      are swallowed to zero. Its only power is to mislead callers of this view.
    function positionOf(uint256 tokenId) external view returns (address) {
        (address positions_,) = shapes.positions();
        if (positions_ == address(0)) return address(0);

        (bool success, bytes memory data) = positions_.staticcall{gas: POSITIONS_GAS}(
            abi.encodeCall(IShapePositionResolver.positionOf, (tokenId))
        );
        if (!success || data.length != 32) return address(0);

        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(data, 32))
        }
        if (word >> 160 != 0) return address(0);
        return address(uint160(word));
    }

    /* -------------------------------- exists --------------------------------- */

    /// @inheritdoc IShapeLens
    function exists(uint256 tokenId) external view returns (bool) {
        try shapes.ownerOf(tokenId) returns (address) {
            return true;
        } catch {
            return false;
        }
    }
}

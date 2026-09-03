// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IShapes} from "../interfaces/IShapes.sol";
import {ShapeFormation} from "../interfaces/IShapeCapabilities.sol";
import {Denominations} from "./Denominations.sol";

/// @title ShapeMath
/// @notice Pure computation shared between `Shapes` (execution) and `ShapeLens` (preview), so the
///         two cannot drift: `Shapes` calls these functions to act, `ShapeLens` calls the same
///         functions to predict the result of acting, without touching state.
/// @dev Internal-only library: every function inlines into its caller's bytecode at compile time,
///      so no address gets linked and no `DELEGATECALL`/`CALL` is added at any call site.
library ShapeMath {
    /// @dev Ink gene pool statistics (INK_GENES_IMPL_SPEC.md §2.3, §3.3) accumulated over
    ///      {survivor + burns}, plus the running compose backing total and origin count. Seeded by
    ///      `initPool` from the survivor's own contribution, then folded by `addDonor` once per
    ///      burned input.
    struct BurnPoolAccum {
        uint256 total;
        uint256 origins;
        uint256 burnSeedFold;
        uint8 best;
        uint8 worst;
        uint256 sumW;
        uint256 unitsTotal;
    }

    /// @notice A token's formation class from its denomination index, origin count and Black flag.
    function formation(uint8 denomIndex, uint32 originCount, bool black)
        internal
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

    /// @notice One split child's seed, derived from its parent's seed and its index among siblings.
    function childSeed(bytes32 parentSeed, uint256 childIndex) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentSeed, childIndex));
    }

    /// @notice Requires the summed backing of `outDenoms` equal `parentBacking`, or reverts
    ///         `IShapes.SplitMismatch`.
    function requireSplitSumMatches(uint256 parentBacking, uint8[] calldata outDenoms) internal pure {
        uint256 sum;
        for (uint256 i = 0; i < outDenoms.length; ++i) {
            sum += Denominations.amountAt(outDenoms[i]);
        }
        if (sum != parentBacking) revert IShapes.SplitMismatch(parentBacking, sum);
    }

    /// @notice Per-child origin-count allocation for a split: fills each output's capacity from
    ///         `originCount`, in order, until exhausted.
    function allocateSplitOrigins(uint256 originCount, uint8[] calldata outDenoms)
        internal
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

    /// @notice Seeds `acc` from the compose survivor's own contribution, before any burned input is
    ///         folded in. Returns the survivor's unit count, which the caller also needs for its
    ///         own `Donor` snapshot.
    function initPool(BurnPoolAccum memory acc, uint8 denomIndex, uint256 originCount, uint8 inkGene)
        internal
        pure
        returns (uint256 units)
    {
        units = Denominations.unitsAt(denomIndex);
        acc.total = Denominations.amountAt(denomIndex);
        acc.origins = originCount;
        acc.best = inkGene;
        acc.worst = inkGene;
        acc.sumW = uint256(inkGene) * units;
        acc.unitsTotal = units;
    }

    /// @notice Folds one burned compose input into `acc` and returns its unit count.
    /// @dev Fold order-invariantly (XOR) on `burnSeedFold`, so burnIds calldata order cannot affect
    ///      the gene.
    function addDonor(
        BurnPoolAccum memory acc,
        bytes32 seed,
        uint8 denomIndex,
        uint256 originCount,
        uint8 inkGene
    ) internal pure returns (uint256 units) {
        acc.total += Denominations.amountAt(denomIndex);
        acc.origins += originCount;
        acc.burnSeedFold ^= uint256(seed);
        if (inkGene > acc.best) acc.best = inkGene;
        if (inkGene < acc.worst) acc.worst = inkGene;
        units = Denominations.unitsAt(denomIndex);
        acc.sumW += uint256(inkGene) * units;
        acc.unitsTotal += units;
    }
}

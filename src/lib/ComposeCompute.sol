// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GeometrySampling} from "./GeometrySampling.sol";
import {InkGenes} from "./InkGenes.sol";

/// @title ComposeCompute
/// @notice The two consensus-critical compose computations, module sampling and ink gene
///         assignment, in one call.
/// @dev External library: forge deploys this separately and links its address into `Shapes` at
///      deploy time, the same mechanism as `GeometrySampling` and `InkGenes`. `Shapes` calls this
///      once per compose instead of separately calling `GeometrySampling.sampleComposeSorted` and
///      `InkGenes.geneAtCompose`, so `_compose` and `_previewCompose` cross one external call
///      boundary instead of two. The link is fixed in `Shapes`'s bytecode with no setter.
library ComposeCompute {
    /// @notice `InkGenes.geneAtCompose` and `GeometrySampling.sampleComposeSorted` over the same
    ///         donor pool, returned together.
    /// @dev The survivor's seed, pre-compose denomination and pre-compose gene come from
    ///      `survivor` itself (`seed`, `denomIndex`, `inkGene`) rather than as separate
    ///      parameters, since the caller already has them there.
    function composeSampleAndGene(
        GeometrySampling.Donor memory survivor,
        GeometrySampling.Donor[] memory burnDonors,
        uint256 burnSeedFold,
        uint8 newIndex,
        uint8 best,
        uint8 worst,
        uint8 centerGene
    ) public pure returns (uint8 newGene, bytes memory sampled) {
        newGene = InkGenes.geneAtCompose(
            survivor.seed,
            burnSeedFold,
            survivor.inkGene,
            survivor.denomIndex,
            newIndex,
            best,
            worst,
            centerGene
        );
        sampled = GeometrySampling.sampleComposeSorted(survivor, burnDonors, burnSeedFold, newIndex);
    }
}

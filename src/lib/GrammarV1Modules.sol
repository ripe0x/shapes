// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Round03Rand} from "./Round03Rand.sol";
import {Denominations} from "./Denominations.sol";
import {InkGenes} from "./InkGenes.sol";
import {ModuleCodec} from "./ModuleCodec.sol";

/// @title GrammarV1Modules
/// @notice The module-identity byte sequence for an original (non-materialized) token under
///         grammar v1, without deriving position, size or weight.
/// @dev Mirrors `ShapeRenderer.compose()`'s draw order exactly: one discarded card-level fill
///      draw, then per cell kind, solid, rotation (rotation only for kinds with more than one
///      orientation). A dedicated implementation rather than a call into `ShapeRenderer`: module
///      sampling runs inside `Shapes`, and a compose result must not depend on the owner-
///      replaceable renderer address. Consensus-critical: any change here changes materialized
///      geometry for every future compose and split.
library GrammarV1Modules {
    using Round03Rand for Round03Rand.Stream;

    /// @notice The full module-identity byte sequence for `(seed, denomIndex, inkGene)`, in
    ///         row-major grid order, encoded per `ModuleCodec`.
    function all(bytes32 seed, uint256 denomIndex, uint8 inkGene) internal pure returns (bytes memory out) {
        (uint256 cols, uint256 rows) = Denominations.gridAt(denomIndex);
        uint256 n = cols * rows;
        Round03Rand.Stream memory rnd = Round03Rand.init(seed);
        rnd.nextWad(); // card-level fill draw, discarded: the ink gene supersedes it

        uint256 solidProbability = InkGenes.geneProbabilityAt(inkGene);
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 kind = rnd.nextBelow(ModuleCodec.KIND_COUNT);
            bool solid = rnd.nextBelowProbability(solidProbability);
            uint256 rc = ModuleCodec.rotCount(kind);
            uint256 rotIndex = rc > 1 ? rnd.nextBelow(rc) : 0;
            out[i] = ModuleCodec.encode(kind, solid, rotIndex);
        }
    }
}

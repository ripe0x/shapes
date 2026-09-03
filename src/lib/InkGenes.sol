// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title InkGenes
/// @notice The seven-state ink gene: mint assignment, the compose inheritance walk, and the
///         units-weighted pool statistic the walk steps toward.
/// @dev A direct port of `preview/src/canonical/ink.ts`. The parity suite asserts the two agree
///      byte for byte, the same way `Denominations` and `denominations.ts` are kept in lockstep.
///      Pure library, no storage. See INK_GENES_IMPL_SPEC.md for the pinned formulas and
///      INK_GENES_DRAFT.md for the design rationale.
///
///      `geneAtMint` and `geneAtCompose` are `public`: forge deploys this library separately and
///      links its address into `Shapes` at deploy time, the same mechanism as `GeometrySampling`.
///      The link is fixed in `Shapes`'s bytecode with no setter, so gene assignment cannot be
///      redirected to different logic after deployment.
library InkGenes {
    uint256 internal constant GENE_COUNT = 7;

    uint8 internal constant VOID = 0;
    uint8 internal constant FAINT = 1;
    uint8 internal constant SPARSE = 2;
    uint8 internal constant MURK = 3;
    uint8 internal constant DENSE = 4;
    uint8 internal constant RICH = 5;
    uint8 internal constant SOLID = 6;

    uint256 internal constant WAD = 1e18;

    error InvalidGene(uint256 gene);

    /// @dev `{gene, units}` over the multiset a compose pools together. Declared for interface
    ///      symmetry with the design draft; the compose loop in `Shapes.sol` folds `sumW`/`units`
    ///      inline over live storage rather than materialising an array of these.
    struct InkInput {
        uint8 gene;
        uint256 units;
    }

    /// @notice Rendered solid probability for a gene, WAD (1e18). Mirrors `GENE_PROBABILITY` in
    ///         `ink.ts`.
    function geneProbabilityAt(uint256 gene) internal pure returns (uint256) {
        if (gene == VOID) return 0;
        if (gene == FAINT) return 0.15e18;
        if (gene == SPARSE) return 0.35e18;
        if (gene == MURK) return 0.5e18;
        if (gene == DENSE) return 0.65e18;
        if (gene == RICH) return 0.85e18;
        if (gene == SOLID) return WAD;
        revert InvalidGene(gene);
    }

    /// @notice Display name for a gene, for the `Ink` metadata trait. Mirrors `GENE_NAMES`.
    function geneNameAt(uint256 gene) internal pure returns (string memory) {
        if (gene == VOID) return "Void";
        if (gene == FAINT) return "Faint";
        if (gene == SPARSE) return "Sparse";
        if (gene == MURK) return "Murk";
        if (gene == DENSE) return "Dense";
        if (gene == RICH) return "Rich";
        if (gene == SOLID) return "Solid";
        revert InvalidGene(gene);
    }

    /// @notice Gene assigned at mint: a pure function of the token's seed and denomination tier.
    /// @dev Dust (denomIndex 0) draws the full seven-gene lottery; every other direct mint draws
    ///      only the narrow {Sparse, Murk, Dense} band. The extremes (Void, Faint, Rich, Solid)
    ///      enter the population only through a dust mint (INK_GENES_DRAFT.md §2).
    function geneAtMint(bytes32 seed, uint8 denomIndex) public pure returns (uint8) {
        uint256 r = uint256(keccak256(abi.encodePacked("ink:mint", seed))) % 100;

        if (denomIndex == 0) {
            if (r < 3) return VOID;
            if (r < 10) return FAINT;
            if (r < 25) return SPARSE;
            if (r < 75) return MURK;
            if (r < 90) return DENSE;
            if (r < 97) return RICH;
            return SOLID;
        }

        if (r < 20) return SPARSE;
        if (r < 80) return MURK;
        return DENSE;
    }

    /// @notice Units-weighted mean gene over the multiset {survivor + all burns}, rounded half
    ///         up.
    /// @dev `sumW = Σ gene_i × units_i`, `units = Σ units_i`, both accumulated by the caller
    ///      over the pool. Worked example (impl spec §2.3): survivor Solid(6) dust (1 unit) +
    ///      four burns Murk(3) dust (1 unit each): sumW = 6 + 12 = 18, units = 5,
    ///      center = (36 + 5) / 10 = 4 (Dense): the true mean 3.6 rounds up.
    function center(uint256 sumW, uint256 units) internal pure returns (uint8) {
        return uint8((2 * sumW + units) / (2 * units));
    }

    /// @notice The per-tier compose walk: steps the survivor's gene, one tier at a time, toward
    ///         `center`, `best` or `worst` depending on a per-tier roll.
    /// @dev `burnSeedFold` is the XOR of every burned token's `uint256(seed)`, so the order
    ///      `burnIds` arrive in cannot affect the result: XOR is commutative and associative,
    ///      so any permutation folds to the same value. Fresh entropy is forbidden: `R` and
    ///      every per-tier roll are pure functions of the arguments alone. A homogeneous pool
    ///      (`best == worst == center == survivorGene`) is a no-op by construction; the loop
    ///      needs no special case for it.
    function geneAtCompose(
        bytes32 survivorSeed,
        uint256 burnSeedFold,
        uint8 survivorGene,
        uint8 oldIndex,
        uint8 newIndex,
        uint8 best,
        uint8 worst,
        uint8 centerGene
    ) public pure returns (uint8 g) {
        bytes32 R = keccak256(abi.encodePacked("ink:compose", survivorSeed, burnSeedFold, newIndex));
        g = survivorGene;
        uint256 t = uint256(newIndex) - uint256(oldIndex); // always >= 1
        for (uint256 k = 1; k <= t; ++k) {
            uint256 roll = uint256(keccak256(abi.encodePacked(R, k))) % 100;
            uint8 target = roll < 70 ? centerGene : roll < 90 ? best : worst;
            if (g < target) g += 1;
            else if (g > target) g -= 1;
            // equal: unchanged
        }
    }
}

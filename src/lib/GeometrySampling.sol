// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Round03Rand} from "./Round03Rand.sol";
import {Denominations} from "./Denominations.sol";
import {GrammarV1Modules} from "./GrammarV1Modules.sol";

/// @title GeometrySampling
/// @notice The compose and split module-sampling procedures (SAMPLING_SPEC.md §5, §6).
/// @dev Pure library, no storage. `Shapes` assembles a `Donor` array from its own storage and
///      the in-flight compose record snapshot, then calls `sampleCompose`; the same call from
///      `_compose` and `_previewCompose` on identical donor state returns identical bytes, so
///      preview and execution agree without `previewCompose` touching state.
///
///      `sortDonorsById`, `sampleCompose`, `sampleSplitChild` and `effectiveModulesOf` are
///      `public`: forge deploys this library separately and links its address into every
///      contract that calls them, instead of inlining the logic into each caller. The link is
///      resolved at compile/deploy time and baked into the caller's bytecode as a fixed address;
///      there is no setter for it anywhere, so a compose or split result cannot be redirected to
///      different sampling logic after deployment.
library GeometrySampling {
    using Round03Rand for Round03Rand.Stream;

    /// @dev One compose donor: the survivor or one burned input. `id` orders the burn subset
    ///      (ascending) so calldata order cannot affect the result; the survivor is placed first
    ///      by the caller regardless of its id. `modules` is the donor's stored materialized
    ///      bytes, empty when the donor's geometry derives from `seed` under grammar v1.
    struct Donor {
        uint256 id;
        uint256 units;
        bytes32 seed;
        uint8 denomIndex;
        uint8 inkGene;
        bytes modules;
    }

    /// @notice A donor's effective module array: its stored bytes if materialized, otherwise the
    ///         grammar v1 sequence derived from its seed and denomination.
    function effectiveModules(Donor memory d) internal pure returns (bytes memory) {
        if (d.modules.length != 0) return d.modules;
        return GrammarV1Modules.all(d.seed, d.denomIndex, d.inkGene);
    }

    /// @notice A parent's effective module array for split, given its stored materialized bytes
    ///         (empty if none) and its seed-derived identity.
    function effectiveModulesOf(bytes memory materialized, bytes32 seed, uint8 denomIndex, uint8 inkGene)
        public
        pure
        returns (bytes memory)
    {
        if (materialized.length != 0) return materialized;
        return GrammarV1Modules.all(seed, denomIndex, inkGene);
    }

    /// @notice Sort the burn-side donors ascending by token id. Stable, iterative bottom-up
    ///         merge sort: O(n log n) with no recursion, safe at the burn counts a single
    ///         compose call can reach.
    /// @dev `public`: an external call ABI-copies `arr` into the library's own memory, so the
    ///      sort only takes effect on the copy this function returns. Callers must reassign
    ///      their array from the return value; mutating the caller's original in place is not
    ///      possible across the call boundary.
    function sortDonorsById(Donor[] memory arr) public pure returns (Donor[] memory) {
        uint256 n = arr.length;
        if (n < 2) return arr;
        Donor[] memory buf = new Donor[](n);
        for (uint256 width = 1; width < n; width *= 2) {
            for (uint256 lo = 0; lo < n; lo += 2 * width) {
                uint256 mid = lo + width < n ? lo + width : n;
                uint256 hi = lo + 2 * width < n ? lo + 2 * width : n;
                _merge(arr, buf, lo, mid, hi);
            }
        }
        return arr;
    }

    function _merge(Donor[] memory arr, Donor[] memory buf, uint256 lo, uint256 mid, uint256 hi)
        private
        pure
    {
        uint256 i = lo;
        uint256 j = mid;
        uint256 k = lo;
        while (i < mid && j < hi) {
            if (arr[i].id <= arr[j].id) {
                buf[k++] = arr[i++];
            } else {
                buf[k++] = arr[j++];
            }
        }
        while (i < mid) buf[k++] = arr[i++];
        while (j < hi) buf[k++] = arr[j++];
        for (uint256 x = lo; x < hi; ++x) {
            arr[x] = buf[x];
        }
    }

    /// @notice Sample a compose survivor's new module array (SAMPLING_SPEC.md §5).
    /// @dev `donors` must already be in canonical order: the survivor at index 0, then burns
    ///      ascending by id (`sortDonorsById` on the burn subset before prepending the
    ///      survivor). Donor choice is units-weighted with replacement; module choice within a
    ///      donor is uniform with replacement.
    function sampleCompose(Donor[] memory donors, bytes32 survivorSeed, uint256 burnSeedFold, uint8 newIndex)
        public
        pure
        returns (bytes memory result)
    {
        uint256 totalUnits;
        for (uint256 i = 0; i < donors.length; ++i) {
            totalUnits += donors[i].units;
        }

        Round03Rand.Stream memory rnd = Round03Rand.init(
            keccak256(abi.encodePacked("Shapes/sample/v1", survivorSeed, burnSeedFold, newIndex))
        );

        (uint256 cols, uint256 rows) = Denominations.gridAt(newIndex);
        uint256 n = cols * rows;
        result = new bytes(n);

        for (uint256 j = 0; j < n; ++j) {
            uint256 d = rnd.nextBelow(totalUnits);
            uint256 cum;
            uint256 donorIdx;
            for (uint256 i = 0; i < donors.length; ++i) {
                cum += donors[i].units;
                if (d < cum) {
                    donorIdx = i;
                    break;
                }
            }
            bytes memory mods = effectiveModules(donors[donorIdx]);
            uint256 k = rnd.nextBelow(mods.length);
            result[j] = mods[k];
        }
    }

    /// @notice Sort the burn-side donors, prepend the survivor, and sample the compose result in
    ///         one call.
    /// @dev Equivalent to `sortDonorsById(burnDonors)` followed by `sampleCompose` on the
    ///      survivor prepended to the sorted result, but as a single external call from `Shapes`
    ///      instead of two: the sort and the donor-array assembly happen in this library's own
    ///      call frame, so `Shapes` sends the unsorted burn donors once and gets the sampled
    ///      bytes back directly. The survivor's seed comes from `survivor.seed` rather than a
    ///      separate parameter.
    function sampleComposeSorted(
        Donor memory survivor,
        Donor[] memory burnDonors,
        uint256 burnSeedFold,
        uint8 newIndex
    ) public pure returns (bytes memory) {
        burnDonors = sortDonorsById(burnDonors);
        Donor[] memory donors = new Donor[](burnDonors.length + 1);
        donors[0] = survivor;
        for (uint256 i = 0; i < burnDonors.length; ++i) {
            donors[i + 1] = burnDonors[i];
        }
        return sampleCompose(donors, survivor.seed, burnSeedFold, newIndex);
    }

    /// @notice Sample one split child's module array from its parent's effective modules
    ///         (SAMPLING_SPEC.md §6). Uniform over the parent's modules, with replacement: a
    ///         single donor, so no units weighting.
    function sampleSplitChild(
        bytes memory parentModules,
        bytes32 parentSeed,
        uint8 childDenom,
        uint256 childIndex
    ) public pure returns (bytes memory result) {
        Round03Rand.Stream memory rnd = Round03Rand.init(
            keccak256(abi.encodePacked("Shapes/sample-split/v1", parentSeed, childDenom, uint8(childIndex)))
        );

        (uint256 cols, uint256 rows) = Denominations.gridAt(childDenom);
        uint256 n = cols * rows;
        result = new bytes(n);
        uint256 m = parentModules.length;
        for (uint256 j = 0; j < n; ++j) {
            uint256 k = rnd.nextBelow(m);
            result[j] = parentModules[k];
        }
    }
}

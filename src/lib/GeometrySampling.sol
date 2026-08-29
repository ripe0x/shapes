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
///      `sortDonorsById`, `sampleCompose`, `sampleSplitChild`, `effectiveModulesOf`,
///      `grammarSplitPool`, `buildSplitRecordPool`, `buildSplitRecordPoolSorted` and
///      `sampleSplitChildFromPool` are `public`: forge deploys this library
///      separately and links its address into every contract that calls them, instead of
///      inlining the logic into each caller. The link is resolved at compile/deploy time and
///      baked into the caller's bytecode as a fixed address; there is no setter for it
///      anywhere, so a compose or split result cannot be redirected to different sampling
///      logic after deployment.
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

    /// @notice A token's effective module array given its stored materialized bytes (empty if
    ///         none) and its seed-derived identity. Used for informational snapshots (the
    ///         `SplitRecord.parentModules` field) and for a compose record's donor-side effective
    ///         modules; not used for split's own sampling pool (SAMPLING_SPEC.md section 6, D3'),
    ///         which never falls back to a parent's own materialized bytes.
    function effectiveModulesOf(bytes memory materialized, bytes32 seed, uint8 denomIndex, uint8 inkGene)
        public
        pure
        returns (bytes memory)
    {
        if (materialized.length != 0) return materialized;
        return GrammarV1Modules.all(seed, denomIndex, inkGene);
    }

    /// @notice A recordless split's sampling pool (SAMPLING_SPEC.md section 6, D3'): the parent
    ///         seed's grammar v1 expression at the CHILD's own denomination, under the parent's
    ///         ink gene. Ignores the parent's own materialized modules entirely, even when the
    ///         parent is materialized (a split child being split again with no compose record of
    ///         its own): the pool depends on the child's denomination, not the parent's stored
    ///         geometry, so it is built once per distinct child denomination in a split, not once
    ///         per split call.
    function grammarSplitPool(bytes32 parentSeed, uint8 childDenom, uint8 parentInkGene)
        public
        pure
        returns (bytes memory)
    {
        return GrammarV1Modules.all(parentSeed, childDenom, parentInkGene);
    }

    /// @notice A materialized-parent split's sampling pool (SAMPLING_SPEC.md section 6, D3'):
    ///         the parent's top compose record's donor modules, concatenated in canonical order —
    ///         the record's pre-compose survivor first, then its inputs. Child-denomination-
    ///         independent: built once per split call, shared by every child regardless of
    ///         `outDenoms`.
    /// @dev `sortedInputs` must already be sorted ascending by `id` (`sortDonorsById`); this
    ///      function does not sort. `rec.inputs` is stored in calldata order (`_compose` pushes
    ///      in loop order), so the caller must sort before calling, or the split result would
    ///      depend on the compose's original burnIds calldata order, breaking burn-order
    ///      independence.
    function buildSplitRecordPool(
        bytes memory survivorModules,
        bytes32 survivorSeed,
        uint8 survivorDenomIndex,
        uint8 survivorInkGene,
        Donor[] memory sortedInputs
    ) public pure returns (bytes memory pool) {
        bytes memory survivorEff =
            effectiveModulesOf(survivorModules, survivorSeed, survivorDenomIndex, survivorInkGene);

        bytes[] memory inputEff = new bytes[](sortedInputs.length);
        uint256 total = survivorEff.length;
        for (uint256 i = 0; i < sortedInputs.length; ++i) {
            inputEff[i] = effectiveModules(sortedInputs[i]);
            total += inputEff[i].length;
        }

        pool = new bytes(total);
        uint256 o;
        for (uint256 i = 0; i < survivorEff.length; ++i) {
            pool[o++] = survivorEff[i];
        }
        for (uint256 i = 0; i < inputEff.length; ++i) {
            bytes memory im = inputEff[i];
            for (uint256 j = 0; j < im.length; ++j) {
                pool[o++] = im[j];
            }
        }
    }

    /// @notice Sort `inputs` ascending by id and build a split record's pool in one call
    ///         (SAMPLING_SPEC.md section 6, D3'). Equivalent to `sortDonorsById(inputs)` followed
    ///         by `buildSplitRecordPool`, but as a single external call from `Shapes` instead of
    ///         two: `Shapes._buildSplitRecordPool` sends the unsorted record inputs once and gets
    ///         the pool bytes back directly, the same consolidation `sampleComposeSorted` applies
    ///         to compose's sort-then-sample.
    function buildSplitRecordPoolSorted(
        bytes memory survivorModules,
        bytes32 survivorSeed,
        uint8 survivorDenomIndex,
        uint8 survivorInkGene,
        Donor[] memory inputs
    ) public pure returns (bytes memory) {
        inputs = sortDonorsById(inputs);
        return buildSplitRecordPool(survivorModules, survivorSeed, survivorDenomIndex, survivorInkGene, inputs);
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

    /// @notice Sample a compose survivor's new module array (SAMPLING_SPEC.md §5, decision D1′).
    /// @dev `donors` must already be in canonical order: the survivor at index 0, then burns
    ///      ascending by id (`sortDonorsById` on the burn subset before prepending the
    ///      survivor). Donor choice is units-weighted, with replacement. Module choice within a
    ///      donor is uniform over that donor's not-yet-used modules, without replacement: each
    ///      donor module contributes to at most one result cell, so compose provenance is
    ///      injective at the cell level. `consumedMask[i]` is a bitmask over `mods[i]`, one bit
    ///      per module index, up to 25 modules (denomination index 0) so it fits a `uint256`
    ///      with room to spare.
    ///
    ///      A donor's `remaining` count can never reach zero while it is still being drawn from:
    ///      every donor's `amountAt` is strictly below the result's (a compose merges two or
    ///      more positive-value donors into one higher-value survivor), and `Denominations.gridAt`
    ///      is strictly decreasing in denomination index, so every donor's module count is at
    ///      least the result's cell count. Total draws equal the result's cell count. See
    ///      SAMPLING_SPEC.md §10 invariant 6.
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

        // Cache each donor's effective modules once, and its consumption state, before the cell
        // loop: consumption is stateful across cells, so the modules must stay stable per donor
        // rather than being recomputed (and re-derived, for a seed-derived donor) every cell.
        bytes[] memory mods = new bytes[](donors.length);
        uint256[] memory consumedMask = new uint256[](donors.length);
        uint256[] memory remaining = new uint256[](donors.length);
        for (uint256 i = 0; i < donors.length; ++i) {
            mods[i] = effectiveModules(donors[i]);
            remaining[i] = mods[i].length;
        }

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

            uint256 k = rnd.nextBelow(remaining[donorIdx]);
            uint256 mask = consumedMask[donorIdx];
            bytes memory donorMods = mods[donorIdx];
            uint256 unusedSeen;
            uint256 moduleIdx;
            for (uint256 m = 0; m < donorMods.length; ++m) {
                if ((mask >> m) & 1 == 0) {
                    if (unusedSeen == k) {
                        moduleIdx = m;
                        break;
                    }
                    ++unusedSeen;
                }
            }

            consumedMask[donorIdx] = mask | (1 << moduleIdx);
            --remaining[donorIdx];
            result[j] = donorMods[moduleIdx];
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

    /// @notice Sample one split child's module array from the split's pool (SAMPLING_SPEC.md
    ///         §6, D3'). Uniform over `pool`, with replacement: `pool` is either a compose
    ///         record's concatenated donor modules or a grammar v1 expression, never more than one
    ///         donor's worth of state, so no units weighting. `moduleIndex` as reported/traced is
    ///         the index into `pool` the byte was drawn from.
    /// @dev `childIndex` enters the stream as a full uint256, matching the untruncated index
    ///      `Shapes._childSeed` uses. Encoding it as a uint8 would give children at index i and
    ///      i + 256 of the same parent at the same denomination an identical stream, and so
    ///      identical stored modules. `pool` is unrelated to `childDenom`'s own grid size in the
    ///      record branch (it is the record donors' combined module count); in the grammar branch
    ///      the caller builds it sized to `childDenom`'s own grid via `grammarSplitPool`.
    function sampleSplitChild(bytes memory pool, bytes32 parentSeed, uint8 childDenom, uint256 childIndex)
        public
        pure
        returns (bytes memory result)
    {
        Round03Rand.Stream memory rnd = Round03Rand.init(
            keccak256(abi.encodePacked("Shapes/sample-split/v1", parentSeed, childDenom, childIndex))
        );

        (uint256 cols, uint256 rows) = Denominations.gridAt(childDenom);
        uint256 n = cols * rows;
        result = new bytes(n);
        uint256 m = pool.length;
        for (uint256 j = 0; j < n; ++j) {
            uint256 k = rnd.nextBelow(m);
            result[j] = pool[k];
        }
    }

    /// @notice Pick the split pool and sample one child in one call (SAMPLING_SPEC.md §6, D3').
    ///         `hasRecordPool` selects `recordPool` (already built once per split call by the
    ///         caller, the same array for every child) when true, else the grammar pool at
    ///         `childDenom` (built fresh here, since that pool depends on `childDenom`). As a
    ///         single external call from `Shapes._splitTo`'s per-child loop instead of two
    ///         (`grammarSplitPool` then `sampleSplitChild`), the same consolidation
    ///         `sampleComposeSorted` and `buildSplitRecordPoolSorted` apply elsewhere in this
    ///         library: `Shapes`'s own bytecode only needs the one call-site's worth of ABI
    ///         encoding/decoding, material to staying under the EIP-170 runtime size limit.
    function sampleSplitChildFromPool(
        bool hasRecordPool,
        bytes memory recordPool,
        bytes32 parentSeed,
        uint8 parentInkGene,
        uint8 childDenom,
        uint256 childIndex
    ) public pure returns (bytes memory) {
        bytes memory pool = hasRecordPool ? recordPool : grammarSplitPool(parentSeed, childDenom, parentInkGene);
        return sampleSplitChild(pool, parentSeed, childDenom, childIndex);
    }
}

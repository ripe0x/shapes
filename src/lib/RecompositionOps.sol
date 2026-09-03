// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IShapes} from "../interfaces/IShapes.sol";
import {
    ComposeInput,
    ComposeInputView,
    ComposeRecord,
    ComposeRecordView,
    ShapeChildPreview,
    ShapeData,
    ShapeState,
    ShapeStore,
    SplitOriginRef,
    SplitRecord
} from "../ShapeTypes.sol";
import {ComposeCompute} from "./ComposeCompute.sol";
import {Denominations} from "./Denominations.sol";
import {GeometrySampling} from "./GeometrySampling.sol";
import {InkGenes} from "./InkGenes.sol";
import {ShapeMath} from "./ShapeMath.sol";

/// @title RecompositionOps
/// @notice The compose, decompose and split state machine, the previews of compose and split, and
///         the decoded reads over the state they write.
/// @dev Public library called through `DELEGATECALL` from `Shapes`, so it reads and writes
///      `Shapes`'s storage and emits `Shapes`'s events from `Shapes`'s address. Each function is
///      named after the `Shapes` entrypoint whose body it holds.
///
///      Boundaries, all relied on by the reserve invariant and by `Shapes`'s access control:
///
///      - No authority. `Shapes` applies the ownership gate before delegating here.
///      - No ERC-721 writes. Minting and burning execute in `Shapes`'s own runtime, so nothing
///        here can move a token.
///      - No ETH. Recomposition never changes total backing, so `redeemableBacking` is not in
///        `ShapeStore` and cannot be reached from here.
///      - No collection ownership. The owner token id is not in `ShapeStore`; `Shapes` moves it.
///      - One storage pointer. `ShapeStore` is the whole of what this library can write.
///
///      `Shapes`'s address is linked into its bytecode at deploy time with no setter, so a call
///      into this library cannot be redirected afterwards.
library RecompositionOps {
    /* ------------------------------ validation ------------------------------ */

    /// @notice Reverts unless `account` holds `tokenId` and the token is not Black.
    /// @dev The gate every recomposition applies to a token it is about to consume. `tokenOwner`
    ///      is the token's ERC-721 owner, read by the caller: `Shapes` reads it directly, a
    ///      preview reads it back through `ownerOf`. Shared so an execution path and its preview
    ///      cannot apply different rules.
    function requireLiveOwner(ShapeStore storage st, uint256 tokenId, address tokenOwner, address account)
        internal
        view
    {
        if (tokenOwner != account) revert IShapes.NotShapeOwner(tokenId, account);
        if (st.shapes[tokenId].isBlack) revert IShapes.TokenIsBlack(tokenId);
    }

    /// @notice Reverts unless `burnId` may be burned into `survivorId` by `account`.
    /// @dev Everything compose requires of one input: it is not the survivor itself, `account`
    ///      holds it, and it is not Black.
    function requireComposeInput(
        ShapeStore storage st,
        uint256 survivorId,
        uint256 burnId,
        address tokenOwner,
        address account
    ) internal view {
        if (burnId == survivorId) revert IShapes.CannotComposeWithSelf(burnId);
        requireLiveOwner(st, burnId, tokenOwner, account);
    }

    /// @notice Reverts `DuplicateComposeInput` if any token id appears twice in `ids`.
    /// @dev Sorts a memory copy with a bottom-up merge sort and rejects adjacent equals, so the
    ///      cost is O(n log n) and the answer does not depend on where the repeat sits. `compose`
    ///      would already fail on the repeat, because `_burn` reverts on the second occurrence of
    ///      an id it has already burned. This runs first for the named error, and so that
    ///      `previewCompose`, which burns nothing, rejects the same input with the same error.
    function requireDistinctComposeInputs(uint256[] calldata ids) public pure {
        uint256 n = ids.length;
        if (n < 2) return;

        uint256[] memory a = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            a[i] = ids[i];
        }
        uint256[] memory buf = new uint256[](n);

        for (uint256 width = 1; width < n; width <<= 1) {
            for (uint256 lo = 0; lo < n; lo += width << 1) {
                uint256 mid = lo + width;
                if (mid > n) mid = n;
                uint256 hi = mid + width;
                if (hi > n) hi = n;
                uint256 i = lo;
                uint256 j = mid;
                uint256 k = lo;
                while (i < mid && j < hi) {
                    buf[k++] = a[i] <= a[j] ? a[i++] : a[j++];
                }
                while (i < mid) {
                    buf[k++] = a[i++];
                }
                while (j < hi) {
                    buf[k++] = a[j++];
                }
            }
            (a, buf) = (buf, a);
        }

        for (uint256 i = 1; i < n; ++i) {
            if (a[i] == a[i - 1]) revert IShapes.DuplicateComposeInput(a[i]);
        }
    }

    /* -------------------------------- compose ------------------------------- */

    /// @notice Body of `Shapes.compose`: record the inputs, fold them into the survivor, and write
    ///         the survivor's new denomination, origin count, ink gene and sampled geometry.
    /// @dev `Shapes` has already rejected repeats, gated every token and burned each input, so
    ///      each `burnIds` entry is a token the caller owned and this call still has the state of.
    ///      `ownerTokenFrom` is the owner token's id plus one when one of the inputs held
    ///      collection ownership, else zero; it is stored so `decompose` can hand ownership back.
    function compose(
        ShapeStore storage st,
        uint256 survivorId,
        uint256[] calldata burnIds,
        uint96 ownerTokenFrom
    ) public {
        uint256 n = burnIds.length;
        ShapeData storage s = st.shapes[survivorId];

        // Read before the loop, so nothing consumed inside it can affect these values.
        uint8 oldIndex = s.denomIndex;
        ShapeMath.BurnPoolAccum memory acc;
        uint256 survivorUnits = ShapeMath.initPool(acc, oldIndex, s.originCount, s.inkGene);

        // `decompose` pops this record and restores exactly these values.
        ComposeRecord storage rec = st.composeStack[survivorId].push();
        rec.survivorDenomIndex = oldIndex;
        rec.survivorOriginCount = uint32(s.originCount);
        rec.survivorInkGene = s.inkGene;
        rec.survivorModules = st.modules[survivorId];
        rec.ownerTokenFrom = ownerTokenFrom;

        // Donor snapshots for module sampling, collected in calldata order. Sorted by id below so
        // compose output does not depend on the caller's burnIds order. See SAMPLING_SPEC.md.
        GeometrySampling.Donor[] memory burnDonors = new GeometrySampling.Donor[](n);

        for (uint256 i = 0; i < n; ++i) {
            uint256 burnId = burnIds[i];
            ShapeData storage b = st.shapes[burnId];
            bytes memory burnModules = st.modules[burnId];

            uint256 bUnits = ShapeMath.addDonor(acc, b.seed, b.denomIndex, b.originCount, b.inkGene);
            burnDonors[i] = GeometrySampling.Donor({
                id: burnId,
                units: bUnits,
                seed: b.seed,
                denomIndex: b.denomIndex,
                inkGene: b.inkGene,
                modules: burnModules
            });

            // Snapshot the input verbatim. Re-minted by `decompose` under this id.
            rec.inputs
                .push(
                    ComposeInput({
                        seed: b.seed,
                        id: uint96(burnId),
                        originCount: b.originCount,
                        denomIndex: b.denomIndex,
                        inkGene: b.inkGene,
                        modules: burnModules
                    })
                );

            delete st.shapes[burnId];
            delete st.modules[burnId];
        }

        // The summed backing must land on a denomination, or the composition is rejected.
        uint256 newIndex = Denominations.requireIndexOf(acc.total);

        uint8 centerGene = InkGenes.center(acc.sumW, acc.unitsTotal);
        (uint8 newGene, bytes memory sampled) = ComposeCompute.composeSampleAndGene(
            GeometrySampling.Donor({
                id: survivorId,
                units: survivorUnits,
                seed: s.seed,
                denomIndex: oldIndex,
                inkGene: s.inkGene,
                modules: rec.survivorModules
            }),
            burnDonors,
            acc.burnSeedFold,
            uint8(newIndex),
            acc.best,
            acc.worst,
            centerGene
        );

        st.totalSupply -= n;
        s.denomIndex = uint8(newIndex);
        s.originCount = uint32(acc.origins); // <= total/UNIT <= 10000 by the capacity invariant
        s.inkGene = newGene;
        st.modules[survivorId] = sampled;

        emit IShapes.Composed(survivorId, burnIds, uint8(newIndex), uint32(acc.origins));
        emit IShapes.InkGene(survivorId, newGene);
        emit IShapes.ModulesSampled(survivorId, sampled);
        emit IERC4906.MetadataUpdate(survivorId);
    }

    /* ------------------------------- decompose ------------------------------ */

    /// @notice Body of `Shapes.decompose`: pop the survivor's newest compose record, restore the
    ///         survivor's pre-compose state and rewrite every input burned by that compose.
    /// @dev Returns the restored ids for `Shapes` to mint, and the owner token id plus one when
    ///      the reversed compose had taken collection ownership from one of those inputs, else
    ///      zero. Ownership is restored by `Shapes` after the mints, so no receiver callback can
    ///      see `ownerToken()` naming an id that does not exist yet.
    function decompose(ShapeStore storage st, uint256 survivorId)
        public
        returns (uint256[] memory restoredIds, uint96 ownerTokenFrom)
    {
        ComposeRecord[] storage stack = st.composeStack[survivorId];
        uint256 depth = stack.length;
        if (depth == 0) revert IShapes.NoComposeRecord(survivorId);
        ComposeRecord storage rec = stack[depth - 1];
        uint256 m = rec.inputs.length;
        ownerTokenFrom = rec.ownerTokenFrom;

        // Restore the survivor to its pre-compose state. Its seed is unchanged: compose never
        // wrote it.
        ShapeData storage s = st.shapes[survivorId];
        s.denomIndex = rec.survivorDenomIndex;
        s.originCount = rec.survivorOriginCount;
        s.inkGene = rec.survivorInkGene;
        st.modules[survivorId] = rec.survivorModules;

        restoredIds = new uint256[](m);
        uint8[] memory genes = new uint8[](m);
        for (uint256 i = 0; i < m; ++i) {
            ComposeInput storage inp = rec.inputs[i];
            uint256 iid = inp.id;
            st.shapes[iid] = ShapeData({
                seed: inp.seed,
                denomIndex: inp.denomIndex,
                originCount: inp.originCount,
                isBlack: false,
                inkGene: inp.inkGene
            });
            st.modules[iid] = inp.modules;
            restoredIds[i] = iid;
            genes[i] = inp.inkGene;
        }

        st.totalSupply += m; // compose burned m inputs; decompose re-mints them, survivor stays
        bytes memory survivorModules = st.modules[survivorId];
        uint8 survivorDenomIndex = s.denomIndex;
        uint32 survivorOriginCount = s.originCount;
        stack.pop(); // clears the record and its inputs array

        emit IShapes.Decomposed(survivorId, restoredIds, survivorDenomIndex, survivorOriginCount);
        emit IShapes.InkGene(survivorId, s.inkGene);
        emit IShapes.ModulesSampled(survivorId, survivorModules);
        for (uint256 i = 0; i < m; ++i) {
            emit IShapes.InkGene(restoredIds[i], genes[i]);
            emit IShapes.ShapeRevived(survivorId, restoredIds[i]);
            emit IShapes.ModulesSampled(restoredIds[i], st.modules[restoredIds[i]]);
        }
        emit IERC4906.MetadataUpdate(survivorId);
    }

    /* --------------------------------- split -------------------------------- */

    /// @notice Body of `Shapes.split`: record the parent, allocate origins across the outputs and
    ///         write every child's state and sampled geometry.
    /// @dev `Shapes` has already gated the caller and burned the parent, whose state this call
    ///      still has. Returns the child ids for `Shapes` to mint last.
    function split(ShapeStore storage st, uint256 tokenId, uint8[] calldata outDenoms)
        public
        returns (uint256[] memory newIds)
    {
        uint256 k = outDenoms.length;
        ShapeData storage p = st.shapes[tokenId];

        // The parent's pre-burn state, grouped into one memory struct to reduce stack pressure.
        // `parentModules` is the parent's effective geometry, kept for provenance only: neither
        // sampling branch reads it.
        //
        // Keep the root split ancestor's denomination across later splits. The parent already
        // carries one when it was itself a split child; otherwise the parent is the root and its
        // own denomination is the origin.
        SplitOriginRef storage parentRef = st.splitOriginRef[tokenId];
        uint8 originDenomIndex =
            parentRef.exists ? st.splitRecords[parentRef.recordIndex].originDenomIndex : p.denomIndex;

        SplitRecord memory rec = SplitRecord({
            parentSeed: p.seed,
            parentId: uint96(tokenId),
            parentDenomIndex: p.denomIndex,
            parentInkGene: p.inkGene,
            originDenomIndex: originDenomIndex,
            parentModules: GeometrySampling.effectiveModulesOf(
                st.modules[tokenId], p.seed, p.denomIndex, p.inkGene
            )
        });

        // If the parent has a compose record, all children sample from that record's donor pool,
        // which does not depend on the child denomination and is built once here. Otherwise each
        // child samples from grammar v1 at its own denomination, read fresh per child in the loop.
        // Split never deletes `composeStack[tokenId]`, so this branch decision can be redone later
        // from `parentId` and `composeDepth`. See SAMPLING_SPEC.md.
        uint256 recordDepth = st.composeStack[tokenId].length;
        bool hasRecordPool = recordDepth > 0;
        bytes memory recordPool = hasRecordPool
            ? _splitRecordPool(st.composeStack[tokenId][recordDepth - 1], rec.parentSeed)
            : bytes("");

        // Every output is at least one unit and the outputs sum to the parent's backing, which is
        // at most 10000 units, so `k <= 10000` and the `uint32` child index below cannot overflow.
        ShapeMath.requireSplitSumMatches(Denominations.amountAt(rec.parentDenomIndex), outDenoms);
        uint32[] memory give = ShapeMath.allocateSplitOrigins(p.originCount, outDenoms);

        delete st.shapes[tokenId];
        delete st.modules[tokenId];

        // One split record per split operation, referenced by every child below. `splitRecords`
        // grows by one entry per call, so the `uint64` index is lossless below 2**64 splits, about
        // 1.8e19 calls, each of which burns a token and mints at least two.
        uint64 splitRecordIndex = uint64(st.splitRecords.length);
        st.splitRecords.push(rec);

        uint256 firstId = st.totalMinted;
        st.totalMinted = firstId + k;
        st.totalSupply += k - 1; // burned one, minting k

        newIds = new uint256[](k);
        bytes[] memory childModules = new bytes[](k);
        for (uint256 i = 0; i < k; ++i) {
            uint256 nid = firstId + i;
            newIds[i] = nid;
            st.shapes[nid] = ShapeData({
                seed: ShapeMath.childSeed(rec.parentSeed, i),
                denomIndex: outDenoms[i],
                originCount: give[i],
                isBlack: false,
                inkGene: rec.parentInkGene
            });

            childModules[i] = GeometrySampling.sampleSplitChildFromPool(
                hasRecordPool, recordPool, rec.parentSeed, rec.parentInkGene, outDenoms[i], i
            );
            st.modules[nid] = childModules[i];
            st.splitOriginRef[nid] =
                SplitOriginRef({exists: true, recordIndex: splitRecordIndex, childIndex: uint32(i)});
        }

        emit IShapes.Split(tokenId, rec.parentSeed, newIds, outDenoms, give);
        for (uint256 i = 0; i < k; ++i) {
            emit IShapes.InkGene(newIds[i], rec.parentInkGene);
            emit IShapes.ShapeFragmentCreated(tokenId, newIds[i], rec.parentSeed, i);
            emit IShapes.ModulesSampled(newIds[i], childModules[i]);
        }
    }

    /// @dev Builds a split's sampling pool from the parent's top compose record: the pre-compose
    ///      survivor's effective modules first, then the record's inputs' effective modules. Sort
    ///      donors by id so split output does not depend on the earlier compose's burnIds order,
    ///      which is the order `rec.inputs` is stored in. See SAMPLING_SPEC.md.
    function _splitRecordPool(ComposeRecord storage rec, bytes32 parentSeed)
        private
        view
        returns (bytes memory)
    {
        uint256 m = rec.inputs.length;
        GeometrySampling.Donor[] memory inputDonors = new GeometrySampling.Donor[](m);
        for (uint256 i = 0; i < m; ++i) {
            ComposeInput storage inp = rec.inputs[i];
            inputDonors[i] = GeometrySampling.Donor({
                id: inp.id,
                units: 0, // unused: split's pool concatenates every donor's modules, unweighted
                seed: inp.seed,
                denomIndex: inp.denomIndex,
                inkGene: inp.inkGene,
                modules: inp.modules
            });
        }
        return GeometrySampling.buildSplitRecordPoolSorted(
            rec.survivorModules, parentSeed, rec.survivorDenomIndex, rec.survivorInkGene, inputDonors
        );
    }

    /* -------------------------------- reads -------------------------------- */

    /// @notice Body of `Shapes.shapeState`: every protocol fact about one live Shape.
    /// @dev The caller has already required the token to exist.
    function shapeState(ShapeStore storage st, uint256 tokenId) public view returns (ShapeState memory) {
        ShapeData storage d = st.shapes[tokenId];
        return _state(d.seed, d.denomIndex, d.originCount, d.inkGene, d.isBlack, st.modules[tokenId]);
    }

    /// @notice Body of `Shapes.composeRecordAt`: one reversible compose record, decoded.
    /// @dev `ownerTokenFrom` is returned as a token id, or `type(uint256).max` when that compose
    ///      moved no collection ownership. The id-plus-one form the record stores is never returned.
    function composeRecordAt(ShapeStore storage st, uint256 survivorId, uint256 depth)
        public
        view
        returns (ComposeRecordView memory)
    {
        ComposeRecord[] storage stack = st.composeStack[survivorId];
        uint256 depthAvailable = stack.length;
        if (depth >= depthAvailable) {
            revert IShapes.ComposeRecordOutOfRange(survivorId, depth, depthAvailable);
        }

        ComposeRecord storage rec = stack[depth];
        uint256 m = rec.inputs.length;
        ComposeInputView[] memory inputs = new ComposeInputView[](m);
        for (uint256 i = 0; i < m; ++i) {
            ComposeInput storage inp = rec.inputs[i];
            inputs[i] = ComposeInputView({
                id: inp.id,
                seed: inp.seed,
                denominationIndex: inp.denomIndex,
                originCount: inp.originCount,
                inkGene: inp.inkGene,
                modules: inp.modules
            });
        }

        return ComposeRecordView({
            survivorDenominationIndex: rec.survivorDenomIndex,
            survivorOriginCount: rec.survivorOriginCount,
            survivorInkGene: rec.survivorInkGene,
            survivorModules: rec.survivorModules,
            ownerTokenFrom: rec.ownerTokenFrom == 0 ? type(uint256).max : uint256(rec.ownerTokenFrom) - 1,
            inputs: inputs
        });
    }

    /* ------------------------------- previews ------------------------------- */

    /// @notice Body of `Shapes.previewCompose`: the state that compose would leave on the survivor.
    /// @dev Runs the same gates in the same order as `Shapes.compose` and this library's `compose`,
    ///      against `account` instead of `msg.sender`, then the same `ComposeCompute` call over the
    ///      same donor state. Writes nothing.
    function previewCompose(
        ShapeStore storage st,
        address account,
        uint256 survivorId,
        uint256[] calldata burnIds
    ) public view returns (ShapeState memory) {
        uint256 n = burnIds.length;
        if (n == 0) revert IShapes.NoComposeInputs();

        requireLiveOwner(st, survivorId, _tokenOwner(survivorId), account);
        requireDistinctComposeInputs(burnIds);

        ShapeData storage s = st.shapes[survivorId];
        uint8 oldIndex = s.denomIndex;
        ShapeMath.BurnPoolAccum memory acc;
        uint256 survivorUnits = ShapeMath.initPool(acc, oldIndex, s.originCount, s.inkGene);

        GeometrySampling.Donor[] memory burnDonors = new GeometrySampling.Donor[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 burnId = burnIds[i];
            requireComposeInput(st, survivorId, burnId, _tokenOwner(burnId), account);

            ShapeData storage b = st.shapes[burnId];
            uint256 bUnits = ShapeMath.addDonor(acc, b.seed, b.denomIndex, b.originCount, b.inkGene);
            burnDonors[i] = GeometrySampling.Donor({
                id: burnId,
                units: bUnits,
                seed: b.seed,
                denomIndex: b.denomIndex,
                inkGene: b.inkGene,
                modules: st.modules[burnId]
            });
        }

        uint256 newIndex = Denominations.requireIndexOf(acc.total);
        uint8 centerGene = InkGenes.center(acc.sumW, acc.unitsTotal);
        (uint8 newGene, bytes memory sampled) = ComposeCompute.composeSampleAndGene(
            GeometrySampling.Donor({
                id: survivorId,
                units: survivorUnits,
                seed: s.seed,
                denomIndex: oldIndex,
                inkGene: s.inkGene,
                modules: st.modules[survivorId]
            }),
            burnDonors,
            acc.burnSeedFold,
            uint8(newIndex),
            acc.best,
            acc.worst,
            centerGene
        );

        return _state(s.seed, uint8(newIndex), uint32(acc.origins), newGene, false, sampled);
    }

    /// @notice Body of `Shapes.previewSplit`: the children split would mint, in `outDenoms` order.
    /// @dev Runs the same gates in the same order as `Shapes.split` and this library's `split`,
    ///      against `account` instead of `msg.sender`, and samples each child from the same pool.
    ///      Writes nothing. Child ids are not predicted: they depend on `totalMinted` at execution.
    function previewSplit(ShapeStore storage st, address account, uint256 tokenId, uint8[] calldata outDenoms)
        public
        view
        returns (ShapeChildPreview[] memory children)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert IShapes.SplitTooFewOutputs();
        requireLiveOwner(st, tokenId, _tokenOwner(tokenId), account);

        ShapeData storage p = st.shapes[tokenId];
        bytes32 parentSeed = p.seed;
        uint8 parentInkGene = p.inkGene;

        ShapeMath.requireSplitSumMatches(Denominations.amountAt(p.denomIndex), outDenoms);
        uint32[] memory give = ShapeMath.allocateSplitOrigins(p.originCount, outDenoms);

        uint256 recordDepth = st.composeStack[tokenId].length;
        bool hasRecordPool = recordDepth > 0;
        bytes memory recordPool = hasRecordPool
            ? _splitRecordPool(st.composeStack[tokenId][recordDepth - 1], parentSeed)
            : bytes("");

        children = new ShapeChildPreview[](k);
        for (uint256 i = 0; i < k; ++i) {
            children[i] = ShapeChildPreview({
                seed: ShapeMath.childSeed(parentSeed, i),
                denominationIndex: outDenoms[i],
                originCount: give[i],
                inkGene: parentInkGene,
                faceValueWei: Denominations.amountAt(outDenoms[i]),
                modules: GeometrySampling.sampleSplitChildFromPool(
                    hasRecordPool, recordPool, parentSeed, parentInkGene, outDenoms[i], i
                )
            });
        }
    }

    /// @dev One `ShapeState` from the fields that define it. Shared by `shapeState`, which reads
    ///      them from storage, and `previewCompose`, which computes them.
    function _state(
        bytes32 seed,
        uint8 denomIndex,
        uint32 originCount,
        uint8 inkGene,
        bool black,
        bytes memory modules
    ) private pure returns (ShapeState memory) {
        uint256 faceValue = Denominations.amountAt(denomIndex);
        return ShapeState({
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

    /// @dev The token's ERC-721 owner, read back from `Shapes`. This library runs under
    ///      `DELEGATECALL`, so `address(this)` is the token. Reverts `ERC721NonexistentToken` for an
    ///      id that does not exist, which is what the mutators' own `ownerOf` call does.
    function _tokenOwner(uint256 tokenId) private view returns (address) {
        return IERC721(address(this)).ownerOf(tokenId);
    }
}

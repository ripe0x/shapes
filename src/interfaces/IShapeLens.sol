// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ComposeRecordView, ShapeChildPreview, ShapeState} from "./IShapeCapabilities.sol";

/// @title IShapeLens
/// @notice Read-only periphery for `Shapes`: deterministic previews and the rich per-token state
///         and Unicode-card reads, split out of the core token to keep it under the EIP-170
///         runtime size limit.
/// @dev Every view reads token state through `Shapes`'s own getters and recomputes results with
///      the same externally linked libraries (`GeometrySampling`, `ComposeCompute`, `InkGenes`)
///      `Shapes` links and executes with, so results are bit-identical to what `compose`/`split`
///      would produce or has produced on `Shapes` itself.
interface IShapeLens {
    /// @notice The state `Shapes.compose(survivorId, burnIds)` would produce. Requires no caller
    ///         ownership and moves no state. Applies compose's validation: existence, not-Black,
    ///         no self-burn, no duplicate id, and a summed backing that lands on a denomination.
    function previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory result);

    /// @notice The children `Shapes.split(tokenId, outDenoms)` would produce, one entry per
    ///         `outDenoms` index: seed, denomination, origin count, ink gene, face value and
    ///         materialized module bytes. Requires no caller ownership and moves no state. Applies
    ///         split's validation: existence, not-Black, at least two outputs, and an output sum
    ///         matching the parent's backing.
    function previewSplit(uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children);

    /// @notice Every protocol fact about a live Shape in one canonical read.
    function shapeState(uint256 tokenId) external view returns (ShapeState memory);

    /// @notice AutoGlyph-style Unicode rendering of a live Shape's canonical module grid.
    /// @dev Cells are separated by spaces and rows by newlines. This is intended for display;
    ///      integrations that need machine-readable geometry should call `IShapeGeometry` on
    ///      `Shapes.renderer()` instead.
    function unicodeCard(uint256 tokenId) external view returns (string memory);

    /// @notice One reversible compose record on `survivorId`'s stack, at `depth` (0 the oldest,
    ///         `Shapes.composeDepth(survivorId) - 1` the newest, next in line for `decompose`).
    ///         Carries the survivor's pre-compose state and every burned input's snapshot, exactly
    ///         what `decompose` reads to reverse that compose, including each donor's materialized
    ///         module snapshot (SAMPLING_SPEC.md) so a caller can re-run `sampleCompose` off-chain
    ///         and reproduce the survivor's post-compose bytes. Reassembled from
    ///         `Shapes.composeRecordHeaderAt` and `Shapes.composeRecordInputAt`.
    /// @dev Reverts `IShapes.ComposeRecordOutOfRange` when `depth >= Shapes.composeDepth(survivorId)`.
    function composeRecordAt(uint256 survivorId, uint256 depth)
        external
        view
        returns (ComposeRecordView memory);

    /// @notice The split that minted `childId`: the parent's id and pre-split seed, denomination
    ///         index, ink gene and own effective module snapshot (SAMPLING_SPEC.md), the root
    ///         split ancestor's denomination index, plus `childId`'s index among that split's
    ///         outputs. A passthrough over `Shapes.splitOriginRaw`. Reproducing the child's module
    ///         bytes as sampled at split time (SAMPLING_SPEC.md section 12, D3') needs `parentId`
    ///         to check `Shapes.composeDepth(parentId)`: nonzero selects the compose-record branch
    ///         (rebuild the pool from `Shapes.composeRecordHeaderAt`/`composeRecordInputAt` at that
    ///         depth), zero selects the grammar branch (`GeometrySampling.grammarSplitPool(parentSeed,
    ///         childDenom, parentInkGene)`, ignoring `parentModules`). `originDenomIndex` (issue
    ///         #21C) backs the "Split Origin" metadata trait directly, with no reconstruction.
    /// @dev Reverts `IShapes.NotASplitChild` for a token that was never minted by `split`/
    ///      `splitTo` (an original mint, or an input re-minted verbatim by `decompose`).
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
        );

    /// @notice Whether `amountWei` is one of the nine supported denominations.
    function isSupportedDenomination(uint256 amountWei) external pure returns (bool);

    /// @notice Grid a denomination maps to. Reverts for unsupported amounts.
    function gridForAmount(uint256 amountWei) external pure returns (uint256 cols, uint256 rows);

    /// @notice Module count a denomination maps to.
    function modulesForAmount(uint256 amountWei) external pure returns (uint256);

    /// @notice Canonical external position reported for `tokenId`, or zero when none is reported.
    /// @dev Does not require a live token. Position results are unvalidated; failures return zero.
    function positionOf(uint256 tokenId) external view returns (address);

    /// @notice Whether `tokenId` is currently a live Shape.
    /// @dev Never reverts. False for never-issued and burned ids, including ids consumed by
    ///      compose or replaced by split; true for live Black Shapes.
    function exists(uint256 tokenId) external view returns (bool);
}

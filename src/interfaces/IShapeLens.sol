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

    /// @notice Validate a split and return every deterministic child before changing state.
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

    /// @notice The split that minted `childId`: the parent's pre-split seed, denomination index,
    ///         ink gene and effective module snapshot (SAMPLING_SPEC.md), plus `childId`'s index
    ///         among that split's outputs. A caller re-runs `GeometrySampling.sampleSplitChild`
    ///         with this data and the child's own denomination index to reproduce the child's
    ///         module bytes as sampled at split time. A passthrough over `Shapes.splitOriginRaw`.
    /// @dev Reverts `IShapes.NotASplitChild` for a token that was never minted by `split`/
    ///      `splitTo` (an original mint, or an input re-minted verbatim by `decompose`).
    function splitOriginOf(uint256 childId)
        external
        view
        returns (
            bytes32 parentSeed,
            uint8 parentDenomIndex,
            uint8 parentInkGene,
            bytes memory parentModules,
            uint256 childIndex
        );

    /* --------------------------- contract collector --------------------------- */

    /// @notice The configured collector token. `(address(0), 0)` until set.
    function contractCollectorToken() external view returns (address tokenContract, uint256 tokenId);

    /// @notice Current owner of the configured collector token, read live from the ERC-721.
    /// @dev Never cached. Returns `address(0)` when no token is configured, and when
    ///      `ownerOf(tokenId)` reverts, returns malformed data, or the token contract no longer has
    ///      code. Callers distinguish "unset" from "configured but unresolvable" through
    ///      `contractCollectorToken()`.
    function contractCollector() external view returns (address collector);

    /// @notice True once the binding is locked. Irreversible.
    function contractCollectorBindingLocked() external view returns (bool locked);
}

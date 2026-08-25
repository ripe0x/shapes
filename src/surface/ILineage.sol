// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What a token became. Targets are token ids in the SAME collection;
///         lineage is intra-collection by design, not cross-project.
///         Continuation: consumed into one successor (a merge input, a 1:1
///         upgrade). Split: consumed into many successors. Migration/Claim/
///         Reveal/Custom: lifecycle types a work assigns its own meaning.
///         Burn: consumed with no successor.
enum PathType {
    None,
    Continuation,
    Split,
    Migration,
    Claim,
    Reveal,
    Burn,
    Custom
}

/// @notice A token's forward edge. `target` is the sole successor for
///         Continuation, the first child for Split (full list via
///         `childrenOf`), zero for Burn. `data` is work-defined (a Split
///         records its child count here).
struct Path {
    PathType pathType;
    uint256 target;
    bytes32 data;
}

/// @title ILineage
/// @notice Optional per-collection lineage: an onchain forward edge per token
///         recording what it became, readable by any contract or indexer. A
///         Surface-compatible tool, not part of the Surface core or factory.
///         A work implements it on its own write-authority (its extension
///         minter); there is no shared registry and no cross-collection graph.
///         The full tree is walkable by following `pathOf` forward from any id.
interface ILineage {
    /// @notice Emitted when a token's forward edge is written.
    event PathSet(uint256 indexed tokenId, PathType indexed pathType, uint256 target, bytes32 data);

    /// @notice Emitted alongside PathSet for a Split, carrying every child id.
    event SplitRecorded(uint256 indexed tokenId, uint256[] children);

    /// @notice The forward edge for a token. `pathType == None` for a token
    ///         that has not been consumed.
    function pathOf(uint256 tokenId) external view returns (Path memory);

    /// @notice The child ids a Split produced. Empty for any non-Split token.
    function childrenOf(uint256 tokenId) external view returns (uint256[] memory);

    /// @notice Whether a forward edge has been recorded for a token.
    function hasPath(uint256 tokenId) external view returns (bool);
}

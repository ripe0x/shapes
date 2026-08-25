// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILineage, Path, PathType} from "./ILineage.sol";

/// @title LineageStore
/// @notice Reusable per-collection lineage storage. A Surface extension minter
///         inherits this and calls the internal recorders at its consume/create
///         events; the writes are internal, so the extension is the sole
///         authority and no external grant is needed.
/// @dev Intra-collection: targets are ids in the same collection. Records
///         overwrite, so a work that reuses token ids must reset a reused id's
///         path. Storage lives with the extension, one instance per collection;
///         there is no shared registry.
abstract contract LineageStore is ILineage {
    mapping(uint256 tokenId => Path) private _paths;
    mapping(uint256 tokenId => uint256[]) private _splitChildren;

    /// @inheritdoc ILineage
    function pathOf(uint256 tokenId) public view returns (Path memory) {
        return _paths[tokenId];
    }

    /// @inheritdoc ILineage
    function childrenOf(uint256 tokenId) public view returns (uint256[] memory) {
        return _splitChildren[tokenId];
    }

    /// @inheritdoc ILineage
    function hasPath(uint256 tokenId) public view returns (bool) {
        return _paths[tokenId].pathType != PathType.None;
    }

    /// @dev Record a single-successor edge (Continuation, Migration, Claim,
    ///      Reveal, Custom) or a Burn (target zero).
    function _recordPath(uint256 tokenId, PathType pathType, uint256 target, bytes32 data) internal {
        _paths[tokenId] = Path({pathType: pathType, target: target, data: data});
        emit PathSet(tokenId, pathType, target, data);
    }

    /// @dev Record a Split: one token consumed into `children`. `target` is the
    ///      first child and `data` the child count, so `pathOf` alone summarizes
    ///      the split; `childrenOf` returns the full list.
    function _recordSplit(uint256 tokenId, uint256[] memory children) internal {
        _splitChildren[tokenId] = children;
        uint256 first = children.length == 0 ? 0 : children[0];
        _paths[tokenId] =
            Path({pathType: PathType.Split, target: first, data: bytes32(children.length)});
        emit PathSet(tokenId, PathType.Split, first, bytes32(children.length));
        emit SplitRecorded(tokenId, children);
    }
}

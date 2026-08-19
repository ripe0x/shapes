// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stable, machine-readable formation classes. Numeric values are part of the API.
enum ShapeFormation {
    Fragment,
    Direct,
    Composed,
    Complete,
    Black
}

/// @notice The complete protocol state of one live Shape in a single read.
/// @dev `faceValueWei` is the Shape's denomination and survives blackening;
///      `redeemableValueWei` is zero for a Black Shape and otherwise equals face value.
struct ShapeState {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bool isBlack;
    ShapeFormation formation;
    uint256 faceValueWei;
    uint256 redeemableValueWei;
}

/// @notice One deterministic child returned by `previewSplit`.
struct ShapeChildPreview {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    uint256 faceValueWei;
}

/// @notice Stable value and redemption capability for integrators that do not need recomposition.
interface IShapeValue {
    function backingOf(uint256 tokenId) external view returns (uint256);
    function shapeState(uint256 tokenId) external view returns (ShapeState memory);
    function denominationAt(uint8 index) external pure returns (uint256);
    function denominationCount() external pure returns (uint8);
    function unit() external pure returns (uint256);
    function redeem(uint256 tokenId) external;
    function redeemBatch(uint256[] calldata tokenIds) external returns (uint256 totalWei);
    function redeemTo(uint256 tokenId, address payable recipient) external;
    function redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        external
        returns (uint256 totalWei);
}

/// @notice Stable mutation capability for contracts that build recomposition workflows.
interface IShapeRecomposition {
    function compose(uint256 survivorId, uint256[] calldata burnIds) external returns (uint256 outId);
    function decompose(uint256 survivorId) external returns (uint256[] memory restoredIds);
    function decomposeTo(uint256 survivorId, address recipient)
        external
        returns (uint256[] memory restoredIds);
    function split(uint256 tokenId, uint8[] calldata outDenoms) external returns (uint256[] memory newIds);
    function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        external
        returns (uint256[] memory newIds);
    function restore(bytes32 parentSeed, uint256[] calldata childIds) external returns (uint256 newTokenId);
    function restoreTo(bytes32 parentSeed, uint256[] calldata childIds, address recipient)
        external
        returns (uint256 newTokenId);
    function blacken(uint256 tokenId) external;
}

/// @notice Stable provenance capability, separate from metadata presentation.
interface IShapeProvenance {
    function seedOf(uint256 tokenId) external view returns (bytes32);
    function originCountOf(uint256 tokenId) external view returns (uint256);
    function inkGeneOf(uint256 tokenId) external view returns (uint8);
    function isComplete(uint256 tokenId) external view returns (bool);
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);
    function splitRecordOf(bytes32 parentSeed)
        external
        view
        returns (uint16 childCount, uint8 denominationIndex);
    function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32);
}

/// @notice Stable deterministic-preview capability. These calls do not require caller ownership.
interface IShapeSimulation {
    function previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory result);
    function previewSplit(uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children);
    function previewRestore(bytes32 parentSeed, uint256[] calldata childIds)
        external
        view
        returns (ShapeState memory result);
}

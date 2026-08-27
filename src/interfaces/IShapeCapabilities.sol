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
/// @dev Returned by `IShapeLens.shapeState` and `IShapeLens.previewCompose`. `faceValueWei` is the
///      Shape's denomination and survives sacrifice; `redeemableValueWei` is zero for a Black
///      Shape and otherwise equals face value. `modules` is the token's materialized module array
///      (`ModuleCodec`), empty when its geometry derives from `seed` under grammar v1.
struct ShapeState {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bool isBlack;
    ShapeFormation formation;
    uint256 faceValueWei;
    uint256 redeemableValueWei;
    bytes modules;
}

/// @notice One deterministic child returned by `IShapeLens.previewSplit`.
struct ShapeChildPreview {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    uint256 faceValueWei;
}

/// @notice One burned compose input as returned by `composeRecordAt`.
/// @dev `modules` is the input's materialized geometry snapshot at the time it was burned, empty
///      if it had none (an unmaterialized original mint).
struct ComposeInputView {
    uint256 id;
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bytes modules;
}

/// @notice One reversible compose record as returned by `composeRecordAt`: the survivor's
///         pre-compose state and every input burned into it, in the order recorded.
/// @dev `survivorModules` is the survivor's materialized geometry snapshot before the compose,
///      empty if it had none.
struct ComposeRecordView {
    uint8 survivorDenominationIndex;
    uint32 survivorOriginCount;
    uint8 survivorInkGene;
    bytes survivorModules;
    ComposeInputView[] inputs;
}

/// @notice Stable value and redemption capability for integrators that do not need recomposition.
interface IShapeValue {
    function backingOf(uint256 tokenId) external view returns (uint256);
    function denomIndexOf(uint256 tokenId) external view returns (uint8);
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
    function sacrifice(uint256 tokenId) external;
}

/// @notice Stable provenance capability, separate from metadata presentation.
interface IShapeProvenance {
    function seedOf(uint256 tokenId) external view returns (bytes32);
    function originCountOf(uint256 tokenId) external view returns (uint256);
    function inkGeneOf(uint256 tokenId) external view returns (uint8);
    function isComplete(uint256 tokenId) external view returns (bool);
    function formationOf(uint256 tokenId) external view returns (ShapeFormation);
    function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32);
}

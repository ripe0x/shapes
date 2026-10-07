// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapeState} from "shapes/ShapeTypes.sol";

/// @notice Everything the renderer needs to draw and describe one pack. Assembled by
///         `ShapePacks` from its own storage and from Shapes; the renderer reads no token state.
struct PackRenderInput {
    uint256 packId;
    uint256 shapeCount;
    uint256 valueWei;
    uint256 unitWei;
    uint32[] counts; // Shapes per ladder index, length == denomination count
    uint256[] denominations; // wei per ladder index, same length
    uint256 mintedCount; // Shapes the pack minted itself; shapeCount - mintedCount were pulled
    address creator;
    ShapeState[] topCards; // the first up to three Shapes in contents order
    string tokenNamePrefix;
    string description;
}

/// @title IShapePackRenderer
/// @notice Presentation for Shape Packs: the stack image, the metadata JSON, and the
///         collection-level metadata. Everything is generated at call time; nothing is stored.
/// @dev Card artwork is drawn through the Shapes renderer read live from `IShapes(shapes).renderer()`,
///      so pack art tracks whatever renderer Shapes presents. The renderer never writes state and
///      has no authority over anything.
interface IShapePackRenderer {
    /// @notice The Shapes token whose renderer draws the cards.
    function shapes() external view returns (address);

    /// @notice `data:application/json;base64,...` for one pack.
    function tokenURI(PackRenderInput calldata input) external view returns (string memory);

    /// @notice The raw metadata JSON for one pack.
    function metadataJSON(PackRenderInput calldata input) external view returns (string memory);

    /// @notice The raw SVG for one pack: a stack of cards, top cards drawn, the rest as backs.
    function image(PackRenderInput calldata input) external view returns (string memory);

    /// @notice `data:application/json;base64,...` for the collection.
    /// @param name The collection's ERC-721 name.
    /// @param description The shared description.
    /// @param seed Entropy for the illustrative stack; `ShapePacks` passes a per-block value.
    function contractURI(string calldata name, string calldata description, bytes32 seed)
        external
        view
        returns (string memory);
}

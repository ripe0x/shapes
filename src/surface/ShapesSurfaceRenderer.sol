// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

import {ISurfaceRenderer, IPooledSurface} from "./ISurface.sol";
import {IShapeRenderer} from "../interfaces/IShapeRenderer.sol";
import {IMetadataBridge} from "./ShapesMinter.sol";

/// @title ShapesSurfaceRenderer
/// @notice Adapts the pure Shapes renderer to the Surface `IRenderer` ABI. The
///         Surface core calls `tokenURI(collection, tokenId)`; this reads the
///         token's seed, backing, origin count and Black state from the bound
///         ShapesMinter and delegates to the unmodified pure renderer.
/// @dev One instance per collection, immutably wired to its minter. Also serves
///      as the minter's ERC-4906 bridge: it is the collection's authorized
///      renderer, so it can forward `notifyMetadataUpdate` on the minter's
///      behalf for compose/blacken.
contract ShapesSurfaceRenderer is ISurfaceRenderer, IMetadataBridge {
    /// @notice The pure, stateless Shapes renderer.
    IShapeRenderer public immutable pureRenderer;

    /// @notice The ShapesMinter holding per-token state.
    IShapesRenderData public immutable minter;

    error WrongCollection(address expected, address provided);
    error OnlyMinter();

    constructor(address pureRenderer_, address minter_) {
        pureRenderer = IShapeRenderer(pureRenderer_);
        minter = IShapesRenderData(minter_);
    }

    /// @inheritdoc ISurfaceRenderer
    function tokenURI(address collection, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        _requireBoundCollection(collection);
        (bytes32 seed, uint256 amountWei, uint256 originCount, bool black) = minter.renderData(tokenId);
        return pureRenderer.tokenURI(seed, amountWei, tokenId, originCount, black);
    }

    /// @inheritdoc ISurfaceRenderer
    /// @dev The standalone Shapes contract has no contractURI; this supplies a
    ///      minimal collection-level document for marketplaces.
    function contractURI(address collection) external view override returns (string memory) {
        _requireBoundCollection(collection);
        string memory json =
            '{"name":"Shapes","description":"ETH in, Shape out. Shape burned, the same ETH out. Fully onchain."}';
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @inheritdoc IMetadataBridge
    /// @dev Minter only. Forwards an ERC-4906 refresh to the collection, which
    ///      authorizes this contract as its current renderer.
    function emitMetadataUpdate(uint256 tokenId) external override {
        if (msg.sender != address(minter)) revert OnlyMinter();
        IPooledSurface(minter.collection()).notifyMetadataUpdate(tokenId, tokenId);
    }

    function _requireBoundCollection(address collection) private view {
        address bound = minter.collection();
        if (collection != bound) revert WrongCollection(bound, collection);
    }
}

/// @notice The ShapesMinter members this renderer reads.
interface IShapesRenderData {
    function renderData(uint256 tokenId)
        external
        view
        returns (bytes32 seed, uint256 amountWei, uint256 originCount, bool black);
    function collection() external view returns (address);
}

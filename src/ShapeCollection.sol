// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IShapeCollection} from "./interfaces/IShapeCollection.sol";
import {IShapeRenderer} from "./interfaces/IShapeRenderer.sol";
import {Denominations} from "./lib/Denominations.sol";
import {FixedPoint} from "./lib/FixedPoint.sol";
import {InkGenes} from "./lib/InkGenes.sol";

/// @title ShapeCollection
/// @notice Collection-level presentation for Shapes.
///
/// @dev Holds no state beyond the renderer address, has no owner and no initialiser. It reads
///      the chain only for `seed()`, which is `block.prevrandao` folded with the block number,
///      so an output that takes no seed advances once per block and every caller in the same
///      block sees the same one. Passing a seed explicitly pins an output forever.
///
///      Nothing here touches a token. The cards it renders are compositions the ladder allows,
///      drawn through the same renderer and the same ink-gene derivation a mint uses, which is
///      why they are indistinguishable from a real token's artwork.
contract ShapeCollection is IShapeCollection, IERC165 {
    /// @inheritdoc IShapeCollection
    address public immutable renderer;

    string private constant NAME = "Shapes";
    string private constant DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";

    /// @dev Frames per denomination in the filmstrip, and how long each is held. Nine
    ///      denominations at two variants is eighteen frames, a 4.5 second loop.
    uint256 private constant VARIANTS = 2;
    uint256 private constant FRAME_MS = 250;

    /// @dev `renderSVG` emits a nested `<svg>` sized 2000x2800, so the strip advances in those
    ///      units. The canvas is square with the card inset, rounded and shadowed.
    uint256 private constant FRAME_W = 2000;

    error RendererHasNoCode(address renderer);

    constructor(address renderer_) {
        if (renderer_.code.length == 0) revert RendererHasNoCode(renderer_);
        renderer = renderer_;
    }

    /* ------------------------------ seeding ----------------------------- */

    /// @inheritdoc IShapeCollection
    function seed() public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.prevrandao, block.number));
    }

    /* ---------------------------- collection ---------------------------- */

    /// @inheritdoc IShapeCollection
    function contractURI() external view returns (string memory) {
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json()))));
    }

    /// @inheritdoc IShapeCollection
    function json() public view returns (string memory) {
        return string(
            abi.encodePacked(
                '{"name":"',
                NAME,
                '","description":"',
                DESCRIPTION,
                '","image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(image())),
                '"}'
            )
        );
    }

    /// @inheritdoc IShapeCollection
    function image() public view returns (string memory) {
        return imageFor(seed());
    }

    /// @inheritdoc IShapeCollection
    function imageFor(bytes32 root) public view returns (string memory) {
        uint256 frames = Denominations.COUNT * VARIANTS;

        bytes memory strip;
        for (uint256 d = 0; d < Denominations.COUNT; ++d) {
            for (uint256 v = 0; v < VARIANTS; ++v) {
                strip = abi.encodePacked(
                    strip,
                    '<g transform="translate(',
                    FixedPoint.toString((d * VARIANTS + v) * FRAME_W),
                    ',0)">',
                    cardFor(keccak256(abi.encodePacked(root, d, v)), uint8(d)),
                    "</g>"
                );
            }
        }

        // The card rect is drawn twice: once under the strip to cast the shadow, once as a clip
        // path so the strip takes the same rounded corners.
        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3840 3840"'
                ' width="3840" height="3840" shape-rendering="geometricPrecision">' "<style>.s{animation:r ",
                FixedPoint.toString(frames * FRAME_MS),
                "ms steps(",
                FixedPoint.toString(frames),
                ")infinite}@keyframes r{to{transform:translateX(-",
                FixedPoint.toString(frames * FRAME_W),
                "px)}}</style>" "<defs>"
                '<clipPath id="c"><rect x="920" y="520" width="2000" height="2800" rx="40"/></clipPath>'
                '<filter id="d" x="-15%" y="-15%" width="130%" height="130%">'
                '<feDropShadow dx="0" dy="0" stdDeviation="44" flood-color="#000" flood-opacity="0.22"/>'
                "</filter>" "</defs>" '<rect width="3840" height="3840" fill="#fff"/>'
                '<rect x="920" y="520" width="2000" height="2800" rx="40" fill="#000" filter="url(#d)"/>'
                '<g clip-path="url(#c)"><g transform="translate(920,520)"><g class="s">',
                strip,
                "</g></g></g></svg>"
            )
        );
    }

    /* ------------------------------- cards ------------------------------ */

    /// @inheritdoc IShapeCollection
    function card(uint8 denomIndex) external view returns (string memory) {
        return cardFor(keccak256(abi.encodePacked(seed(), denomIndex)), denomIndex);
    }

    /// @inheritdoc IShapeCollection
    function cardFor(bytes32 cardSeed, uint8 denomIndex) public view returns (string memory) {
        if (denomIndex >= Denominations.COUNT) revert DenominationIndexOutOfRange(denomIndex);
        uint8 gene = InkGenes.geneAtMint(cardSeed, denomIndex);
        return IShapeRenderer(renderer).renderSVG(cardSeed, Denominations.amountAt(denomIndex), false, gene);
    }

    /* ------------------------------ erc165 ------------------------------ */

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IShapeCollection).interfaceId;
    }
}

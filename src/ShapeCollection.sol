// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IShapeCollection} from "./interfaces/IShapeCollection.sol";
import {IShapeRenderer} from "./interfaces/IShapeRenderer.sol";
import {IShapes} from "./interfaces/IShapes.sol";
import {AdminOps} from "./lib/AdminOps.sol";
import {CopyValidation} from "./lib/CopyValidation.sol";
import {Denominations} from "./lib/Denominations.sol";
import {FixedPoint} from "./lib/FixedPoint.sol";
import {InkGenes} from "./lib/InkGenes.sol";

/// @title ShapeCollection
/// @notice Collection-level metadata for Shapes: the editorial copy and the contract-level
///         metadata built from it, plus seeded card previews.
///
/// @dev Stores the token name prefix, the shared description and the owner token's own
///      description. `Shapes.tokenURI` and `Shapes.contractURI` read them back from here.
///      `setMetadataCopy` writes all three, restricted to the admin of the bound `Shapes` and
///      frozen by that token's `lockPresentation`. Both the admin address and the lock are read
///      live from `shapes`.
///
///      `seed()` hashes `block.prevrandao` with the block number, so a rendering call that takes
///      no seed advances once per block and every caller in that block gets the same value.
///      Passing a seed returns deterministic output for that seed.
///
///      Preview cards use the Shapes denomination ladder and ink-gene derivation. They render
///      through this collection's immutable renderer. No token is read or written.
contract ShapeCollection is IShapeCollection, IERC165 {
    /// @inheritdoc IShapeCollection
    address public immutable renderer;

    /// @inheritdoc IShapeCollection
    address public immutable shapes;

    /// @dev Frames per denomination in the filmstrip, and how long each is held. Nine
    ///      denominations at two variants is eighteen frames, a 4.5 second loop.
    uint256 private constant VARIANTS = 2;
    uint256 private constant FRAME_MS = 250;

    /// @dev `renderSVG` emits a nested `<svg>` sized 2000x2800, so the strip advances in those
    ///      units. The canvas is square with the card inset, rounded and shadowed.
    uint256 private constant FRAME_W = 2000;

    /// @dev Longest a name prefix may be, in bytes.
    uint256 private constant MAX_NAME_BYTES = 64;
    /// @dev Longest either description may be, in bytes.
    uint256 private constant MAX_DESCRIPTION_BYTES = 2048;

    /// @dev Default metadata copy set at construction.
    string private constant DEFAULT_TOKEN_NAME_PREFIX = "Shape ";
    string private constant DEFAULT_DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";
    string private constant DEFAULT_OWNER_TOKEN_DESCRIPTION = "The contract owner token of Shapes. Its current holder is returned by owner() and has no "
        "administrative authority. Ownership moves with this Shape through compose, decompose and "
        "split. Redeeming or burning it ends contract ownership.";

    string private _tokenNamePrefix;
    string private _description;
    string private _ownerTokenDescription;

    error ShapesHasNoCode(address shapes);

    /// @param renderer_ Renderer every card and the collection image are drawn through. Fixed at
    ///        construction and immutable after, so it is validated the same way `Shapes` validates
    ///        its own renderer pointer: must have code and answer ERC-165 for `IShapeRenderer`.
    ///        `Shapes` holds its own renderer pointer, which the admin can replace until
    ///        presentation is locked.
    /// @param shapes_ The `Shapes` token this collection describes. Its `admin()` may edit the
    ///        metadata copy and its `presentationLocked()` freezes it. Fixed at construction.
    constructor(IShapeRenderer renderer_, IShapes shapes_) {
        AdminOps.requireRenderer(address(renderer_));
        if (address(shapes_).code.length == 0) revert ShapesHasNoCode(address(shapes_));
        renderer = address(renderer_);
        shapes = address(shapes_);
        _tokenNamePrefix = DEFAULT_TOKEN_NAME_PREFIX;
        _description = DEFAULT_DESCRIPTION;
        _ownerTokenDescription = DEFAULT_OWNER_TOKEN_DESCRIPTION;
    }

    /* -------------------------------- copy ------------------------------ */

    /// @inheritdoc IShapeCollection
    function tokenNamePrefix() external view returns (string memory) {
        return _tokenNamePrefix;
    }

    /// @inheritdoc IShapeCollection
    function description() external view returns (string memory) {
        return _description;
    }

    /// @inheritdoc IShapeCollection
    function ownerTokenDescription() external view returns (string memory) {
        return _ownerTokenDescription;
    }

    /// @inheritdoc IShapeCollection
    function setMetadataCopy(
        string calldata tokenNamePrefix_,
        string calldata description_,
        string calldata ownerTokenDescription_
    ) external {
        IShapes token = IShapes(shapes);
        if (msg.sender != token.admin()) revert AdminUnauthorizedAccount(msg.sender);
        if (token.presentationLocked()) revert PresentationIsLocked();
        CopyValidation.requireJsonSafe(tokenNamePrefix_, MAX_NAME_BYTES, 0);
        CopyValidation.requireJsonSafe(description_, MAX_DESCRIPTION_BYTES, 1);
        CopyValidation.requireJsonSafe(ownerTokenDescription_, MAX_DESCRIPTION_BYTES, 2);
        _tokenNamePrefix = tokenNamePrefix_;
        _description = description_;
        _ownerTokenDescription = ownerTokenDescription_;
        emit MetadataCopySet(tokenNamePrefix_, description_, ownerTokenDescription_);
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
                IERC721Metadata(shapes).name(),
                '","description":"',
                _description,
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

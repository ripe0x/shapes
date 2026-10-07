// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {FixedPoint} from "shapes/lib/FixedPoint.sol";
import {IShapeCollection} from "shapes/interfaces/IShapeCollection.sol";
import {IShapeRenderer} from "shapes/interfaces/IShapeRenderer.sol";
import {IShapes} from "shapes/interfaces/IShapes.sol";
import {ShapeState} from "shapes/ShapeTypes.sol";

import {IShapePackRenderer, PackRenderInput} from "./interfaces/IShapePackRenderer.sol";

/// @title ShapePackRenderer
/// @notice Draws a pack as a stack of Shapes cards and describes it as JSON. The first few Shapes
///         in a pack show as fanned cards, drawn by whatever renderer Shapes presents; the rest
///         are plain black card backs behind them. Black and white, no fonts, as a Shape.
/// @dev Pure view logic. The only storage is the immutable Shapes address; the renderer is read
///      from Shapes on every call, so pack art follows Shapes' art. Layout is the
///      `ShapeCollection.imageFor` card, 2000x2800 at (920,520) on a 3840 canvas, with the same
///      rounded corners and drop shadow. Card artwork is the renderer's nested 2000x2800 `<svg>`,
///      placed by translating to the card origin and clipped to the rounded rect. Callers supply
///      JSON-safe copy; `ShapePacks` validates it when it is set.
contract ShapePackRenderer is IShapePackRenderer, IERC165 {
    /// @dev Card width and height in canvas units, as `ShapeCollection`.
    uint256 private constant CARD_W = 2000;
    uint256 private constant CARD_H = 2800;
    /// @dev Front card origin.
    uint256 private constant FRONT_X = 920;
    uint256 private constant FRONT_Y = 520;
    /// @dev Fan step per drawn card, up and to the left, and its rotation in degrees.
    uint256 private constant FAN_DX = 120;
    uint256 private constant FAN_DY = 84;
    uint256 private constant FAN_DEG = 5;
    /// @dev Offset per card back, up and to the left, and the most backs ever drawn.
    uint256 private constant BACK_STEP = 48;
    uint256 private constant MAX_BACKS = 4;
    /// @dev Card centre in canvas units, the pivot for each fan rotation.
    uint256 private constant CENTER_X = FRONT_X + CARD_W / 2;
    uint256 private constant CENTER_Y = FRONT_Y + CARD_H / 2;

    /// @inheritdoc IShapePackRenderer
    address public immutable shapes;

    error NotAContract(address target);

    constructor(address shapes_) {
        if (shapes_.code.length == 0) revert NotAContract(shapes_);
        shapes = shapes_;
    }

    /* ------------------------------- metadata ------------------------------- */

    /// @inheritdoc IShapePackRenderer
    function tokenURI(PackRenderInput calldata input) external view returns (string memory) {
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(_json(input)))));
    }

    /// @inheritdoc IShapePackRenderer
    function metadataJSON(PackRenderInput calldata input) external view returns (string memory) {
        return _json(input);
    }

    /// @inheritdoc IShapePackRenderer
    function image(PackRenderInput calldata input) external view returns (string memory) {
        return _image(input);
    }

    /// @inheritdoc IShapePackRenderer
    function contractURI(string calldata name, string calldata description, bytes32 seed)
        external
        view
        returns (string memory)
    {
        return string(
            abi.encodePacked(
                "data:application/json;base64,",
                Base64.encode(
                    abi.encodePacked(
                        '{"name":"',
                        name,
                        '","description":"',
                        description,
                        '","image":"data:image/svg+xml;base64,',
                        Base64.encode(bytes(_collectionImage(seed))),
                        '"}'
                    )
                )
            )
        );
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IShapePackRenderer).interfaceId;
    }

    /// @dev name, description and image, then the attribute list.
    function _json(PackRenderInput calldata input) private view returns (string memory) {
        return string(
            abi.encodePacked(
                '{"name":"',
                input.tokenNamePrefix,
                FixedPoint.toString(input.packId),
                '","description":"',
                input.description,
                " ",
                _makeup(input),
                '","image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(_image(input))),
                '","attributes":[',
                _attributes(input),
                "]}"
            )
        );
    }

    /// @dev `3 x 0.01 ETH, 1 x 0.05 ETH. 0.08 ETH total.` The ASCII `x` keeps the JSON byte-safe.
    function _makeup(PackRenderInput calldata input) private pure returns (bytes memory out) {
        uint256 n = input.counts.length;
        bool first = true;
        for (uint256 d = 0; d < n; ++d) {
            uint32 count = input.counts[d];
            if (count == 0) continue;
            out = abi.encodePacked(
                out,
                first ? "" : ", ",
                FixedPoint.toString(count),
                " x ",
                FixedPoint.fmt(input.denominations[d]),
                " ETH"
            );
            first = false;
        }
        out = abi.encodePacked(out, ". ", FixedPoint.fmt(input.valueWei), " ETH total.");
    }

    /// @dev Shapes, Value, Units, one row per held denomination, Source, Creator.
    function _attributes(PackRenderInput calldata input) private pure returns (bytes memory out) {
        out = abi.encodePacked(
            '{"trait_type":"Shapes","value":',
            FixedPoint.toString(input.shapeCount),
            '},{"trait_type":"Value","value":"',
            FixedPoint.fmt(input.valueWei),
            ' ETH"},{"display_type":"number","trait_type":"Units","value":',
            FixedPoint.toString(input.valueWei / input.unitWei),
            "}"
        );
        uint256 n = input.counts.length;
        for (uint256 d = 0; d < n; ++d) {
            uint32 count = input.counts[d];
            if (count == 0) continue;
            out = abi.encodePacked(
                out,
                ',{"trait_type":"',
                FixedPoint.fmt(input.denominations[d]),
                ' ETH","value":',
                FixedPoint.toString(count),
                "}"
            );
        }
        out = abi.encodePacked(
            out,
            ',{"trait_type":"Source","value":"',
            _source(input.mintedCount, input.shapeCount),
            '"},{"trait_type":"Creator","value":"',
            Strings.toChecksumHexString(input.creator),
            '"}'
        );
    }

    /// @dev Minted when the pack minted every Shape, Packed when it minted none, else Mixed.
    function _source(uint256 mintedCount, uint256 shapeCount) private pure returns (string memory) {
        if (mintedCount == shapeCount) return "Minted";
        if (mintedCount == 0) return "Packed";
        return "Mixed";
    }

    /* -------------------------------- images -------------------------------- */

    /// @dev Pack stack: each top card through the live Shapes renderer, then the remaining
    ///      Shapes as up to `MAX_BACKS` plain backs.
    function _image(PackRenderInput calldata input) private view returns (string memory) {
        IShapeRenderer renderer = IShapeRenderer(IShapes(shapes).renderer());
        uint256 n = input.topCards.length;
        string[] memory cards = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            cards[i] = _artwork(renderer, input.topCards[i]);
        }
        uint256 hidden = input.shapeCount > n ? input.shapeCount - n : 0;
        return _stack(cards, hidden < MAX_BACKS ? hidden : MAX_BACKS);
    }

    /// @dev Three illustrative cards, front to back at denominations 4, 2 and 0, over two backs.
    ///      Backs only when Shapes has no collection set.
    function _collectionImage(bytes32 seed) private view returns (string memory) {
        address collection = IShapes(shapes).collection();
        if (collection == address(0)) return _stack(new string[](0), 2);
        string[] memory cards = new string[](3);
        uint8[3] memory denoms = [uint8(4), 2, 0];
        for (uint256 i = 0; i < 3; ++i) {
            cards[i] = IShapeCollection(collection).cardFor(keccak256(abi.encodePacked(seed, i)), denoms[i]);
        }
        return _stack(cards, 2);
    }

    /// @dev The Shapes artwork for one card: sampled modules when present, else the seed.
    function _artwork(IShapeRenderer renderer, ShapeState calldata state)
        private
        pure
        returns (string memory)
    {
        if (state.modules.length != 0) {
            return renderer.renderSVGSampled(state.modules, state.faceValueWei, state.isBlack, state.inkGene);
        }
        return renderer.renderSVG(state.seed, state.faceValueWei, state.isBlack, state.inkGene);
    }

    /// @dev The shared stack. `cards` are finished card SVGs, index 0 frontmost; `backs` plain
    ///      black cards sit behind the last drawn card, continuing its fan, each a step further up
    ///      and to the left, so a deep pack reads as a thick stack behind the cards that show.
    function _stack(string[] memory cards, uint256 backs) private pure returns (string memory) {
        uint256 last = cards.length == 0 ? 0 : cards.length - 1;
        bytes memory body;
        if (backs > 0) {
            body = abi.encodePacked(body, "<g", _fan(last), ">");
            for (uint256 k = backs; k > 0; --k) {
                body = abi.encodePacked(body, _back(k));
            }
            body = abi.encodePacked(body, "</g>");
        }
        for (uint256 i = cards.length; i > 0; --i) {
            body = abi.encodePacked(body, _card(i - 1, cards[i - 1]));
        }
        // The fan spreads up and to the left of the front card; shift the whole stack by half
        // that spread so the composition stays centred on the canvas.
        return string(
            abi.encodePacked(
                _open(cards.length),
                '<g transform="translate(',
                FixedPoint.toString((last * FAN_DX + backs * BACK_STEP) / 2),
                ",",
                FixedPoint.toString((last * FAN_DY + backs * BACK_STEP) / 2),
                ')">',
                body,
                "</g></svg>"
            )
        );
    }

    /// @dev The fan transform for drawn card `i`: up-left by `i` steps and tilted about the front
    ///      card's centre. Empty for the front card, so it carries no transform at all.
    function _fan(uint256 i) private pure returns (bytes memory) {
        if (i == 0) return "";
        return abi.encodePacked(
            ' transform="translate(',
            _neg(i * FAN_DX),
            ",",
            _neg(i * FAN_DY),
            ") rotate(",
            _neg(i * FAN_DEG),
            " ",
            FixedPoint.toString(CENTER_X),
            " ",
            FixedPoint.toString(CENTER_Y),
            ')"'
        );
    }

    /// @dev Canvas, white ground, and one `<defs>` with the shadow and one clip path per card.
    function _open(uint256 cardCount) private pure returns (bytes memory out) {
        out = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3840 3840" width="3840" height="3840"'
            ' shape-rendering="geometricPrecision"><defs>'
            '<filter id="d" x="-15%" y="-15%" width="130%" height="130%">'
            '<feDropShadow dx="0" dy="0" stdDeviation="44" flood-color="#000" flood-opacity="0.22"/></filter>'
        );
        for (uint256 i = 0; i < cardCount; ++i) {
            out = abi.encodePacked(
                out,
                '<clipPath id="c',
                FixedPoint.toString(i),
                '">',
                _rect(FRONT_X, FRONT_Y, ""),
                "</clipPath>"
            );
        }
        out = abi.encodePacked(out, '</defs><rect width="3840" height="3840" fill="#fff"/>');
    }

    /// @dev A card back `k` steps behind the front card.
    function _back(uint256 k) private pure returns (bytes memory) {
        return _rect(FRONT_X - k * BACK_STEP, FRONT_Y - k * BACK_STEP, ' fill="#000" filter="url(#d)"');
    }

    /// @dev Drawn card `i`: fanned up-left and tilted about its own centre, black rounded rect
    ///      for the shadow, artwork clipped to the same rect.
    function _card(uint256 i, string memory art) private pure returns (bytes memory) {
        return abi.encodePacked(
            "<g",
            _fan(i),
            ">",
            _rect(FRONT_X, FRONT_Y, ' fill="#000" filter="url(#d)"'),
            '<g clip-path="url(#c',
            FixedPoint.toString(i),
            ')"><g transform="translate(920,520)">',
            art,
            "</g></g></g>"
        );
    }

    /// @dev `-magnitude`, or `0` for zero, written through the unsigned formatter.
    function _neg(uint256 magnitude) private pure returns (string memory) {
        if (magnitude == 0) return "0";
        return string(abi.encodePacked("-", FixedPoint.toString(magnitude)));
    }

    /// @dev A 2000x2800 rounded card rect at (x, y).
    function _rect(uint256 x, uint256 y, string memory attrs) private pure returns (bytes memory) {
        return abi.encodePacked(
            '<rect x="',
            FixedPoint.toString(x),
            '" y="',
            FixedPoint.toString(y),
            '" width="2000" height="2800" rx="40"',
            attrs,
            "/>"
        );
    }
}

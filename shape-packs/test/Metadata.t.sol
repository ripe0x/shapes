// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Shapes} from "shapes/Shapes.sol";
import {ShapeRenderer} from "shapes/ShapeRenderer.sol";
import {FixedPoint} from "shapes/lib/FixedPoint.sol";
import {Denominations} from "shapes/lib/Denominations.sol";
import {ShapeState} from "shapes/ShapeTypes.sol";
import {IShapeRenderer} from "shapes/interfaces/IShapeRenderer.sol";
import {IShapeGeometry} from "shapes/interfaces/IShapeGeometry.sol";

import {IShapePacks} from "../src/interfaces/IShapePacks.sol";
import {ShapePackRenderer} from "../src/ShapePackRenderer.sol";
import {PacksTest} from "./utils/PacksTest.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

/// @notice String and data-URI helpers for the metadata tests: decode a `data:` URI, search it,
///         count occurrences. Shared by `MetadataTest` and `PresentationTest`.
abstract contract MetadataHelpers is PacksTest {
    string internal constant JSON_PREFIX = "data:application/json;base64,";
    string internal constant SVG_KEY = '"image":"data:image/svg+xml;base64,';

    function contains(string memory haystack, string memory needle) internal pure returns (bool) {
        return indexOf(haystack, needle) != type(uint256).max;
    }

    /// @dev Index of the first occurrence of `needle` in `haystack`, or `type(uint256).max`.
    function indexOf(string memory haystack, string memory needle) internal pure returns (uint256) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0) return 0;
        if (n.length > h.length) return type(uint256).max;
        bytes1 first = n[0];
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            if (h[i] != first) continue;
            bool ok = true;
            for (uint256 j = 1; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return type(uint256).max;
    }

    /// @dev Non-overlapping occurrences of `needle` in `haystack`.
    function countOf(string memory haystack, string memory needle) internal pure returns (uint256 count) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        require(n.length != 0, "empty needle");
        if (n.length > h.length) return 0;
        bytes1 first = n[0];
        uint256 i = 0;
        while (i + n.length <= h.length) {
            bool ok = h[i] == first;
            if (ok) {
                for (uint256 j = 1; j < n.length; ++j) {
                    if (h[i + j] != n[j]) {
                        ok = false;
                        break;
                    }
                }
            }
            if (ok) {
                ++count;
                i += n.length;
            } else {
                ++i;
            }
        }
    }

    function startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory b = bytes(s);
        bytes memory p = bytes(prefix);
        if (p.length > b.length) return false;
        for (uint256 i = 0; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }

    function endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory b = bytes(s);
        bytes memory x = bytes(suffix);
        if (x.length > b.length) return false;
        uint256 off = b.length - x.length;
        for (uint256 i = 0; i < x.length; ++i) {
            if (b[off + i] != x[i]) return false;
        }
        return true;
    }

    /// @dev The text after the first `startNeedle` up to (not including) the next `stop` byte.
    function between(string memory haystack, string memory startNeedle, bytes1 stop)
        internal
        pure
        returns (string memory)
    {
        uint256 at = indexOf(haystack, startNeedle);
        require(at != type(uint256).max, "start needle not found");
        bytes memory h = bytes(haystack);
        uint256 from = at + bytes(startNeedle).length;
        uint256 to = from;
        while (to < h.length && h[to] != stop) {
            ++to;
        }
        require(to < h.length, "stop byte not found");
        bytes memory out = new bytes(to - from);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = h[from + i];
        }
        return string(out);
    }

    /// @dev Strips `prefix` from a `data:` URI and base64-decodes the rest, proving it decodes.
    function decodeDataUri(string memory uri, string memory prefix) internal pure returns (string memory) {
        require(startsWith(uri, prefix), "unexpected data URI prefix");
        bytes memory raw = bytes(uri);
        uint256 skip = bytes(prefix).length;
        bytes memory b64 = new bytes(raw.length - skip);
        for (uint256 i = 0; i < b64.length; ++i) {
            b64[i] = raw[i + skip];
        }
        return string(Base64Decode.decode(string(b64)));
    }

    function decodeJson(string memory uri) internal pure returns (string memory) {
        return decodeDataUri(uri, JSON_PREFIX);
    }

    /// @dev The decoded inline SVG of a decoded metadata JSON.
    function svgOfJson(string memory json) internal pure returns (string memory) {
        return string(Base64Decode.decode(between(json, SVG_KEY, '"')));
    }

    function svgOfPack(uint256 packId) internal view returns (string memory) {
        return svgOfJson(decodeJson(packs.tokenURI(packId)));
    }

    /// @dev `Shape Pack 1`-style name the fixture's default copy produces.
    function expectedName(uint256 packId) internal pure returns (string memory) {
        return string.concat('"name":"Shape Pack ', FixedPoint.toString(packId), '"');
    }

    /// @dev `<count> x <denomination> ETH`, the way the renderer prints one makeup entry.
    function entry(uint256 count, uint256 index) internal pure returns (string memory) {
        return string.concat(FixedPoint.toString(count), " x ", FixedPoint.fmt(amountAt(index)), " ETH");
    }

    function creatorTrait(address who) internal pure returns (string memory) {
        return string.concat('{"trait_type":"Creator","value":"', Strings.toChecksumHexString(who), '"}');
    }

    /// @dev Creates a pack for `who` from pulled Shapes and a minted makeup. Computes every argument
    ///      before the prank so no helper call consumes it.
    function createFor(address who, uint256[] memory pulled, uint32[] memory minted)
        internal
        returns (uint256 packId)
    {
        uint256 cost = costOf(minted);
        vm.prank(who);
        packId = packs.createPack{value: cost}(pulled, minted);
    }
}

contract MetadataTest is MetadataHelpers {
    /// @dev The opening of one card back, by offset: `k` steps behind the front card.
    function _backSignature(uint256 k) internal pure returns (string memory) {
        return string.concat(
            '<rect x="',
            FixedPoint.toString(920 - k * 48),
            '" y="',
            FixedPoint.toString(520 - k * 48),
            '" width="2000" height="2800" rx="40" fill="#000" filter="url(#d)"/>'
        );
    }

    function _backs(string memory svg) internal pure returns (uint256 n) {
        for (uint256 k = 1; k <= 8; ++k) {
            n += countOf(svg, _backSignature(k));
        }
    }

    function _drawnCards(string memory svg) internal pure returns (uint256) {
        return countOf(svg, '<g clip-path="url(#c');
    }

    /// @dev A 3 x index-0 pulled + 1 x index-1 minted pack (id 1) owned and created by alice.
    function _mixedPack() internal returns (uint256 packId) {
        uint256[] memory pulled = mintShapes(alice, 0, 3);
        approveAll(alice);
        packId = createFor(alice, pulled, mintsOf(1, 1));
    }

    /* ------------------------------ tokenURI ------------------------------ */

    function test_TokenUriOfMixedPack() public {
        uint256 packId = _mixedPack();
        assertEq(packId, 1);

        string memory uri = packs.tokenURI(packId);
        assertTrue(startsWith(uri, JSON_PREFIX), "data URI prefix");
        string memory json = decodeJson(uri);

        // The JSON is one object, and the renderer's own metadataJSON agrees byte for byte.
        assertEq(bytes(json)[0], bytes1("{"));
        assertEq(bytes(json)[bytes(json).length - 1], bytes1("}"));

        assertTrue(contains(json, '"name":"Shape Pack 1"'), "name");

        string memory makeup = string.concat(
            entry(3, 0), ", ", entry(1, 1), ". ", FixedPoint.fmt(3 * amountAt(0) + amountAt(1)), " ETH total."
        );
        assertTrue(
            contains(json, string.concat('"description":"', packs.description(), " ", makeup, '"')),
            "description"
        );

        // The mainnet ladder reads exactly as the design prints it.
        if (amountAt(0) == 0.01 ether) {
            assertTrue(
                contains(json, "3 x 0.01 ETH, 1 x 0.05 ETH. 0.08 ETH total."), "design makeup sentence"
            );
        }

        assertTrue(contains(json, SVG_KEY), "image key");
        string memory svg = svgOfJson(json);
        assertTrue(startsWith(svg, "<svg"), "svg opens");
        assertTrue(endsWith(svg, "</svg>"), "svg closes");

        string memory attributes = string.concat(
            '"attributes":[{"trait_type":"Shapes","value":4},',
            '{"trait_type":"Value","value":"',
            FixedPoint.fmt(3 * amountAt(0) + amountAt(1)),
            ' ETH"},',
            '{"display_type":"number","trait_type":"Units","value":8},',
            '{"trait_type":"',
            FixedPoint.fmt(amountAt(0)),
            ' ETH","value":3},',
            '{"trait_type":"',
            FixedPoint.fmt(amountAt(1)),
            ' ETH","value":1},',
            '{"trait_type":"Source","value":"Mixed"},',
            creatorTrait(alice),
            "]}"
        );
        assertTrue(endsWith(json, attributes), "attributes in order, closing the object");
        // The checksum is mixed case, not the lowercase `vm.toString` form.
        assertTrue(contains(json, "0x00000000000000000000000000000000000A11cE"), "checksummed creator");
        assertFalse(contains(json, "0x00000000000000000000000000000000000a11ce"), "creator is not lowercase");
    }

    function test_AttributeRowCount() public {
        uint256 packId = _mixedPack();
        string memory json = decodeJson(packs.tokenURI(packId));
        assertEq(countOf(json, '"trait_type"'), 7, "Shapes, Value, Units, two denominations, Source, Creator");
    }

    function test_CreatorIsTheCreatorNotTheHolder() public {
        uint256 packId = _mixedPack();
        vm.prank(alice);
        packs.transferFrom(alice, bob, packId);
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, creatorTrait(alice)), "creator survives a transfer");
        assertFalse(contains(json, Strings.toChecksumHexString(bob)), "holder is not named");
    }

    function test_SourceMintedOnly() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, '{"trait_type":"Source","value":"Minted"}'), "Minted");
        assertFalse(contains(json, '"value":"Packed"'));
        assertFalse(contains(json, '"value":"Mixed"'));
    }

    function test_SourcePulledOnly() public {
        uint256[] memory pulled = mintShapes(alice, 0, 3);
        approveAll(alice);
        uint256 packId = createFor(alice, pulled, noMints());
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, '{"trait_type":"Source","value":"Packed"}'), "Packed");
        assertFalse(contains(json, '"value":"Minted"'));
        assertFalse(contains(json, '"value":"Mixed"'));
    }

    function test_SourceStaysMixedAfterAdditionToMintedPack() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        uint256 extra = mintShape(alice, 1);
        approveAll(alice);
        uint32[] memory none = noMints();
        vm.prank(alice);
        packs.addToPack(packId, ids1(extra), none);
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, '{"trait_type":"Source","value":"Mixed"}'), "Mixed after a pulled addition");
    }

    /* ------------------------------ top cards ------------------------------ */

    function test_TopCardCapOneShape() public {
        // A single 0.05 Shape is a valid pack (0.05 >= 0.03 on the mainnet ladder: 5 units >= 3).
        uint256 packId = createFor(alice, noIds(), mintsOf(1, 1));
        string memory svg = svgOfPack(packId);
        assertEq(_drawnCards(svg), 1, "one card drawn");
        assertEq(countOf(svg, '<clipPath id="c'), 1, "one clip path");
        assertEq(countOf(svg, "<svg"), 2, "outer canvas plus one nested card");
        assertEq(_backs(svg), 0, "no backs");
    }

    function test_TopCardCapThreeShapes() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        string memory svg = svgOfPack(packId);
        assertEq(_drawnCards(svg), 3, "three cards drawn");
        assertEq(countOf(svg, '<clipPath id="c'), 3, "three clip paths");
        assertEq(countOf(svg, "<svg"), 4, "outer canvas plus three nested cards");
        assertEq(_backs(svg), 0, "no backs for exactly three");
    }

    function test_TopCardCapTenShapes() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 10));
        string memory svg = svgOfPack(packId);
        assertEq(_drawnCards(svg), 3, "still three cards drawn");
        assertEq(countOf(svg, '<clipPath id="c'), 3, "three clip paths");
        assertEq(countOf(svg, "<svg"), 4, "outer canvas plus three nested cards");
        assertEq(_backs(svg), 4, "four backs, the cap, for seven hidden Shapes");
    }

    function test_BackCountScalesThenCaps() public {
        // 4 Shapes: one hidden; 5: two hidden; 7: four hidden; 8: five hidden, capped at four.
        uint256[4] memory sizes = [uint256(4), 5, 7, 8];
        uint256[4] memory wantBacks = [uint256(1), 2, 4, 4];
        for (uint256 i = 0; i < sizes.length; ++i) {
            uint256 packId = createFor(alice, noIds(), mintsOf(0, uint32(sizes[i])));
            string memory svg = svgOfPack(packId);
            assertEq(_drawnCards(svg), 3, "cards");
            assertEq(_backs(svg), wantBacks[i], "backs");
        }
    }

    function test_TokenUriCostDoesNotGrowWithPackSize() public {
        uint256 small = createFor(alice, noIds(), mintsOf(0, 3));
        uint256 large = createFor(alice, noIds(), mintsOf(0, 200));
        uint256 g0 = gasleft();
        packs.tokenURI(small);
        uint256 smallGas = g0 - gasleft();
        g0 = gasleft();
        packs.tokenURI(large);
        uint256 largeGas = g0 - gasleft();
        // The large pack reads 200 denomination indexes for its makeup, but draws no more cards.
        assertLt(largeGas, smallGas + 3_000_000, "tokenURI of a 200-Shape pack stays bounded");
        assertEq(_drawnCards(svgOfPack(large)), 3);
    }

    function test_TopCardsAreTheFirstThreeInContentsOrder() public {
        uint256[] memory pulled = mintShapes(alice, 0, 5);
        approveAll(alice);
        uint256 packId = createFor(alice, pulled, noMints());

        string memory svg = svgOfPack(packId);
        ShapeRenderer r = ShapeRenderer(shapes.renderer());
        for (uint256 i = 0; i < 5; ++i) {
            ShapeState memory st = shapes.shapeState(pulled[i]);
            string memory art = r.renderSVG(st.seed, st.faceValueWei, st.isBlack, st.inkGene);
            assertEq(contains(svg, art), i < 3, i < 3 ? "front three are drawn" : "the rest are not drawn");
        }
    }

    function test_ComposeSurvivorRendersThroughSampledPath() public {
        // Compose two 0.05 Shapes inside alice's wallet; the survivor carries materialized modules.
        uint256[] memory two = mintShapes(alice, 1, 2);
        vm.prank(alice);
        shapes.compose(two[0], ids1(two[1]));
        ShapeState memory st = shapes.shapeState(two[0]);
        assertGt(st.modules.length, 0, "survivor has materialized modules");
        assertEq(st.faceValueWei, amountAt(2), "two 0.05 compose to a 0.1");

        approveAll(alice);
        uint256 packId = createFor(alice, ids1(two[0]), noMints());

        string memory uri = packs.tokenURI(packId);
        assertGt(bytes(uri).length, 0, "tokenURI does not revert");
        string memory svg = svgOfJson(decodeJson(uri));
        assertTrue(startsWith(svg, "<svg"));
        assertTrue(endsWith(svg, "</svg>"));
        assertEq(_drawnCards(svg), 1);

        // The card is the sampled artwork, not the seed-derived one.
        ShapeRenderer r = ShapeRenderer(shapes.renderer());
        string memory sampled = r.renderSVGSampled(st.modules, st.faceValueWei, st.isBlack, st.inkGene);
        string memory seeded = r.renderSVG(st.seed, st.faceValueWei, st.isBlack, st.inkGene);
        assertTrue(contains(svg, sampled), "drawn through renderSVGSampled");
        assertFalse(contains(svg, seeded), "not drawn from the seed");
    }

    function test_ComposeSurvivorAmongPlainShapes() public {
        uint256[] memory two = mintShapes(alice, 1, 2);
        vm.prank(alice);
        shapes.compose(two[0], ids1(two[1]));
        uint256 plain = mintShape(alice, 0);
        approveAll(alice);
        uint256[] memory pulled = ids2(plain, two[0]);
        uint256 packId = createFor(alice, pulled, mintsOf(0, 2));
        string memory svg = svgOfPack(packId);
        assertEq(_drawnCards(svg), 3);
        assertEq(countOf(svg, "<svg"), 4);
        ShapeState memory st = shapes.shapeState(two[0]);
        ShapeRenderer r = ShapeRenderer(shapes.renderer());
        assertTrue(contains(svg, r.renderSVGSampled(st.modules, st.faceValueWei, st.isBlack, st.inkGene)));
    }

    /* ------------------------------ liveness ------------------------------ */

    function test_TokenUriRevertsForNonexistentPack() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        packs.tokenURI(1);

        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        assertGt(bytes(packs.tokenURI(packId)).length, 0);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, packId + 1));
        packs.tokenURI(packId + 1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 0));
        packs.tokenURI(0);
    }

    function test_TokenUriRevertsForUnsealedPack() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        vm.prank(alice);
        packs.unseal(packId, alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, packId));
        packs.tokenURI(packId);
    }

    function test_TokenUriRevertsForOpenedAndRedeemedPacks() public {
        uint256 a = createFor(alice, noIds(), mintsOf(0, 3));
        uint256 b = createFor(alice, noIds(), mintsOf(0, 3));
        vm.startPrank(alice);
        packs.open(a);
        packs.redeem(b);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, a));
        packs.tokenURI(a);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, b));
        packs.tokenURI(b);
    }

    /* ----------------------------- contractURI ----------------------------- */

    function test_ContractUri() public view {
        string memory uri = packs.contractURI();
        assertTrue(startsWith(uri, JSON_PREFIX));
        string memory json = decodeJson(uri);
        assertEq(bytes(json)[0], bytes1("{"));
        assertEq(bytes(json)[bytes(json).length - 1], bytes1("}"));
        assertTrue(contains(json, '"name":"Shape Packs"'), "collection name");
        assertTrue(contains(json, string.concat('"description":"', packs.description(), '"')), "description");
        assertTrue(contains(json, SVG_KEY));
        string memory svg = svgOfJson(json);
        assertTrue(startsWith(svg, "<svg"));
        assertTrue(endsWith(svg, "</svg>"));
        // Collection set on Shapes: three illustrative cards over two backs.
        assertEq(_drawnCards(svg), 3, "illustrative cards");
        assertEq(_backs(svg), 2, "two backs");
    }

    function test_ContractUriFollowsCopyEdits() public {
        vm.prank(admin);
        packs.setMetadataCopy("Pack No. ", "Edited collection copy.");
        string memory json = decodeJson(packs.contractURI());
        assertTrue(contains(json, '"description":"Edited collection copy."'));
    }

    function test_ContractUriWithoutShapesCollectionFallsBackToBacks() public {
        // A Shapes with no collection set: the renderer draws two plain backs and never reverts.
        ShapeRenderer sr = new ShapeRenderer();
        Shapes bare = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(sr), 0);
        assertEq(bare.collection(), address(0));
        ShapePackRenderer pr = new ShapePackRenderer(address(bare));
        string memory json = decodeJson(pr.contractURI("Shape Packs", "d", bytes32(uint256(1))));
        assertTrue(contains(json, '"name":"Shape Packs"'));
        string memory svg = svgOfJson(json);
        assertTrue(startsWith(svg, "<svg"));
        assertEq(_drawnCards(svg), 0, "no cards without a collection");
        assertEq(_backs(svg), 2);
    }

    /* ------------------------- reflects state changes ------------------------- */

    function test_MetadataReflectsAdditions() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        string memory before_ = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(before_, '{"trait_type":"Shapes","value":3}'));
        assertTrue(
            contains(
                before_,
                string.concat('{"trait_type":"Value","value":"', FixedPoint.fmt(3 * amountAt(0)), ' ETH"}')
            )
        );
        assertTrue(contains(before_, '{"display_type":"number","trait_type":"Units","value":3}'));
        assertFalse(contains(before_, string.concat('"trait_type":"', FixedPoint.fmt(amountAt(1)), ' ETH"')));

        uint32[] memory more = mintsOf(1, 1);
        uint256 cost = costOf(more);
        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.MetadataUpdate(packId);
        vm.prank(alice);
        packs.addToPack{value: cost}(packId, noIds(), more);

        string memory after_ = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(after_, '{"trait_type":"Shapes","value":4}'), "count changed");
        assertTrue(
            contains(
                after_,
                string.concat(
                    '{"trait_type":"Value","value":"', FixedPoint.fmt(3 * amountAt(0) + amountAt(1)), ' ETH"}'
                )
            ),
            "value changed"
        );
        assertTrue(
            contains(after_, '{"display_type":"number","trait_type":"Units","value":8}'), "units changed"
        );
        assertTrue(
            contains(
                after_, string.concat('{"trait_type":"', FixedPoint.fmt(amountAt(1)), ' ETH","value":1}')
            ),
            "new denomination row"
        );
        assertTrue(contains(after_, entry(1, 1)), "description makeup changed");
        assertFalse(keccak256(bytes(before_)) == keccak256(bytes(after_)));
    }

    function test_ImageTracksShapesRenderer() public {
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        string memory uriBefore = packs.tokenURI(packId);

        // The test contract deployed Shapes, so it is Shapes' admin.
        ShapeRenderer second = new ShapeRenderer();
        shapes.setRenderer(address(second));
        assertEq(shapes.renderer(), address(second));

        // Read live from Shapes on every call: no revert, and (identical code) identical bytes.
        string memory uriAfter = packs.tokenURI(packId);
        assertEq(uriAfter, uriBefore, "same renderer code draws the same card");
        assertTrue(startsWith(svgOfPack(packId), "<svg"));
        assertGt(bytes(packs.contractURI()).length, 0);
    }

    function test_ImageUsesTheRendererShapesPresentsNow() public {
        // A renderer whose cards are a fixed marker proves the pack art follows `shapes.renderer()`.
        MarkerShapeRenderer marker = new MarkerShapeRenderer();
        shapes.setRenderer(address(marker));
        uint256 packId = createFor(alice, noIds(), mintsOf(0, 3));
        string memory svg = svgOfPack(packId);
        assertEq(countOf(svg, marker.marker()), 3, "three cards from the marker renderer");
    }
}

/// @dev A Shapes renderer stub whose every card is a short fixed marker, to prove which renderer
///      the pack draws through. It answers ERC-165 for the two interfaces Shapes checks when an admin
///      sets a renderer, and answers every other call (the pack renderer only calls `renderSVG` and
///      `renderSVGSampled`) with the ABI-encoded marker string.
contract MarkerShapeRenderer {
    string internal constant _MARKER = '<svg xmlns="http://www.w3.org/2000/svg" data-marker="packs"/>';

    function marker() external pure returns (string memory) {
        return _MARKER;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IShapeRenderer).interfaceId
            || id == type(IShapeGeometry).interfaceId;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(_MARKER);
    }
}

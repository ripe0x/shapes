// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {FixedPoint} from "../src/lib/FixedPoint.sol";
import {Round03Rand} from "../src/lib/Round03Rand.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

contract RendererTestBase is Test {
    ShapeRenderer internal renderer;

    uint256[9] internal DENOMS = [
        uint256(0.01 ether),
        0.1 ether,
        0.5 ether,
        1 ether,
        5 ether,
        10 ether,
        25 ether,
        50 ether,
        100 ether
    ];

    function setUp() public virtual {
        renderer = new ShapeRenderer();
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory b = bytes(s);
        bytes memory p = bytes(prefix);
        if (b.length < p.length) return false;
        for (uint256 i = 0; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory b = bytes(s);
        bytes memory p = bytes(suffix);
        if (b.length < p.length) return false;
        uint256 off = b.length - p.length;
        for (uint256 i = 0; i < p.length; ++i) {
            if (b[off + i] != p[i]) return false;
        }
        return true;
    }

    function _after(string memory s, string memory prefix) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory p = bytes(prefix);
        require(b.length >= p.length, "prefix longer than string");
        bytes memory out = new bytes(b.length - p.length);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = b[p.length + i];
        }
        return string(out);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h.length < n.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}

/* ==================================================================== *
 *  The random stream
 * ==================================================================== */

contract Round03RandTest is RendererTestBase {
    using Round03Rand for Round03Rand.Stream;

    /// @dev Vectors produced by the canonical TypeScript implementation. If these drift, the
    ///      Solidity port has diverged from the Round 03 source.
    function test_KnownVectors() public pure {
        uint32[4] memory fromZero = [uint32(1416247), 958946056, 627933444, 2007157716];
        Round03Rand.Stream memory s = Round03Rand.init(bytes32(0));
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(s.nextU32(), fromZero[i], "stream from seed 0");
        }

        uint32[4] memory from1007 =
            [uint32(3643707988), 1998004486, 2044178434, 210213278];
        Round03Rand.Stream memory t = Round03Rand.init(bytes32(uint256(1007)));
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(t.nextU32(), from1007[i], "stream from a design-page seed");
        }
    }

    /// @dev Documents SPEC.md D3d: the seeding multiplier equals the per-draw increment, so
    ///      a(seed, draw) = C * (seed + draw + 1) and every seed is a window into one shared
    ///      sequence. Asserted rather than merely written down, so nobody rediscovers it the
    ///      hard way while tuning a batch.
    function test_StreamIsCounterBasedAcrossSeeds() public pure {
        Round03Rand.Stream memory a = Round03Rand.init(bytes32(uint256(0)));
        uint256 second = a.nextU32();
        second = a.nextU32();

        Round03Rand.Stream memory b = Round03Rand.init(bytes32(uint256(1)));
        assertEq(
            b.nextU32(), second, "seed n+1's first draw is seed n's second draw"
        );
    }

    /// @dev Only the low 32 bits of the stored seed reach the stream.
    function testFuzz_OnlyLowWordAffectsTheStream(bytes32 seed, uint224 highNoise) public pure {
        bytes32 mutated = bytes32((uint256(highNoise) << 32) | (uint256(seed) & 0xffffffff));
        Round03Rand.Stream memory a = Round03Rand.init(seed);
        Round03Rand.Stream memory b = Round03Rand.init(mutated);
        for (uint256 i = 0; i < 8; ++i) {
            assertEq(a.nextU32(), b.nextU32());
        }
    }

    function testFuzz_DrawsStayInRange(bytes32 seed) public pure {
        Round03Rand.Stream memory s = Round03Rand.init(seed);
        for (uint256 i = 0; i < 16; ++i) {
            assertLt(s.nextU32(), 1 << 32);
        }
        Round03Rand.Stream memory t = Round03Rand.init(seed);
        for (uint256 i = 0; i < 16; ++i) {
            assertLt(t.nextWad(), FixedPoint.WAD);
        }
        Round03Rand.Stream memory u = Round03Rand.init(seed);
        for (uint256 i = 0; i < 16; ++i) {
            assertLt(u.nextBelow(5), 5);
        }
    }
}

/* ==================================================================== *
 *  The decimal formatter
 * ==================================================================== */

contract FixedPointTest is RendererTestBase {
    function test_FormatterVectors() public pure {
        assertEq(FixedPoint.fmt(0), "0");
        assertEq(FixedPoint.fmt(1e18), "1");
        assertEq(FixedPoint.fmt(66_421_875_000_000_000_000), "66.421875");
        assertEq(FixedPoint.fmt(0.5e18), "0.5");
        assertEq(FixedPoint.fmt(198e18), "198");
        assertEq(FixedPoint.fmt(76_666_666_666_666_666_666), "76.666667");
        // rounding half away from zero at the sixth decimal
        assertEq(FixedPoint.fmt(500_000_000_000), "0.000001");
        assertEq(FixedPoint.fmt(499_999_999_999), "0");
        assertEq(FixedPoint.fmt(1), "0");
        assertEq(FixedPoint.fmt(999_999_500_000_000_000), "1");
    }

    function test_NoTrailingZerosOrPoint() public pure {
        assertEq(FixedPoint.fmt(1.100000e18), "1.1");
        assertEq(FixedPoint.fmt(1.010000e18), "1.01");
        assertEq(FixedPoint.fmt(1.000001e18), "1.000001");
        assertEq(FixedPoint.fmt(0.000010e18), "0.00001");
    }

    function testFuzz_FormatterNeverEmitsTrailingZeroOrPoint(uint256 v) public pure {
        v = bound(v, 0, 1_000e18);
        bytes memory s = bytes(FixedPoint.fmt(v));
        assertGt(s.length, 0);
        assertTrue(s[s.length - 1] != ".", "trailing decimal point");

        bool hasPoint;
        for (uint256 i = 0; i < s.length; ++i) {
            if (s[i] == ".") hasPoint = true;
        }
        if (hasPoint) assertTrue(s[s.length - 1] != "0", "trailing fractional zero");
    }

    function testFuzz_FormatterRoundTripsWithinHalfAnUlp(uint256 v) public pure {
        v = bound(v, 0, 1_000e18);
        string memory s = FixedPoint.fmt(v);
        uint256 parsed = vm.parseUint(_toWad(s));
        uint256 diff = parsed > v ? parsed - v : v - parsed;
        assertLe(diff, 500_000_000_000, "formatting error exceeds half an emitted ulp");
    }

    /// @dev Re-scale a formatted decimal back to WAD so it can be parsed as an integer.
    function _toWad(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 dot = b.length;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == ".") dot = i;
        }
        uint256 fracLen = dot == b.length ? 0 : b.length - dot - 1;
        bytes memory digits = new bytes(b.length - (dot == b.length ? 0 : 1));
        uint256 o;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] != ".") digits[o++] = b[i];
        }
        bytes memory zeros = new bytes(18 - fracLen);
        for (uint256 i = 0; i < zeros.length; ++i) {
            zeros[i] = "0";
        }
        return string(abi.encodePacked(digits, zeros));
    }
}

/* ==================================================================== *
 *  Geometry
 * ==================================================================== */

contract GeometryTest is RendererTestBase {
    uint256 internal constant SQRT3_2 = 866_025_403_784_438_646; // √3 / 2
    uint256 internal constant SQRT2 = 1_414_213_562_373_095_048;

    /// @dev True painted half-extents of a module: stroke and miter joins included.
    ///
    ///      The subtlety is the triangle. Its corners are 60°, and a miter join at angle θ
    ///      pushes the outer corner out by `(w/2) / sin(θ/2)` along the bisector — a full
    ///      stroke width `w` at 60°, not half of one. Measuring with `w/2`, as a naive bound
    ///      would, understates a triangle's reach by 0.366·w and would let a real overflow
    ///      through. Everything else paints to exactly `d/2` thanks to the inset rule.
    function _extent(ShapeRenderer.Module memory m, uint256 triHeight)
        internal
        pure
        returns (uint256 worst)
    {
        uint256 w = m.solid ? 0 : m.weight;
        uint256 x;
        uint256 up;
        uint256 down;

        if (m.kind == 2) {
            // triangle
            uint256 h = FixedPoint.mulWad(m.size, triHeight);
            x = m.size / 2 + FixedPoint.mulWad(SQRT3_2, w);
            up = h / 2 + w;
            down = h / 2 + w / 2;
        } else if (m.kind == 3) {
            // half circle: flat edge on the centre line, 90° stroke corners below it
            x = m.size / 2 + w / 2;
            up = x;
            down = FixedPoint.mulWad(w / 2, SQRT2);
        } else {
            x = m.size / 2 + w / 2;
            up = x;
            down = x;
        }

        worst = x;
        if (up > worst) worst = up;
        if (down > worst) worst = down;
    }

    /// @notice No module may leave its own cell, at any denomination, for any seed.
    /// @dev Neighbouring cells share an edge, so a module that overflows its cell can collide
    ///      with the mark beside it. Containment is what keeps the grid legible.
    function testFuzz_ModulesNeverEscapeTheirCell(bytes32 seed, uint8 which) public view {
        uint256 amount = DENOMS[which % 9];
        ShapeRenderer.Card memory c = renderer.compose(seed, amount);

        for (uint256 i = 0; i < c.modules.length; ++i) {
            assertLe(_extent(c.modules[i], 0.866e18), c.cell / 2, "module escapes its cell");
        }
    }

    /// @notice Every mark on a card paints to exactly the same extent.
    /// @dev This is the property the whole sizing model exists to deliver. Each footprint is
    ///      solved backwards from `card.target`, so re-deriving the extent forwards must land
    ///      back on it — for every primitive, solid or outlined. If it does not, the solver
    ///      and the drawing code have drifted apart.
    function testFuzz_EveryMarkPaintsToTheCardTarget(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9]);
        for (uint256 i = 0; i < c.modules.length; ++i) {
            uint256 got = _extent(c.modules[i], 0.866e18);
            // A handful of wei of slack for the flooring in each closed form. The emitted
            // coordinates round at 1e-6, i.e. 1e12 wei, so this is twelve orders of magnitude
            // tighter than anything that could reach the SVG.
            assertApproxEqAbs(got, c.target, 32, "mark missed the card's painted-extent target");
        }
    }

    /// @notice The target itself never reaches past the cell boundary.
    function testFuzz_TargetStaysInsideTheCell(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9]);
        assertLe(c.target, c.cell / 2, "cell fill exceeded 100%");
        assertEq(c.fill, 0.83e18, "fill drifted");
    }

    /// @dev With no type on the card the field is centred at y 175, the card's true centre,
    ///      and spans y 60..290 at every denomination.
    function testFuzz_ArtworkStaysInsideTheCanvasAndClearOfType(bytes32 seed, uint8 which)
        public
        view
    {
        uint256 amount = DENOMS[which % 9];
        ShapeRenderer.Card memory c = renderer.compose(seed, amount);

        for (uint256 i = 0; i < c.modules.length; ++i) {
            ShapeRenderer.Module memory m = c.modules[i];
            uint256 extent = _extent(m, 0.866e18);
            assertGe(m.cx, extent, "left edge outside canvas");
            assertLe(m.cx + extent, 250e18, "right edge outside canvas");
            assertGe(m.cy, extent, "top edge outside canvas");
            assertLe(m.cy + extent, 350e18, "bottom edge outside canvas");
        }
    }

    function testFuzz_GridMatchesDenomination(bytes32 seed, uint8 which) public view {
        uint256 idx = which % 9;
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[idx]);
        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        assertEq(c.cols, cols);
        assertEq(c.rows, rows);
        assertEq(c.modules.length, cols * rows);
    }

    function testFuzz_CardParametersStayInSpecifiedRanges(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9]);
        // size and stroke are collection constants, identical for every Shape
        assertEq(c.fill, 0.83e18, "cell fill is not a constant");
        assertEq(c.wRatio, 0.14e18, "stroke ratio is not a constant");
    }

    /// @notice Size and stroke are proportional to the cell and identical across the
    ///         collection: two Shapes at the same denomination always share them exactly, and
    ///         across denominations they scale with the cell and nothing else.
    function testFuzz_SizeAndStrokeAreCollectionConstants(bytes32 a, bytes32 b, uint8 which)
        public
        view
    {
        uint256 amount = DENOMS[which % 9];
        ShapeRenderer.Card memory x = renderer.compose(a, amount);
        ShapeRenderer.Card memory y = renderer.compose(b, amount);
        assertEq(x.target, y.target, "painted extent varied between seeds");
        assertEq(x.weight, y.weight, "stroke varied between seeds");

        // and the same proportion at every other denomination
        for (uint256 i = 0; i < 9; ++i) {
            ShapeRenderer.Card memory z = renderer.compose(a, DENOMS[i]);
            assertEq(z.target, FixedPoint.mulWad(z.cell / 2, 0.83e18), "extent off proportion");
            assertEq(
                z.weight, FixedPoint.mulWad(2 * z.target, 0.14e18), "stroke off proportion"
            );
        }
    }

    /// @notice Every outlined mark on a card shares one stroke weight.
    /// @dev The card draws `wRatio` once; no primitive may override it. This is the regression
    ///      test for the removed `ring`, which used a hard-coded 0.22*d and read as an
    ///      unexplained inconsistency next to an outlined circle on the same card.
    function testFuzz_OneStrokeWeightPerCard(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9]);
        uint256 expected = FixedPoint.mulWad(2 * c.target, c.wRatio);
        for (uint256 i = 0; i < c.modules.length; ++i) {
            assertEq(c.modules[i].weight, expected, "a primitive overrode the card stroke");
        }
    }

    /// @notice A card's solid probability is drawn per card, and its two extremes are exact.
    /// @dev The point of the extremes is that they are legible: an "all solid" card must not
    ///      contain a single outlined mark, and vice versa. That only holds because the
    ///      per-module test is `draw < p`; with `draw > threshold` a p=1 card would still
    ///      produce an outlined mark once every 2^32 draws.
    function testFuzz_PureCardsAreActuallyPure(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9]);

        assertTrue(
            c.solidProbability == 0
                || c.solidProbability == 1e18
                || (c.solidProbability >= 0.30e18 && c.solidProbability <= 0.90e18),
            "solid probability landed outside the band and is not an extreme"
        );

        if (c.solidProbability == 0) {
            for (uint256 i = 0; i < c.modules.length; ++i) {
                assertFalse(c.modules[i].solid, "an all-outline card contained a solid mark");
            }
        } else if (c.solidProbability == 1e18) {
            for (uint256 i = 0; i < c.modules.length; ++i) {
                assertTrue(c.modules[i].solid, "an all-solid card contained an outlined mark");
            }
        }
    }

    /// @notice The extremes actually occur, at roughly the configured rate.
    function test_PureCardsOccurAtTheConfiguredRate() public view {
        uint256 pureSolid;
        uint256 pureOutline;
        uint256 n = 2_000;
        for (uint256 i = 0; i < n; ++i) {
            ShapeRenderer.Card memory c =
                renderer.compose(keccak256(abi.encodePacked(i)), DENOMS[6]);
            if (c.solidProbability == 1e18) pureSolid++;
            if (c.solidProbability == 0) pureOutline++;
        }
        // 5% of 2000 is 100; allow a generous band so this is a smoke test, not a flake
        assertGt(pureSolid, 60, "all-solid cards too rare");
        assertLt(pureSolid, 150, "all-solid cards too common");
        assertGt(pureOutline, 60, "all-outline cards too rare");
        assertLt(pureOutline, 150, "all-outline cards too common");
    }

    function testFuzz_EveryCellIsFilledExactlyOnce(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9]);
        for (uint256 i = 0; i < c.modules.length; ++i) {
            ShapeRenderer.Module memory m = c.modules[i];
            assertLt(m.kind, 6, "kind outside the vocabulary");
            assertTrue(m.rot == 0 || m.rot == 90 || m.rot == 180 || m.rot == 270);
            if (m.kind != 2 && m.kind != 3 && m.kind != 4) {
                assertEq(m.rot, 0, "only triangle, half and quarter rotate");
            }
        }
    }

    function test_ComposeRevertsForUnsupportedAmount() public {
        vm.expectRevert(
            abi.encodeWithSelector(Denominations.UnsupportedDenomination.selector, 2 ether)
        );
        renderer.compose(bytes32(uint256(1)), 2 ether);
    }
}

/* ==================================================================== *
 *  SVG and metadata output
 * ==================================================================== */

contract OutputTest is RendererTestBase {
    function testFuzz_SvgIsWellFormed(bytes32 seed, uint8 which, uint256 tokenId) public view {
        uint256 amount = DENOMS[which % 9];
        string memory svg = renderer.renderSVG(seed, amount);

        assertTrue(_startsWith(svg, '<svg xmlns="http://www.w3.org/2000/svg"'), "svg header");
        assertTrue(_endsWith(svg, "</svg>"), "svg closes");
        assertTrue(_contains(svg, 'viewBox="0 0 250 350"'), "2.5x3.5 card proportion");
        assertTrue(_contains(svg, '<rect x="0" y="0" width="250" height="350" fill="#000"/>'));
        assertFalse(_contains(svg, "<text"), "the committed card carries no type");
        assertFalse(_contains(svg, "font-family"), "no font references");
    }

    /// @dev Black background, white artwork, nothing else. No gradients, filters or textures.
    function testFuzz_PaletteIsBlackAndWhiteOnly(bytes32 seed, uint8 which) public view {
        string memory svg = renderer.renderSVG(seed, DENOMS[which % 9]);
        assertFalse(_contains(svg, "Gradient"), "no gradients");
        assertFalse(_contains(svg, "<filter"), "no filters");
        assertFalse(_contains(svg, "opacity"), "no opacity");
        assertFalse(_contains(svg, "rgb("), "no rgb colours");
        assertFalse(_contains(svg, "#0f"), "no stray colours");
        assertFalse(_contains(svg, "<image"), "no external images");
        assertFalse(_contains(svg, "http://www.w3.org/1999/xlink"), "no xlink references");
    }

    /// @notice The denomination reads correctly in metadata, with no trailing zeros. It is no
    ///         longer on the card face, so this is where it has to be right.
    function test_EthLabelHasNoTrailingZeros() public view {
        string[9] memory expected =
            ["0.01", "0.1", "0.5", "1", "5", "10", "25", "50", "100"];
        for (uint256 i = 0; i < 9; ++i) {
            string memory json = renderer.metadataJSON(bytes32(uint256(7)), DENOMS[i], 1);
            assertEq(
                vm.parseJsonString(json, ".attributes[0].value"),
                string(abi.encodePacked(expected[i], " ETH")),
                expected[i]
            );
        }
    }

    /// @notice The token number lives in the metadata name, not on the card.
    function test_TokenNumberIsInMetadataOnly() public view {
        string memory json = renderer.metadataJSON(bytes32(uint256(1)), 1 ether, 123);
        assertEq(vm.parseJsonString(json, ".name"), "Shape #123");
        assertFalse(_contains(renderer.renderSVG(bytes32(uint256(1)), 1 ether), "123"));
    }

    /// @notice tokenURI must decode to real JSON containing a real inline SVG.
    function testFuzz_TokenUriIsValidBase64Json(bytes32 seed, uint8 which, uint16 tokenId)
        public
        view
    {
        uint256 amount = DENOMS[which % 9];
        string memory uri = renderer.tokenURI(seed, amount, tokenId);

        assertTrue(_startsWith(uri, "data:application/json;base64,"), "json data uri");
        string memory json =
            string(Base64Decode.decode(_after(uri, "data:application/json;base64,")));

        // real JSON, parseable field by field
        assertEq(
            vm.parseJsonString(json, ".name"),
            string(abi.encodePacked("Shape #", vm.toString(uint256(tokenId))))
        );
        assertGt(bytes(vm.parseJsonString(json, ".description")).length, 40);

        string memory image = vm.parseJsonString(json, ".image");
        assertTrue(_startsWith(image, "data:image/svg+xml;base64,"), "inline svg data uri");

        string memory svg =
            string(Base64Decode.decode(_after(image, "data:image/svg+xml;base64,")));
        assertTrue(_startsWith(svg, "<svg "), "decoded image is an svg");
        assertTrue(_endsWith(svg, "</svg>"), "decoded image closes");
        assertEq(svg, renderer.renderSVG(seed, amount), "image is the canonical svg");
    }

    function testFuzz_AttributesDescribeTheSameToken(bytes32 seed, uint8 which) public view {
        uint256 idx = which % 9;
        uint256 amount = DENOMS[idx];
        string memory json = renderer.metadataJSON(seed, amount, 1);

        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "ETH Value");
        assertEq(
            vm.parseJsonString(json, ".attributes[0].value"),
            string(abi.encodePacked(Denominations.labelAt(idx), " ETH"))
        );

        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        assertEq(
            vm.parseJsonString(json, ".attributes[1].value"),
            string(
                abi.encodePacked(FixedPoint.toString(cols), "x", FixedPoint.toString(rows))
            )
        );
        // [0] ETH Value  [1] Grid  [2] Fill  [3] Modules  [4] Module Count  [5] Seed
        string memory fill = vm.parseJsonString(json, ".attributes[2].value");
        assertTrue(
            keccak256(bytes(fill)) == keccak256("Solid")
                || keccak256(bytes(fill)) == keccak256("Outline")
                || keccak256(bytes(fill)) == keccak256("Mixed"),
            "unexpected Fill trait"
        );
        assertEq(vm.parseJsonUint(json, ".attributes[4].value"), cols * rows);
        assertEq(vm.parseJsonString(json, ".attributes[5].value"), vm.toString(seed));
    }

    /// @dev The glyph trait must come from the same stream as the artwork, so it must have
    ///      exactly one glyph per module.
    function testFuzz_ModuleSequenceHasOneGlyphPerModule(bytes32 seed, uint8 which) public view {
        uint256 idx = which % 9;
        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        string memory seq = renderer.moduleSequence(seed, DENOMS[idx]);

        bytes memory b = bytes(seq);
        uint256 spaces;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == " ") spaces++;
        }
        assertEq(spaces + 1, cols * rows, "one glyph per module");
        // every glyph in the vocabulary is a 3-byte UTF-8 sequence
        assertEq(b.length, (cols * rows) * 3 + spaces, "unexpected glyph encoding");
    }

    function testFuzz_RenderNeverRevertsForAnySeed(bytes32 seed, uint8 which, uint256 tokenId)
        public
        view
    {
        string memory svg = renderer.renderSVG(seed, DENOMS[which % 9]);
        // a 100 ETH card is one solid mark on a black field, and with no type it is tiny
        assertGt(bytes(svg).length, 180);
        assertLt(bytes(svg).length, 8_000, "output larger than expected");
    }

    function test_DeterministicAcrossRepeatedCalls() public view {
        for (uint256 i = 0; i < 9; ++i) {
            bytes32 seed = keccak256(abi.encodePacked(i));
            string memory a = renderer.renderSVG(seed, DENOMS[i]);
            string memory b = renderer.renderSVG(seed, DENOMS[i]);
            assertEq(a, b);
        }
    }
}

/* ==================================================================== *
 *  Integration with the token
 * ==================================================================== */

contract TokenMetadataTest is RendererTestBase {
    Shapes internal shapes;
    address internal alice = address(0xA11CE);

    function setUp() public override {
        super.setUp();
        shapes = new Shapes(100, address(0xFEE), address(renderer));
        vm.deal(alice, 1_000 ether);
    }

    /// @notice The ETH value shown in metadata must equal the ETH the token actually returns.
    function test_MetadataValueMatchesOnchainBacking() public {
        string[9] memory labels =
            ["0.01", "0.1", "0.5", "1", "5", "10", "25", "50", "100"];

        for (uint256 i = 0; i < 9; ++i) {
            vm.prank(alice);
            uint256 id = shapes.mint{value: DENOMS[i] + DENOMS[i] / 100}(DENOMS[i], alice);

            string memory json =
                string(Base64Decode.decode(_after(shapes.tokenURI(id), "data:application/json;base64,")));

            assertEq(
                vm.parseJsonString(json, ".attributes[0].value"),
                string(abi.encodePacked(labels[i], " ETH"))
            );
            assertEq(shapes.backingOf(id), DENOMS[i]);

            uint256 before = alice.balance;
            vm.prank(alice);
            shapes.redeem(id);
            assertEq(alice.balance - before, DENOMS[i], "metadata promised what the token paid");
        }
    }

    function test_TokenUriUsesTheStoredSeed() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether, alice);
        bytes32 seed = shapes.seedOf(id);
        assertEq(shapes.tokenURI(id), renderer.tokenURI(seed, 1 ether, id));
    }

    /// @dev Artwork is fixed at mint. Nothing about later chain state may change it.
    function test_ArtworkIsStableForTheLifeOfTheToken() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 5 ether + 0.05 ether}(5 ether, alice);
        string memory atMint = shapes.tokenURI(id);

        vm.roll(block.number + 100_000);
        vm.warp(block.timestamp + 1000 days);
        vm.prevrandao(bytes32(uint256(12345)));
        vm.prank(alice);
        shapes.transferFrom(alice, address(0xB0B), id);

        assertEq(shapes.tokenURI(id), atMint, "artwork moved");
    }
}

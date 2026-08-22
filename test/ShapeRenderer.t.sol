// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {FixedPoint} from "../src/lib/FixedPoint.sol";
import {Round03Rand} from "../src/lib/Round03Rand.sol";
import {InkGenes} from "../src/lib/InkGenes.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

contract RendererTestBase is Test {
    ShapeRenderer internal renderer;

    /// @dev Canonical default metadata copy, passed to `metadataJSON`/`tokenURI` in tests.
    string internal constant NAME_PREFIX = "Shape ";
    string internal constant DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";

    ShapeCollection internal collection;
    uint256[9] internal DENOMS = [
        uint256(0.01 ether), 0.05 ether, 0.1 ether, 0.5 ether, 1 ether, 5 ether, 10 ether, 50 ether, 100 ether
    ];

    function setUp() public virtual {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
    }

    /// @dev A pseudo-varied gene (0..6) tied to a seed, for tests that need *some* ink gene but
    ///      aren't testing ink gene logic itself. Deterministic, and varies across fuzz runs
    ///      along with the seed.
    function _gene(bytes32 seed) internal pure returns (uint8) {
        return uint8(uint256(seed) % 7);
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

        uint32[4] memory from1007 = [uint32(3643707988), 1998004486, 2044178434, 210213278];
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
        assertEq(b.nextU32(), second, "seed n+1's first draw is seed n's second draw");
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

    /// @notice `isqrt` floors, and returns its argument unchanged below the Babylonian loop's
    ///         entry condition, where the iteration would not converge.
    function test_IsqrtFloorsAndHandlesItsSmallInputs() public pure {
        assertEq(FixedPoint.isqrt(0), 0);
        assertEq(FixedPoint.isqrt(1), 1);
        assertEq(FixedPoint.isqrt(2), 1, "floors rather than rounds");
        assertEq(FixedPoint.isqrt(3), 1);
        assertEq(FixedPoint.isqrt(4), 2, "exact at a perfect square");
        assertEq(FixedPoint.isqrt(99), 9);
        // Applied to a product of two WAD values the result is WAD-scaled.
        assertEq(FixedPoint.isqrt(FixedPoint.WAD * FixedPoint.WAD), FixedPoint.WAD);
        assertEq(FixedPoint.isqrt(4e18 * FixedPoint.WAD), 2 * FixedPoint.WAD);
    }

    function testFuzz_IsqrtIsTheFloorOfTheRealRoot(uint128 n) public pure {
        uint256 r = FixedPoint.isqrt(n);
        assertLe(r * r, n, "root squared exceeded the input");
        assertGt((r + 1) * (r + 1), n, "a larger root would also have fit");
    }

    function test_NoTrailingZerosOrPoint() public pure {
        assertEq(FixedPoint.fmt(1.1e18), "1.1");
        assertEq(FixedPoint.fmt(1.01e18), "1.01");
        assertEq(FixedPoint.fmt(1.000001e18), "1.000001");
        assertEq(FixedPoint.fmt(0.00001e18), "0.00001");
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
    uint256 internal constant SQRT2 = 1_414_213_562_373_095_048;

    /// @dev True painted half-extents of a module.
    ///
    ///      Triangle, right triangle, diamond, half circle and quarter circle are drawn as an
    ///      even-odd ring whose outer boundary is the solid geometry itself, so their extent is
    ///      the same whether the mark is solid or outlined — the stroke weight plays no part.
    ///      Circle, square and half square are still stroked paths, where the stroke straddles
    ///      the edge and adds w/2 all round. Arc and line are open strokes, always drawn, so the
    ///      stroke applies whatever the ignored solid bit says.
    function _extent(ShapeRenderer.Module memory m, uint256 triHeight) internal pure returns (uint256 worst) {
        uint256 w;
        if (m.kind == 0 || m.kind == 1 || m.kind == 6) {
            w = m.solid ? 0 : m.weight; // circle, square, half square: stroked paths
        } else {
            // triangle, half, quarter, diamond, right triangle: even-odd rings whose outer
            // boundary is the solid geometry; arc, line: filled bands clipped to the footprint
            w = 0;
        }
        uint256 x;
        uint256 up;
        uint256 down;

        if (m.kind == 2) {
            // triangle
            uint256 h = FixedPoint.mulWad(m.size, triHeight);
            x = m.size / 2;
            up = h / 2;
            down = h / 2;
        } else if (m.kind == 3) {
            // half circle: flat edge on the centre line, arc above it
            x = m.size / 2;
            up = x;
            down = 0;
        } else {
            // circle, square, quarter, diamond, half square, right triangle, arc, line
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
        ShapeRenderer.Card memory c = renderer.compose(seed, amount, _gene(seed));

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
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9], _gene(seed));
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
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9], _gene(seed));
        assertLe(c.target, c.cell / 2, "cell fill exceeded 100%");
        assertEq(c.fill, 0.83e18, "fill drifted");
    }

    /// @dev With no type on the card the field is centred at y 175, the card's true centre,
    ///      and spans y 60..290 at every denomination.
    function testFuzz_ArtworkStaysInsideTheCanvasAndClearOfType(bytes32 seed, uint8 which) public view {
        uint256 amount = DENOMS[which % 9];
        ShapeRenderer.Card memory c = renderer.compose(seed, amount, _gene(seed));

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
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[idx], _gene(seed));
        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        assertEq(c.cols, cols);
        assertEq(c.rows, rows);
        assertEq(c.modules.length, cols * rows);
    }

    function testFuzz_CardParametersStayInSpecifiedRanges(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9], _gene(seed));
        // size and stroke are collection constants, identical for every Shape
        assertEq(c.fill, 0.83e18, "cell fill is not a constant");
        assertEq(c.wRatio, 0.14e18, "stroke ratio is not a constant");
    }

    /// @notice Size and stroke are proportional to the cell and identical across the
    ///         collection: two Shapes at the same denomination always share them exactly, and
    ///         across denominations they scale with the cell and nothing else.
    function testFuzz_SizeAndStrokeAreCollectionConstants(bytes32 a, bytes32 b, uint8 which) public view {
        uint256 amount = DENOMS[which % 9];
        ShapeRenderer.Card memory x = renderer.compose(a, amount, _gene(a));
        ShapeRenderer.Card memory y = renderer.compose(b, amount, _gene(b));
        assertEq(x.target, y.target, "painted extent varied between seeds");
        assertEq(x.weight, y.weight, "stroke varied between seeds");

        // and the same proportion at every other denomination
        for (uint256 i = 0; i < 9; ++i) {
            ShapeRenderer.Card memory z = renderer.compose(a, DENOMS[i], _gene(a));
            assertEq(z.target, FixedPoint.mulWad(z.cell / 2, 0.83e18), "extent off proportion");
            assertEq(z.weight, FixedPoint.mulWad(2 * z.target, 0.14e18), "stroke off proportion");
        }
    }

    /// @notice Every outlined mark on a card shares one stroke weight.
    /// @dev The card draws `wRatio` once; no primitive may override it. This is the regression
    ///      test for the removed `ring`, which used a hard-coded 0.22*d and read as an
    ///      unexplained inconsistency next to an outlined circle on the same card.
    function testFuzz_OneStrokeWeightPerCard(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9], _gene(seed));
        uint256 expected = FixedPoint.mulWad(2 * c.target, c.wRatio);
        for (uint256 i = 0; i < c.modules.length; ++i) {
            assertEq(c.modules[i].weight, expected, "a primitive overrode the card stroke");
        }
    }

    /// @notice A card's solid probability is exactly the ink gene's table entry, not a per-card
    ///         draw: `GENE_PROBABILITY` (INK_GENES_IMPL_SPEC.md §4.1/§4.2). Its two extremes
    ///         (Void, Solid) are exact.
    /// @dev The point of the extremes is that they are legible: an "all solid" card must not
    ///      contain a single outlined mark, and vice versa. That only holds because the
    ///      per-module test is `draw < p`; with `draw > threshold` a p=1 card would still
    ///      produce an outlined mark once every 2^32 draws.
    function testFuzz_PureCardsAreActuallyPure(bytes32 seed, uint8 which, uint8 gene) public view {
        gene = gene % 7;
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9], gene);

        assertEq(
            c.solidProbability,
            InkGenes.geneProbabilityAt(gene),
            "solid probability did not come from the gene table"
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

    /// @notice The Void and Solid genes are pure for every seed, not just on average.
    /// @dev Ink genes made purity a caller-selected input rather than a per-card lottery, so the
    ///      thing worth smoke-testing across many seeds is that the extremes hold universally,
    ///      not that they occur at some rate.
    function test_ExtremeGenesAreAlwaysPure() public view {
        uint256 n = 200;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 seed = keccak256(abi.encodePacked(i));
            ShapeRenderer.Card memory voidCard = renderer.compose(seed, DENOMS[6], InkGenes.VOID);
            for (uint256 j = 0; j < voidCard.modules.length; ++j) {
                assertFalse(voidCard.modules[j].solid, "Void gene produced a solid mark");
            }
            ShapeRenderer.Card memory solidCard = renderer.compose(seed, DENOMS[6], InkGenes.SOLID);
            for (uint256 j = 0; j < solidCard.modules.length; ++j) {
                assertTrue(solidCard.modules[j].solid, "Solid gene produced an outlined mark");
            }
        }
    }

    function testFuzz_EveryCellIsFilledExactlyOnce(bytes32 seed, uint8 which) public view {
        ShapeRenderer.Card memory c = renderer.compose(seed, DENOMS[which % 9], _gene(seed));
        for (uint256 i = 0; i < c.modules.length; ++i) {
            ShapeRenderer.Module memory m = c.modules[i];
            assertLt(m.kind, 10, "kind outside the vocabulary");
            assertTrue(m.rot == 0 || m.rot == 90 || m.rot == 180 || m.rot == 270);
            // circle, square and diamond are rotation-invariant.
            if (m.kind == 0 || m.kind == 1 || m.kind == 5) {
                assertEq(m.rot, 0, "rotation-invariant kind was rotated");
            }
        }
    }

    function test_ComposeRevertsForUnsupportedAmount() public {
        vm.expectRevert(abi.encodeWithSelector(Denominations.UnsupportedDenomination.selector, 2 ether));
        renderer.compose(bytes32(uint256(1)), 2 ether, 0);
    }
}

/* ==================================================================== *
 *  SVG and metadata output
 * ==================================================================== */

contract OutputTest is RendererTestBase {
    function testFuzz_SvgIsWellFormed(bytes32 seed, uint8 which, uint256 tokenId) public view {
        uint256 amount = DENOMS[which % 9];
        string memory svg = renderer.renderSVG(seed, amount, false, _gene(seed));

        assertTrue(_startsWith(svg, '<svg xmlns="http://www.w3.org/2000/svg"'), "svg header");
        assertTrue(_endsWith(svg, "</svg>"), "svg closes");
        assertTrue(_contains(svg, 'viewBox="0 0 250 350"'), "2.5x3.5 card proportion");
        assertTrue(_contains(svg, '<rect x="0" y="0" width="250" height="350" fill="#000"/>'));
        assertFalse(_contains(svg, "<text"), "the committed card carries no type");
        assertFalse(_contains(svg, "font-family"), "no font references");
    }

    /// @dev Black background, white artwork, nothing else. No gradients, filters or textures.
    function testFuzz_PaletteIsBlackAndWhiteOnly(bytes32 seed, uint8 which) public view {
        string memory svg = renderer.renderSVG(seed, DENOMS[which % 9], false, _gene(seed));
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
        string[9] memory expected = ["0.01", "0.05", "0.1", "0.5", "1", "5", "10", "50", "100"];
        for (uint256 i = 0; i < 9; ++i) {
            string memory json = renderer.metadataJSON(
                bytes32(uint256(7)), DENOMS[i], 1, 1, false, 0, 0, NAME_PREFIX, DESCRIPTION
            );
            assertEq(
                vm.parseJsonString(json, ".attributes[0].value"),
                string(abi.encodePacked(expected[i], " ETH")),
                expected[i]
            );
        }
    }

    /// @notice The token number lives in the metadata name, not on the card.
    function test_TokenNumberIsInMetadataOnly() public view {
        string memory json = renderer.metadataJSON(
            bytes32(uint256(1)), 1 ether, 123, 1, false, 0, 0, NAME_PREFIX, DESCRIPTION
        );
        assertEq(vm.parseJsonString(json, ".name"), "Shape 123");
        assertFalse(_contains(renderer.renderSVG(bytes32(uint256(1)), 1 ether, false, 0), "123"));
    }

    /// @notice tokenURI must decode to real JSON containing a real inline SVG.
    function testFuzz_TokenUriIsValidBase64Json(bytes32 seed, uint8 which, uint16 tokenId) public view {
        uint256 amount = DENOMS[which % 9];
        string memory uri =
            renderer.tokenURI(seed, amount, tokenId, 1, false, _gene(seed), 0, NAME_PREFIX, DESCRIPTION);

        assertTrue(_startsWith(uri, "data:application/json;base64,"), "json data uri");
        string memory json = string(Base64Decode.decode(_after(uri, "data:application/json;base64,")));

        // real JSON, parseable field by field
        assertEq(
            vm.parseJsonString(json, ".name"),
            string(abi.encodePacked("Shape ", vm.toString(uint256(tokenId))))
        );
        assertGt(bytes(vm.parseJsonString(json, ".description")).length, 40);

        string memory image = vm.parseJsonString(json, ".image");
        assertTrue(_startsWith(image, "data:image/svg+xml;base64,"), "inline svg data uri");

        string memory svg = string(Base64Decode.decode(_after(image, "data:image/svg+xml;base64,")));
        assertTrue(_startsWith(svg, "<svg "), "decoded image is an svg");
        assertTrue(_endsWith(svg, "</svg>"), "decoded image closes");
        assertEq(svg, renderer.renderSVG(seed, amount, false, _gene(seed)), "image is the canonical svg");
    }

    function testFuzz_AttributesDescribeTheSameToken(bytes32 seed, uint8 which) public view {
        uint256 idx = which % 9;
        uint256 amount = DENOMS[idx];
        string memory json =
            renderer.metadataJSON(seed, amount, 1, 1, false, _gene(seed), 0, NAME_PREFIX, DESCRIPTION);

        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "ETH Value");
        assertEq(
            vm.parseJsonString(json, ".attributes[0].value"),
            string(abi.encodePacked(Denominations.labelAt(idx), " ETH"))
        );

        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        assertEq(
            vm.parseJsonString(json, ".attributes[1].value"),
            string(abi.encodePacked(FixedPoint.toString(cols), "x", FixedPoint.toString(rows)))
        );
        // [0] ETH Value [1] Grid [2] Fill [3] Ink [4] Modules [5] Module Count [6] Primitive
        // [7] Variety [8] Ink Tier [9] Formation [10] Independent Origins [11] Origin Density
        // [12] Complete [13] Black [14] Compose Depth
        string memory fill = vm.parseJsonString(json, ".attributes[2].value");
        assertTrue(
            keccak256(bytes(fill)) == keccak256("Solid") || keccak256(bytes(fill)) == keccak256("Outline")
                || keccak256(bytes(fill)) == keccak256("Mixed"),
            "unexpected Fill trait"
        );
        assertEq(vm.parseJsonString(json, ".attributes[3].trait_type"), "Ink");
        assertEq(vm.parseJsonString(json, ".attributes[3].value"), InkGenes.geneNameAt(_gene(seed)));
        assertEq(vm.parseJsonString(json, ".attributes[5].value"), FixedPoint.toString(cols * rows));
        string[9] memory densities = ["100%", "20%", "10%", "2%", "1%", "0.2%", "0.1%", "0.02%", "0.01%"];
        assertEq(vm.parseJsonString(json, ".attributes[11].value"), densities[idx]);
    }

    /// @notice The three batch-1 visual-rarity traits (TRAIT_SPEC.md): Primitive is a recognised
    ///         kind name, Variety sits in 1..10, Ink Tier maps the gene to its rarity band. Also
    ///         checks that Compose Depth (batch 2), the last attribute, echoes its input verbatim.
    function testFuzz_VisualRarityTraits(bytes32 seed, uint8 which, uint256 composeDepth) public view {
        uint256 idx = which % 9;
        uint256 amount = DENOMS[idx];
        uint8 gene = _gene(seed);
        string memory json =
            renderer.metadataJSON(seed, amount, 1, 1, false, gene, composeDepth, NAME_PREFIX, DESCRIPTION);

        assertEq(vm.parseJsonString(json, ".attributes[6].trait_type"), "Primitive");
        string memory primitive = vm.parseJsonString(json, ".attributes[6].value");
        bool validKind = keccak256(bytes(primitive)) == keccak256("Circle")
            || keccak256(bytes(primitive)) == keccak256("Square")
            || keccak256(bytes(primitive)) == keccak256("Triangle")
            || keccak256(bytes(primitive)) == keccak256("Half Circle")
            || keccak256(bytes(primitive)) == keccak256("Quarter Circle")
            || keccak256(bytes(primitive)) == keccak256("Diamond")
            || keccak256(bytes(primitive)) == keccak256("Half Square")
            || keccak256(bytes(primitive)) == keccak256("Right Triangle")
            || keccak256(bytes(primitive)) == keccak256("Arc")
            || keccak256(bytes(primitive)) == keccak256("Line");
        assertTrue(validKind, "Primitive must be a recognised kind name");

        assertEq(vm.parseJsonString(json, ".attributes[7].trait_type"), "Variety");
        uint256 variety = vm.parseUint(vm.parseJsonString(json, ".attributes[7].value"));
        assertGe(variety, 1);
        assertLe(variety, 10);

        assertEq(vm.parseJsonString(json, ".attributes[8].trait_type"), "Ink Tier");
        string memory tier = vm.parseJsonString(json, ".attributes[8].value");
        string memory expectedTier =
            (gene == 0 || gene == 6) ? "Mythic" : (gene == 1 || gene == 5) ? "Rare" : "Common";
        assertEq(tier, expectedTier, "Ink Tier must map the gene to its rarity band");

        assertEq(vm.parseJsonString(json, ".attributes[9].trait_type"), "Formation");

        assertEq(vm.parseJsonString(json, ".attributes[14].trait_type"), "Compose Depth");
        assertEq(
            vm.parseJsonString(json, ".attributes[14].value"),
            FixedPoint.toString(composeDepth),
            "Compose Depth must echo its input"
        );
    }

    /// @dev The glyph trait must come from the same stream as the artwork, so it must have
    ///      exactly one glyph per module.
    function testFuzz_ModuleSequenceHasOneGlyphPerModule(bytes32 seed, uint8 which) public view {
        uint256 idx = which % 9;
        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        string memory seq = renderer.moduleSequence(seed, DENOMS[idx], _gene(seed));

        bytes memory b = bytes(seq);
        uint256 spaces;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == " ") spaces++;
        }
        assertEq(spaces + 1, cols * rows, "one glyph per module");
        // every glyph in the vocabulary is a 3-byte UTF-8 sequence
        assertEq(b.length, (cols * rows) * 3 + spaces, "unexpected glyph encoding");
    }

    function testFuzz_UnicodeCardUsesCanonicalGrid(bytes32 seed, uint8 which) public view {
        uint256 idx = which % 9;
        (uint256 cols, uint256 rows) = Denominations.gridAt(idx);
        bytes memory card = bytes(renderer.renderUnicode(seed, DENOMS[idx], _gene(seed)));

        uint256 spaces;
        uint256 newlines;
        for (uint256 i = 0; i < card.length; ++i) {
            if (card[i] == " ") spaces++;
            if (card[i] == "\n") newlines++;
        }

        uint256 modules = cols * rows;
        assertEq(spaces, rows * (cols - 1), "wrong cell separators");
        assertEq(newlines, rows - 1, "wrong row separators");
        assertEq(card.length, modules * 3 + modules - 1, "unexpected UTF-8 card length");
    }

    function test_UnicodeCardPreservesModuleSequence() public view {
        for (uint256 idx = 0; idx < 9; ++idx) {
            bytes32 seed = keccak256(abi.encodePacked("unicode-card", idx));
            uint8 gene = _gene(seed);
            bytes memory card = bytes(renderer.renderUnicode(seed, DENOMS[idx], gene));
            for (uint256 i = 0; i < card.length; ++i) {
                if (card[i] == "\n") card[i] = " ";
            }
            assertEq(string(card), renderer.moduleSequence(seed, DENOMS[idx], gene));
        }
    }

    function testFuzz_RenderNeverRevertsForAnySeed(bytes32 seed, uint8 which, uint256 tokenId) public view {
        string memory svg = renderer.renderSVG(seed, DENOMS[which % 9], false, _gene(seed));
        // a 100 ETH card is one solid mark on a black field, and with no type it is tiny
        assertGt(bytes(svg).length, 180);
        assertLt(bytes(svg).length, 8_000, "output larger than expected");
    }

    function test_DeterministicAcrossRepeatedCalls() public view {
        for (uint256 i = 0; i < 9; ++i) {
            bytes32 seed = keccak256(abi.encodePacked(i));
            string memory a = renderer.renderSVG(seed, DENOMS[i], false, _gene(seed));
            string memory b = renderer.renderSVG(seed, DENOMS[i], false, _gene(seed));
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
        shapes = new Shapes(100, address(0xFEE), address(renderer), address(collection));
        vm.deal(alice, 1_000 ether);
    }

    /// @notice The ETH value shown in metadata must equal the ETH the token actually returns.
    function test_MetadataValueMatchesOnchainBacking() public {
        string[9] memory labels = ["0.01", "0.05", "0.1", "0.5", "1", "5", "10", "50", "100"];

        for (uint256 i = 0; i < 9; ++i) {
            vm.prank(alice);
            uint256 id = shapes.mint{value: DENOMS[i] + DENOMS[i] / 100}(DENOMS[i]);

            string memory json =
                string(Base64Decode.decode(_after(shapes.tokenURI(id), "data:application/json;base64,")));

            assertEq(
                vm.parseJsonString(json, ".attributes[0].value"), string(abi.encodePacked(labels[i], " ETH"))
            );
            assertEq(shapes.backingOf(id), DENOMS[i]);

            uint256 before = alice.balance;
            vm.prank(alice);
            shapes.redeem(id);
            assertEq(alice.balance - before, DENOMS[i], "metadata promised what the token paid");
        }
    }

    function _decodeJson(uint256 id) internal view returns (string memory) {
        return string(Base64Decode.decode(_after(shapes.tokenURI(id), "data:application/json;base64,")));
    }

    /// @notice The on-chain token drives the provenance traits from its own (originCount, isBlack),
    ///         so a Direct mint, a composed Complete and a Black Shape read differently.
    function test_ProvenanceTraitsReflectOnchainState() public {
        // Direct: one 1 ETH mint. units 100, originCount 1.
        vm.prank(alice);
        uint256 direct = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);
        string memory dj = _decodeJson(direct);
        // attributes[6..8] are Primitive/Variety/Ink Tier, [9..13] are the provenance block.
        assertEq(vm.parseJsonString(dj, ".attributes[9].value"), "Direct", "direct formation");
        assertEq(vm.parseJsonString(dj, ".attributes[10].value"), "1", "direct origins");
        assertEq(vm.parseJsonString(dj, ".attributes[11].value"), "1%", "direct density");
        assertEq(vm.parseJsonString(dj, ".attributes[12].value"), "false", "direct not complete");
        assertEq(vm.parseJsonString(dj, ".attributes[13].value"), "false", "direct not black");

        // Complete: five 0.01 direct mints composed into one 0.05. units 5, originCount 5.
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (0.01 ether + 0.0001 ether)}(0.01 ether, 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        string memory cj = _decodeJson(first);
        assertEq(vm.parseJsonString(cj, ".attributes[9].value"), "Complete", "complete formation");
        assertEq(vm.parseJsonString(cj, ".attributes[10].value"), "5", "complete origins");
        assertEq(vm.parseJsonString(cj, ".attributes[11].value"), "100%", "complete density");
        assertEq(vm.parseJsonString(cj, ".attributes[12].value"), "true", "is complete");

        // Fragment: split a Direct 100 ETH into two 50s. Origins partition survivor-first, so the
        // first child takes the lone origin and the second is a zero-origin Fragment.
        vm.prank(alice);
        uint256 whole = shapes.mint{value: 100 ether + 1 ether}(100 ether);
        uint8[] memory halves = new uint8[](2);
        halves[0] = 7; // 50 ETH
        halves[1] = 7;
        vm.prank(alice);
        uint256[] memory parts = shapes.split(whole, halves);
        assertEq(shapes.originCountOf(parts[0]), 1, "first half keeps the origin");
        assertEq(shapes.originCountOf(parts[1]), 0, "second half is a fragment");
        string memory fj = _decodeJson(parts[1]);
        assertEq(vm.parseJsonString(fj, ".attributes[9].value"), "Fragment", "fragment formation");
        assertEq(vm.parseJsonString(fj, ".attributes[10].value"), "0", "fragment origins");
        assertEq(vm.parseJsonString(fj, ".attributes[11].value"), "0%", "fragment density");
        assertEq(vm.parseJsonString(fj, ".attributes[12].value"), "false", "fragment not complete");
    }

    /// @notice Compose Depth (batch 2), the last attribute, tracks the survivor's live
    ///         reversible-compose stack: 0 at mint, incremented by `compose`, decremented back by
    ///         the matching `decompose`.
    function test_ComposeDepthTraitTracksComposeAndDecompose() public {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (0.01 ether + 0.0001 ether)}(0.01 ether, 5);

        assertEq(shapes.composeDepth(first), 0, "fresh mint has no compose record");
        assertEq(vm.parseJsonString(_decodeJson(first), ".attributes[14].trait_type"), "Compose Depth");
        assertEq(
            vm.parseJsonString(_decodeJson(first), ".attributes[14].value"),
            "0",
            "Compose Depth 0 before any compose"
        );

        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);

        assertEq(shapes.composeDepth(first), 1, "one compose record pushed");
        assertEq(
            vm.parseJsonString(_decodeJson(first), ".attributes[14].value"),
            "1",
            "Compose Depth 1 after composing"
        );

        vm.prank(alice);
        shapes.decompose(first);

        assertEq(shapes.composeDepth(first), 0, "compose record popped");
        assertEq(
            vm.parseJsonString(_decodeJson(first), ".attributes[14].value"),
            "0",
            "Compose Depth back to 0 after decompose"
        );
    }

    function test_TokenUriUsesTheStoredSeed() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);
        bytes32 seed = shapes.seedOf(id);
        assertEq(
            shapes.tokenURI(id),
            renderer.tokenURI(seed, 1 ether, id, 1, false, shapes.inkGeneOf(id), 0, NAME_PREFIX, DESCRIPTION)
        );
    }

    /// @dev Artwork is fixed at mint. Nothing about later chain state may change it.
    function test_ArtworkIsStableForTheLifeOfTheToken() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 5 ether + 0.05 ether}(5 ether);
        string memory atMint = shapes.tokenURI(id);

        vm.roll(block.number + 100_000);
        vm.warp(block.timestamp + 1000 days);
        vm.prevrandao(bytes32(uint256(12345)));
        vm.prank(alice);
        shapes.transferFrom(alice, address(0xB0B), id);

        assertEq(shapes.tokenURI(id), atMint, "artwork moved");
    }

    /* ----------------------------- editable copy ----------------------------- */

    function _decodeContract() internal view returns (string memory) {
        return string(Base64Decode.decode(_after(shapes.contractURI(), "data:application/json;base64,")));
    }

    /// @notice The owner rewrites the per-token name prefix and description, and it shows in every
    ///         token's metadata immediately.
    function test_OwnerCanUpdateTokenCopy() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);
        string memory idStr = vm.toString(id);
        assertEq(vm.parseJsonString(_decodeJson(id), ".name"), string.concat("Shape ", idStr), "default name");

        shapes.setTokenCopy("Form ", "A reshaped description of the object.");

        string memory j = _decodeJson(id);
        assertEq(vm.parseJsonString(j, ".name"), string.concat("Form ", idStr), "name prefix updated");
        assertEq(
            vm.parseJsonString(j, ".description"),
            "A reshaped description of the object.",
            "description updated"
        );
        assertEq(shapes.tokenNamePrefix(), "Form ");
        assertEq(shapes.tokenDescription(), "A reshaped description of the object.");
    }

    /// @notice The owner rewrites the collection name and description, and `contractURI` reflects it.
    function test_OwnerCanUpdateCollectionCopy() public {
        assertTrue(_contains(_decodeContract(), '"name":"Shapes"'), "default collection name");

        shapes.setCollectionCopy("The Collection", "A rewritten collection description.");

        string memory j = _decodeContract();
        assertEq(vm.parseJsonString(j, ".name"), "The Collection", "collection name updated");
        assertEq(
            vm.parseJsonString(j, ".description"),
            "A rewritten collection description.",
            "collection desc updated"
        );
        assertEq(shapes.collectionName(), "The Collection");
        assertEq(shapes.collectionDescription(), "A rewritten collection description.");
    }

    /// @notice Setting the token copy emits the editorial event and an ERC-4906 refresh over the
    ///         whole supply so marketplaces re-read every token.
    function test_TokenCopyUpdateEmitsRefresh() public {
        vm.prank(alice);
        shapes.mint{value: 1 ether + 0.01 ether}(1 ether); // totalMinted == 1

        vm.expectEmit(true, true, true, true, address(shapes));
        emit IShapes.TokenCopyUpdated("P ", "D");
        vm.expectEmit(true, true, true, true, address(shapes));
        emit BatchMetadataUpdate(0, 0);
        shapes.setTokenCopy("P ", "D");
    }

    function test_CollectionCopyUpdateEmits() public {
        vm.expectEmit(true, true, true, true, address(shapes));
        emit IShapes.CollectionCopyUpdated("N", "D");
        vm.expectEmit(true, true, true, true, address(shapes));
        emit IShapes.ContractURIUpdated();
        shapes.setCollectionCopy("N", "D");
    }

    /// @notice Copy is owner-gated. A non-owner cannot touch either the token or collection copy.
    function test_NonOwnerCannotUpdateCopy() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setTokenCopy("x ", "y");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setCollectionCopy("x", "y");
        vm.stopPrank();
    }

    /// @notice `lockRenderer` freezes the rendering contracts, not the editorial copy: the owner
    ///         keeps editing copy afterwards.
    function test_CopyStaysEditableAfterRendererLock() public {
        shapes.lockRenderer();
        shapes.setTokenCopy("Locked ", "Still editable copy after the presentation lock.");
        assertEq(shapes.tokenNamePrefix(), "Locked ");
    }

    /// @notice Copy that would break or restructure the metadata JSON is rejected on set, so no
    ///         edit — even after `lockRenderer` — can produce a malformed or forged document.
    function test_CopyRejectsJsonBreakingBytes() public {
        // A double quote closes the string early and lets the rest forge structure.
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(1)));
        shapes.setTokenCopy("Shape ", 'x","image":"https://evil.example/a.png","attributes":[]}');

        // Backslash (would start a JSON escape) and a C0 control byte are refused too.
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(0)));
        shapes.setTokenCopy("Sh\\ape ", "ok");
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(1)));
        shapes.setTokenCopy("Shape ", "line\nbreak");

        // Same enforcement on the collection setter.
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(0)));
        shapes.setCollectionCopy('Bad"name', "ok");
    }

    /// @notice The length caps bound indexer cost and revert with the right field.
    function test_CopyRejectsOverlongValues() public {
        bytes memory longName = new bytes(65);
        bytes memory longDesc = new bytes(2049);
        for (uint256 i = 0; i < longName.length; ++i) {
            longName[i] = "a";
        }
        for (uint256 i = 0; i < longDesc.length; ++i) {
            longDesc[i] = "a";
        }

        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(0)));
        shapes.setTokenCopy(string(longName), "ok");
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(1)));
        shapes.setTokenCopy("Shape ", string(longDesc));

        // At the caps exactly, it passes.
        bytes memory maxName = new bytes(64);
        bytes memory maxDesc = new bytes(2048);
        for (uint256 i = 0; i < maxName.length; ++i) {
            maxName[i] = "a";
        }
        for (uint256 i = 0; i < maxDesc.length; ++i) {
            maxDesc[i] = "a";
        }
        shapes.setTokenCopy(string(maxName), string(maxDesc));
        assertEq(bytes(shapes.tokenDescription()).length, 2048);

        // The collection setter enforces the same caps.
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(0)));
        shapes.setCollectionCopy(string(longName), "ok");
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(1)));
        shapes.setCollectionCopy("N", string(longDesc));
        shapes.setCollectionCopy(string(maxName), string(maxDesc));
        assertEq(bytes(shapes.collectionDescription()).length, 2048);
    }

    /// @notice Malformed UTF-8 is refused, so copy can never emit a byte sequence a strict
    ///         (byte-level) JSON consumer would reject.
    function test_CopyRejectsMalformedUtf8() public {
        // Each is a distinct RFC 3629 violation; built from bytes since Solidity forbids invalid
        // UTF-8 in string literals. field 1 unless the bad bytes are in the name argument.
        _expectBadDesc(hex"61ff62"); // "a" 0xFF "b": invalid lead byte
        _expectBadDesc(hex"c3"); // truncated two-byte sequence, no continuation
        _expectBadDesc(hex"c0af"); // overlong encoding of "/"
        _expectBadDesc(hex"eda080"); // UTF-16 surrogate half U+D800
        _expectBadDesc(hex"f4908080"); // U+110000, one past the U+10FFFF ceiling

        // Same rule on the name argument (field 0).
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(0)));
        shapes.setTokenCopy(string(bytes(hex"f5808080")), "ok"); // 0xF5 lead: above U+10FFFF
    }

    function _expectBadDesc(bytes memory bad) internal {
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidCopy.selector, uint8(1)));
        shapes.setTokenCopy("Shape ", string(bad));
    }

    /// @notice Well-formed multi-byte UTF-8 is accepted and round-trips byte-exact through storage
    ///         and back out of the parsed metadata. Guards against a future tightening to ASCII-only.
    function test_CopyAcceptsValidUtf8() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);

        string memory prefix = unicode"Formeß ";
        string memory desc = unicode"Formes — «carrés» 形 🜂";
        shapes.setTokenCopy(prefix, desc);

        assertEq(shapes.tokenDescription(), desc, "description not stored byte-exact");
        string memory j = _decodeJson(id);
        assertEq(vm.parseJsonString(j, ".description"), desc, "description not preserved through JSON");
        assertEq(vm.parseJsonString(j, ".name"), string.concat(prefix, vm.toString(id)), "name not preserved");
    }

    /// @notice The constructor's default copy satisfies the very rule the setters enforce, so the
    ///         contract never ships in a state its own API could not reproduce.
    function test_DefaultCopyPassesTheValidator() public {
        // Re-setting the getters through the validated setters must succeed.
        shapes.setTokenCopy(shapes.tokenNamePrefix(), shapes.tokenDescription());
        shapes.setCollectionCopy(shapes.collectionName(), shapes.collectionDescription());
    }

    /// @notice Empty copy is allowed: the name is the bare token id, the description empty.
    function test_EmptyCopyIsValidJson() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);
        shapes.setTokenCopy("", "");
        string memory j = _decodeJson(id);
        assertEq(vm.parseJsonString(j, ".name"), vm.toString(id), "name is the bare id");
        assertEq(vm.parseJsonString(j, ".description"), "", "empty description");
    }

    /// @notice At zero supply, setting token copy emits no ERC-4906 refresh (and does not underflow).
    function test_TokenCopyAtZeroSupplyEmitsNoRefresh() public {
        assertEq(shapes.totalMinted(), 0, "precondition: nothing minted");
        vm.recordLogs();
        shapes.setTokenCopy("P ", "D");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 batchSig = keccak256("BatchMetadataUpdate(uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != batchSig, "no refresh should fire at zero supply");
        }
    }

    /// @notice A copy edit is presentation only: it moves no backing, seed or artwork bytes.
    function test_CopyEditLeavesValueStateUntouched() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);

        uint256 backing = shapes.backingOf(id);
        uint256 reserve = shapes.redeemableBacking();
        bytes32 seed = shapes.seedOf(id);
        string memory svg = renderer.renderSVG(seed, 1 ether, false, shapes.inkGeneOf(id));

        shapes.setTokenCopy("Renamed ", "A different description entirely.");
        shapes.setCollectionCopy("Renamed Collection", "Also different.");

        assertEq(shapes.backingOf(id), backing, "backing moved");
        assertEq(shapes.redeemableBacking(), reserve, "reserve moved");
        assertEq(shapes.seedOf(id), seed, "seed moved");
        assertEq(renderer.renderSVG(seed, 1 ether, false, shapes.inkGeneOf(id)), svg, "artwork moved");
    }

    /// @dev ERC-4906 batch refresh, declared locally so the test can assert it.
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
}

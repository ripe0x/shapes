// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IAdminControl} from "../src/interfaces/IAdminControl.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapeCollection} from "../src/interfaces/IShapeCollection.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {SplitProvenance} from "../src/interfaces/IShapeRenderer.sol";
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
        Denominations.amountAt(0),
        Denominations.amountAt(1),
        Denominations.amountAt(2),
        Denominations.amountAt(3),
        Denominations.amountAt(4),
        Denominations.amountAt(5),
        Denominations.amountAt(6),
        Denominations.amountAt(7),
        Denominations.amountAt(8)
    ];

    function setUp() public virtual {
        renderer = new ShapeRenderer();
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
    ///      the same whether the mark is solid or outlined: the stroke weight plays no part.
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
    ///      back on it, for every primitive, solid or outlined. If it does not, the solver
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
        vm.expectRevert(abi.encodeWithSelector(Denominations.UnsupportedDenomination.selector, DENOMS[4] * 2));
        renderer.compose(bytes32(uint256(1)), DENOMS[4] * 2, 0);
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
        for (uint256 i = 0; i < 9; ++i) {
            string memory label = Denominations.labelAt(i);
            bytes memory raw = bytes(label);
            if (_contains(label, ".")) {
                assertTrue(raw[raw.length - 1] != bytes1("0"), label);
            }
            string memory json = renderer.metadataJSON(
                bytes32(uint256(7)), DENOMS[i], 1, 1, false, 0, 0, NAME_PREFIX, DESCRIPTION, false
            );
            assertEq(
                vm.parseJsonString(json, ".attributes[0].value"),
                string(abi.encodePacked(label, " ETH")),
                label
            );
        }
    }

    /// @notice The token number lives in the metadata name, not on the card.
    function test_TokenNumberIsInMetadataOnly() public view {
        string memory json = renderer.metadataJSON(
            bytes32(uint256(1)), DENOMS[4], 123, 1, false, 0, 0, NAME_PREFIX, DESCRIPTION, false
        );
        assertEq(vm.parseJsonString(json, ".name"), "Shape 123");
        assertFalse(_contains(renderer.renderSVG(bytes32(uint256(1)), DENOMS[4], false, 0), "123"));
    }

    /// @notice Shape #0 carries its collection role in both its name and one value-only attribute.
    function test_CollectionOwnerTokenHasDistinctMetadataIdentity() public view {
        string memory ownerJson = renderer.metadataJSON(
            bytes32(uint256(1)), DENOMS[0], 0, 1, false, 0, 0, NAME_PREFIX, DESCRIPTION, true
        );
        assertEq(vm.parseJsonString(ownerJson, ".name"), "Shape 0, Contract Owner");
        assertEq(vm.parseJsonString(ownerJson, ".attributes[15].value"), "Contract Owner");
        assertTrue(_contains(ownerJson, ',{"value":"Contract Owner"}'));

        string memory ordinaryJson = renderer.metadataJSON(
            bytes32(uint256(1)), DENOMS[0], 1, 1, false, 0, 0, NAME_PREFIX, DESCRIPTION, false
        );
        assertEq(vm.parseJsonString(ordinaryJson, ".name"), "Shape 1");
        assertFalse(_contains(ordinaryJson, '{"value":"Contract Owner"}'));
    }

    /// @notice tokenURI must decode to real JSON containing a real inline SVG.
    function testFuzz_TokenUriIsValidBase64Json(bytes32 seed, uint8 which, uint16 tokenId) public view {
        uint256 amount = DENOMS[which % 9];
        string memory uri = renderer.tokenURI(
            seed, amount, tokenId, 1, false, _gene(seed), 0, NAME_PREFIX, DESCRIPTION, tokenId == 0
        );

        assertTrue(_startsWith(uri, "data:application/json;base64,"), "json data uri");
        string memory json = string(Base64Decode.decode(_after(uri, "data:application/json;base64,")));

        // real JSON, parseable field by field
        string memory expectedName = tokenId == 0
            ? "Shape 0, Contract Owner"
            : string(abi.encodePacked("Shape ", vm.toString(uint256(tokenId))));
        assertEq(vm.parseJsonString(json, ".name"), expectedName);
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
            renderer.metadataJSON(seed, amount, 1, 1, false, _gene(seed), 0, NAME_PREFIX, DESCRIPTION, false);

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
        string memory json = renderer.metadataJSON(
            seed, amount, 1, 1, false, gene, composeDepth, NAME_PREFIX, DESCRIPTION, false
        );

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
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;
    Shapes internal shapes;
    address internal alice = address(0xA11CE);

    function setUp() public override {
        super.setUp();
        shapes = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, address(0xFEE), address(renderer), 0);
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
        vm.deal(alice, 1_000 ether);
    }

    /// @notice The ETH value shown in metadata must equal the ETH the token actually returns.
    function test_MetadataValueMatchesOnchainBacking() public {
        for (uint256 i = 0; i < 9; ++i) {
            vm.prank(alice);
            uint256 id = shapes.mint{value: DENOMS[i] + MINT_FEE}(DENOMS[i]);

            string memory json =
                string(Base64Decode.decode(_after(shapes.tokenURI(id), "data:application/json;base64,")));

            assertEq(
                vm.parseJsonString(json, ".attributes[0].value"),
                string(abi.encodePacked(Denominations.labelAt(i), " ETH"))
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

    /// @notice The actual Shapes tokenURI path tracks #0's owner-token name through an admin
    ///         change to the ordinary token-name prefix.
    function test_CollectionOwnerIdentityFlowsThroughShapesTokenURI() public {
        string memory initial = _decodeJson(0);
        assertEq(vm.parseJsonString(initial, ".name"), "Shape 0, Contract Owner");
        assertEq(vm.parseJsonString(initial, ".attributes[15].value"), "Contract Owner");
        assertTrue(_contains(initial, ',{"value":"Contract Owner"}'));

        collection.setMetadataCopy("Form ", "A reshaped description of the object.", "An owner description.");
        assertEq(vm.parseJsonString(_decodeJson(0), ".name"), "Form 0, Contract Owner");
    }

    /// @notice The on-chain token drives the provenance traits from its own (originCount, isBlack),
    ///         so a Direct mint, a composed Complete and a Black Shape read differently.
    function test_ProvenanceTraitsReflectOnchainState() public {
        // Direct: one 1 ETH mint. units 100, originCount 1.
        vm.prank(alice);
        uint256 direct = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        string memory dj = _decodeJson(direct);
        // attributes[6..8] are Primitive/Variety/Ink Tier, [9..13] are the provenance block.
        assertEq(vm.parseJsonString(dj, ".attributes[9].value"), "Direct", "direct formation");
        assertEq(vm.parseJsonString(dj, ".attributes[10].value"), "1", "direct origins");
        assertEq(vm.parseJsonString(dj, ".attributes[11].value"), "1%", "direct density");
        assertEq(vm.parseJsonString(dj, ".attributes[12].value"), "false", "direct not complete");
        assertEq(vm.parseJsonString(dj, ".attributes[13].value"), "false", "direct not black");

        // Complete: five 0.01 direct mints composed into one 0.05. units 5, originCount 5.
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + MINT_FEE)}(DENOMS[0], 5);
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
        uint256 whole = shapes.mint{value: DENOMS[8] + MINT_FEE}(DENOMS[8]);
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
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + MINT_FEE)}(DENOMS[0], 5);

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

    /// @notice Split creation-provenance traits (issue #21C): absent from every non-split token,
    ///         and present on a split child as the last two attributes, after Compose Depth.
    ///         `Split From` is the immediate parent's denomination; `Split Origin` is the root
    ///         split ancestor's, which stays fixed across a chain of splits even as `Split From`
    ///         tracks the immediate parent at each generation.
    function test_SplitProvenanceTraitsOnlyOnSplitChildren() public {
        // Non-split token: no Split From / Split Origin trait at all.
        vm.prank(alice);
        uint256 direct = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        string memory dj = _decodeJson(direct);
        assertFalse(_contains(dj, "Split From"), "non-split token carries no Split From trait");
        assertFalse(_contains(dj, "Split Origin"), "non-split token carries no Split Origin trait");

        // Top tier: a direct-minted 100 ETH, split into two 50 ETH children.
        vm.prank(alice);
        uint256 top = shapes.mint{value: DENOMS[8] + MINT_FEE}(DENOMS[8]);
        uint8[] memory topOuts = new uint8[](2);
        topOuts[0] = 7; // 50 ETH
        topOuts[1] = 7;
        vm.prank(alice);
        uint256[] memory mid = shapes.split(top, topOuts);

        // First-generation child: Split From == Split Origin, both the 100 ETH root.
        string memory mj = _decodeJson(mid[0]);
        assertEq(vm.parseJsonString(mj, ".attributes[15].trait_type"), "Split From");
        assertEq(
            vm.parseJsonString(mj, ".attributes[15].value"),
            string(abi.encodePacked(Denominations.labelAt(8), " ETH")),
            "split from the 100 ETH parent"
        );
        assertEq(vm.parseJsonString(mj, ".attributes[16].trait_type"), "Split Origin");
        assertEq(
            vm.parseJsonString(mj, ".attributes[16].value"),
            string(abi.encodePacked(Denominations.labelAt(8), " ETH")),
            "root ancestor is the same 100 ETH parent"
        );

        // Grandchild: split the 50 ETH child again, into five 10 ETH children (5 * 10 = 50).
        // Split From now reads the 50 ETH middle tier; Split Origin still reads the 100 ETH root.
        uint8[] memory midOuts = new uint8[](5);
        for (uint256 i = 0; i < 5; i++) {
            midOuts[i] = 6; // 10 ETH
        }
        vm.prank(alice);
        uint256[] memory bottom = shapes.split(mid[0], midOuts);

        string memory gj = _decodeJson(bottom[0]);
        assertEq(
            vm.parseJsonString(gj, ".attributes[15].value"),
            string(abi.encodePacked(Denominations.labelAt(7), " ETH")),
            "split from the 50 ETH middle tier"
        );
        assertEq(
            vm.parseJsonString(gj, ".attributes[16].value"),
            string(abi.encodePacked(Denominations.labelAt(8), " ETH")),
            "split origin is still the 100 ETH root, two generations up"
        );

        // A split child's own later compose keeps its split traits unchanged: they record
        // creation, not current state (Compose Depth records the later history instead). Four
        // more 10 ETH tokens compose with the 10 ETH grandchild to land on 50 ETH, a valid
        // denomination (10 + 4*10).
        vm.startPrank(alice);
        uint256[] memory burnList = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burnList[i] = shapes.mint{value: DENOMS[6] + MINT_FEE}(DENOMS[6]);
        }
        shapes.compose(bottom[0], burnList);
        vm.stopPrank();
        string memory cj = _decodeJson(bottom[0]);
        assertEq(
            vm.parseJsonString(cj, ".attributes[15].value"),
            string(abi.encodePacked(Denominations.labelAt(7), " ETH")),
            "Split From survives a later compose"
        );
        assertEq(
            vm.parseJsonString(cj, ".attributes[16].value"),
            string(abi.encodePacked(Denominations.labelAt(8), " ETH")),
            "Split Origin survives a later compose"
        );
    }

    function test_TokenUriUsesTheStoredSeed() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        bytes32 seed = shapes.seedOf(id);
        assertEq(
            shapes.tokenURI(id),
            renderer.tokenURI(
                seed, DENOMS[4], id, 1, false, shapes.inkGeneOf(id), 0, NAME_PREFIX, DESCRIPTION, false
            )
        );
    }

    /// @dev Artwork is fixed at mint. Nothing about later chain state may change it.
    function test_ArtworkIsStableForTheLifeOfTheToken() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[5] + MINT_FEE}(DENOMS[5]);
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
    function test_AdminCanUpdateTokenCopy() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        string memory idStr = vm.toString(id);
        assertEq(vm.parseJsonString(_decodeJson(id), ".name"), string.concat("Shape ", idStr), "default name");

        collection.setMetadataCopy("Form ", "A reshaped description of the object.", "An owner description.");

        string memory j = _decodeJson(id);
        assertEq(vm.parseJsonString(j, ".name"), string.concat("Form ", idStr), "name prefix updated");
        assertEq(
            vm.parseJsonString(j, ".description"),
            "A reshaped description of the object.",
            "description updated"
        );
        assertEq(collection.tokenNamePrefix(), "Form ");
        assertEq(collection.description(), "A reshaped description of the object.");
    }

    /// @notice The same description is emitted by token and collection metadata.
    function test_DescriptionIsSharedWithCollectionMetadata() public {
        assertTrue(_contains(_decodeContract(), '"name":"Shapes"'), "default collection name");

        collection.setMetadataCopy(
            collection.tokenNamePrefix(),
            "A rewritten shared description.",
            collection.ownerTokenDescription()
        );

        string memory j = _decodeContract();
        assertEq(vm.parseJsonString(j, ".name"), "Shapes", "collection name follows ERC-721 name");
        assertEq(
            vm.parseJsonString(j, ".description"),
            "A rewritten shared description.",
            "collection desc updated"
        );
        assertEq(collection.description(), "A rewritten shared description.");
    }

    /// @notice A copy edit is two transactions: the collection records the new copy, then
    ///         `refreshMetadata` on the token tells marketplaces to re-read every token and the
    ///         contract-level metadata.
    function test_CopyEditThenRefreshEmitsBothSignals() public {
        vm.prank(alice);
        shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]); // genesis #0 plus public #1

        vm.expectEmit(true, true, true, true, address(collection));
        emit IShapeCollection.MetadataCopySet("P ", "D", "O");
        collection.setMetadataCopy("P ", "D", "O");

        vm.expectEmit(true, true, true, true, address(shapes));
        emit BatchMetadataUpdate(0, 1);
        vm.expectEmit(true, true, true, true, address(shapes));
        emit IShapes.ContractURIUpdated();
        shapes.refreshMetadata();
    }

    function test_NonAdminCannotRefreshMetadata() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.refreshMetadata();
    }

    /// @notice Copy is gated on the token's admin, read live from the token the collection is
    ///         bound to. A non-admin cannot edit it.
    function test_NonAdminCannotUpdateCopy() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        collection.setMetadataCopy("x ", "y", "ok");
        vm.stopPrank();
    }

    /// @notice `lockPresentation` freezes the metadata copy along with the renderer and the
    ///         collection: editable before the lock, `PresentationIsLocked` after it.
    function test_CopyFreezesWithPresentation() public {
        collection.setMetadataCopy("Before ", "Copy is editable while presentation is unlocked.", "ok");
        assertEq(collection.tokenNamePrefix(), "Before ");

        shapes.lockPresentation();

        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        collection.setMetadataCopy("After ", "Copy is frozen once presentation is locked.", "ok");
        assertEq(collection.tokenNamePrefix(), "Before ", "copy changed after the lock");
    }

    /// @notice Copy that would break or restructure the metadata JSON is rejected on set, so no
    ///         edit can produce a malformed or forged document.
    function test_CopyRejectsJsonBreakingBytes() public {
        // A double quote closes the string early and lets the rest forge structure.
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(1)));
        collection.setMetadataCopy("Shape ", 'x","image":"https://evil.example/a.png","attributes":[]}', "ok");

        // Backslash (would start a JSON escape) and a C0 control byte are refused too.
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(0)));
        collection.setMetadataCopy("Sh\\ape ", "ok", "ok");
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(1)));
        collection.setMetadataCopy("Shape ", "line\nbreak", "ok");
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

        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(0)));
        collection.setMetadataCopy(string(longName), "ok", "ok");
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(1)));
        collection.setMetadataCopy("Shape ", string(longDesc), "ok");
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(2)));
        collection.setMetadataCopy("Shape ", "ok", string(longDesc));

        // At the caps exactly, it passes.
        bytes memory maxName = new bytes(64);
        bytes memory maxDesc = new bytes(2048);
        for (uint256 i = 0; i < maxName.length; ++i) {
            maxName[i] = "a";
        }
        for (uint256 i = 0; i < maxDesc.length; ++i) {
            maxDesc[i] = "a";
        }
        collection.setMetadataCopy(string(maxName), string(maxDesc), string(maxDesc));
        assertEq(bytes(collection.description()).length, 2048);
        assertEq(bytes(collection.ownerTokenDescription()).length, 2048);
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
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(0)));
        collection.setMetadataCopy(string(bytes(hex"f5808080")), "ok", "ok"); // 0xF5 lead: above U+10FFFF
    }

    function _expectBadDesc(bytes memory bad) internal {
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.InvalidCopy.selector, uint8(1)));
        collection.setMetadataCopy("Shape ", string(bad), "ok");
    }

    /// @notice Well-formed multi-byte UTF-8 is accepted and round-trips byte-exact through storage
    ///         and back out of the parsed metadata. Guards against a future tightening to ASCII-only.
    function test_CopyAcceptsValidUtf8() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);

        string memory prefix = unicode"Formeß ";
        string memory desc = unicode"Formes — «carrés» 形 🜂";
        collection.setMetadataCopy(prefix, desc, desc);

        assertEq(collection.description(), desc, "description not stored byte-exact");
        string memory j = _decodeJson(id);
        assertEq(vm.parseJsonString(j, ".description"), desc, "description not preserved through JSON");
        assertEq(vm.parseJsonString(j, ".name"), string.concat(prefix, vm.toString(id)), "name not preserved");
    }

    /// @notice The constructor's default copy satisfies the very rule the setters enforce, so the
    ///         contract never ships in a state its own API could not reproduce.
    function test_DefaultCopyPassesTheValidator() public {
        // Re-setting the getters through the validated setters must succeed.
        collection.setMetadataCopy(
            collection.tokenNamePrefix(), collection.description(), collection.ownerTokenDescription()
        );
    }

    /// @notice Empty copy is allowed: the name is the bare token id, the description empty.
    function test_EmptyCopyIsValidJson() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        collection.setMetadataCopy("", "", "");
        string memory j = _decodeJson(id);
        assertEq(vm.parseJsonString(j, ".name"), vm.toString(id), "name is the bare id");
        assertEq(vm.parseJsonString(j, ".description"), "", "empty description");
    }

    /// @notice Genesis means an issued range always exists; even after #0 is redeemed,
    ///         `refreshMetadata` covers the historical range without underflowing.
    function test_RefreshAfterGenesisBurnCoversIssuedRange() public {
        shapes.redeemTo(0, payable(address(0xD15CA4D)));
        assertEq(shapes.totalSupply(), 0, "precondition: no live tokens");
        assertEq(shapes.totalMinted(), 1, "genesis id remains issued");
        vm.recordLogs();
        shapes.refreshMetadata();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 batchSig = keccak256("BatchMetadataUpdate(uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == batchSig) found = true;
        }
        assertTrue(found, "issued range should refresh even at zero live supply");
    }

    /// @notice A copy edit is presentation only: it moves no backing, seed or artwork bytes.
    function test_CopyEditLeavesValueStateUntouched() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);

        uint256 backing = shapes.backingOf(id);
        uint256 reserve = shapes.redeemableBacking();
        bytes32 seed = shapes.seedOf(id);
        string memory svg = renderer.renderSVG(seed, DENOMS[4], false, shapes.inkGeneOf(id));

        collection.setMetadataCopy("Renamed ", "A different description entirely.", "ok");

        assertEq(shapes.backingOf(id), backing, "backing moved");
        assertEq(shapes.redeemableBacking(), reserve, "reserve moved");
        assertEq(shapes.seedOf(id), seed, "seed moved");
        assertEq(renderer.renderSVG(seed, DENOMS[4], false, shapes.inkGeneOf(id)), svg, "artwork moved");
    }

    /* ------------------------ token-id render views ------------------------ */

    /// @dev The two geometry sources every render view selects between: a seed-based mint, and a
    ///      compose survivor carrying materialized module bytes.
    function _seedTokenAndSurvivor() internal returns (uint256 seedToken, uint256 survivor) {
        vm.prank(alice);
        seedToken = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        vm.prank(alice);
        survivor = shapes.mintBatch{value: 5 * (DENOMS[0] + MINT_FEE)}(DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, burnIds);
    }

    /// @dev Every token-id render view against the renderer call it is supposed to be. `id` must
    ///      be live, not Black, not the owner token and not a split child.
    function _assertRenderViewsMatch(uint256 id) internal view {
        bytes memory modules = shapes.modulesOf(id);
        bool sampled = modules.length != 0;
        bytes32 seed = shapes.seedOf(id);
        uint256 amount = shapes.denominationAt(shapes.denomIndexOf(id));
        uint8 gene = shapes.inkGeneOf(id);
        uint256 origins = shapes.originCountOf(id);
        uint256 depth = shapes.composeDepth(id);
        SplitProvenance memory noSplit =
            SplitProvenance({isSplitChild: false, parentDenomIndex: 0, originDenomIndex: 0});

        uint256 cols;
        uint256 rows;
        uint256 count;
        (cols, rows, count) = shapes.geometryOf(id);

        if (sampled) {
            assertEq(shapes.svg(id), renderer.renderSVGSampled(modules, amount, false, gene), "svg");
            assertEq(
                shapes.metadataJSON(id),
                renderer.metadataJSONSampled(
                    modules,
                    amount,
                    id,
                    origins,
                    false,
                    gene,
                    depth,
                    collection.tokenNamePrefix(),
                    collection.description(),
                    noSplit,
                    false
                ),
                "metadataJSON"
            );
            assertEq(
                shapes.effectiveModulesOf(id),
                bytes(renderer.moduleSequenceSampled(modules, amount, gene)),
                "effectiveModulesOf"
            );
            (, uint256 c, uint256 r,,,,, uint256 n) = renderer.cardGeometrySampled(modules, amount, gene);
            assertEq(cols, c, "cols");
            assertEq(rows, r, "rows");
            assertEq(count, n, "moduleCount");
        } else {
            assertEq(shapes.svg(id), renderer.renderSVG(seed, amount, false, gene), "svg");
            assertEq(
                shapes.metadataJSON(id),
                renderer.metadataJSON(
                    seed,
                    amount,
                    id,
                    origins,
                    false,
                    gene,
                    depth,
                    collection.tokenNamePrefix(),
                    collection.description(),
                    false
                ),
                "metadataJSON"
            );
            assertEq(
                shapes.effectiveModulesOf(id),
                bytes(renderer.moduleSequence(seed, amount, gene)),
                "effectiveModulesOf"
            );
            (, uint256 c, uint256 r,,,,, uint256 n) = renderer.cardGeometry(seed, amount, gene);
            assertEq(cols, c, "cols");
            assertEq(rows, r, "rows");
            assertEq(count, n, "moduleCount");
        }

        for (uint256 i = 0; i < count; ++i) {
            assertEq(
                _tokenModule(id, i), _rendererModule(i, modules, seed, amount, gene, sampled), "moduleAt"
            );
        }
    }

    /// @dev One module of `id`, encoded so the whole tuple compares in one assertion.
    function _tokenModule(uint256 id, uint256 index) internal view returns (bytes memory) {
        (uint8 kind, bool solid, uint16 rotation, uint256 cx, uint256 cy, uint256 size, uint256 weight) =
            shapes.moduleAt(id, index);
        return abi.encode(kind, solid, rotation, cx, cy, size, weight);
    }

    /// @dev The same module read straight from the renderer, encoded the same way.
    function _rendererModule(
        uint256 index,
        bytes memory modules,
        bytes32 seed,
        uint256 amount,
        uint8 gene,
        bool sampled
    ) internal view returns (bytes memory) {
        if (sampled) {
            (uint8 kind, bool solid, uint16 rotation, uint256 cx, uint256 cy, uint256 size, uint256 weight) =
                renderer.moduleAtSampled(modules, amount, gene, index);
            return abi.encode(kind, solid, rotation, cx, cy, size, weight);
        }
        (uint8 kind, bool solid, uint16 rotation, uint256 cx, uint256 cy, uint256 size, uint256 weight) =
            renderer.moduleAt(seed, amount, gene, index);
        return abi.encode(kind, solid, rotation, cx, cy, size, weight);
    }

    /// @notice Each token-id render view equals the renderer called with the token's own state,
    ///         on both geometry sources.
    function test_RenderViewsEqualTheRendererOnBothGeometrySources() public {
        (uint256 seedToken, uint256 survivor) = _seedTokenAndSurvivor();
        assertEq(shapes.modulesOf(seedToken).length, 0, "a seed-based mint stores no modules");
        assertGt(shapes.modulesOf(survivor).length, 0, "a compose survivor stores modules");
        _assertRenderViewsMatch(seedToken);
        _assertRenderViewsMatch(survivor);
    }

    /// @notice `effectiveModulesOf` answers for a seed-based token, where `modulesOf` is empty.
    function test_EffectiveModulesAnswerWhereStoredModulesAreEmpty() public {
        (uint256 seedToken,) = _seedTokenAndSurvivor();
        assertEq(shapes.modulesOf(seedToken).length, 0, "stored modules should be empty");
        assertGt(shapes.effectiveModulesOf(seedToken).length, 0, "effective modules should not be");
    }

    /// @notice Every render view reverts for a burned id, exactly as `tokenURI` does.
    function test_RenderViewsRevertForABurnedId() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
        vm.prank(alice);
        shapes.redeem(id);

        bytes memory expected = abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id);
        vm.expectRevert(expected);
        shapes.svg(id);
        vm.expectRevert(expected);
        shapes.metadataJSON(id);
        vm.expectRevert(expected);
        shapes.geometryOf(id);
        vm.expectRevert(expected);
        shapes.effectiveModulesOf(id);
        vm.expectRevert(expected);
        shapes.moduleAt(id, 0);
        vm.expectRevert(expected);
        shapes.tokenURI(id);
    }

    /// @dev ERC-4906 batch refresh, declared locally so the test can assert it.
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
}

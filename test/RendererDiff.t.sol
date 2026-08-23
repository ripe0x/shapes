// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";
import {IShapeGeometry} from "../src/interfaces/IShapeGeometry.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {ModuleCodec} from "../src/lib/ModuleCodec.sol";

import {ShapeRendererLegacy} from "./legacy/ShapeRendererLegacy.sol";

/// @notice Differential test between the pre-refactor `ShapeRenderer` (git 0956abf) and the
///         current one.
/// @dev The refactor re-associated every `abi.encodePacked` call of 12+ arguments into
///      `bytes.concat` of ~5-argument chunks, to fit `forge coverage`'s Yul stack limit. The
///      change touches only `_moduleSvg`'s per-kind path builders and `_metadataFromCard`'s
///      final assembly; every other function is untouched (confirmed by diffing the two files).
///      `Parity.t.sol` pins output against ~80 fixed TypeScript fixtures; this sweeps the input
///      space instead, fuzzed and exhaustive, and compares raw call data so a revert on one side
///      and a revert on the other are compared byte for byte along with success output.
contract RendererDiffTest is Test {
    string internal constant NAME_PREFIX = "Shape ";
    string internal constant DESCRIPTION =
        "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH.";

    ShapeRenderer internal r;
    ShapeRendererLegacy internal legacy;

    function setUp() public {
        r = new ShapeRenderer();
        legacy = new ShapeRendererLegacy();
    }

    /* ---------------------------------------------------------------- *
     *  Diff harness
     * ---------------------------------------------------------------- */

    /// @dev Same calldata against both deployments; raw return/revert bytes compared. A revert
    ///      on one side and a success (or a different revert reason) on the other both fail
    ///      here, since `okNew != okLegacy` or `outNew != outLegacy`.
    function _diff(bytes memory data) internal view {
        (bool okNew, bytes memory outNew) = address(r).staticcall(data);
        (bool okLegacy, bytes memory outLegacy) = address(legacy).staticcall(data);
        assertEq(okNew, okLegacy, "success/revert mismatch");
        assertEq(outNew, outLegacy, "return/revert data mismatch");
    }

    function _denom(uint8 raw) internal pure returns (uint256 amountWei, uint256 denomIndex) {
        denomIndex = bound(raw, 0, Denominations.COUNT - 1);
        amountWei = Denominations.amountAt(denomIndex);
    }

    function _gene(uint8 raw) internal pure returns (uint8) {
        return uint8(bound(raw, 0, 6));
    }

    /// @dev A valid module array for `denomIndex`: one keccak draw per cell, mapped onto a
    ///      `ModuleCodec.isValid` byte.
    function _validModules(bytes32 seed, uint256 denomIndex) internal pure returns (bytes memory modules) {
        (uint256 cols, uint256 rows) = Denominations.gridAt(denomIndex);
        uint256 n = cols * rows;
        modules = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 rnd = uint256(keccak256(abi.encodePacked(seed, i)));
            uint256 kind = rnd % ModuleCodec.KIND_COUNT;
            uint256 rc = ModuleCodec.rotCount(kind);
            uint256 rotIndex = (rnd >> 8) % rc;
            bool solid = (rnd >> 16) & 1 == 1;
            modules[i] = ModuleCodec.encode(kind, solid, rotIndex);
        }
    }

    /// @dev Every byte 0..255 for which `ModuleCodec.isValid` holds: every (kind, rotation,
    ///      solid) combination the codec accepts.
    function _allValidBytes() internal pure returns (bytes memory out) {
        bytes memory buf = new bytes(256);
        uint256 n;
        for (uint256 b = 0; b < 256; ++b) {
            bytes1 v = bytes1(uint8(b));
            if (ModuleCodec.isValid(v)) buf[n++] = v;
        }
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = buf[i];
        }
    }

    /* ---------------------------------------------------------------- *
     *  Fuzz: seed-derived geometry (grammar v1, `compose`)
     * ---------------------------------------------------------------- */

    /// forge-config: default.fuzz.runs = 4096
    function testFuzz_SeedPath_RenderAndModuleSurfaces(
        bytes32 seed,
        uint8 denomRaw,
        uint8 geneRaw,
        bool inverted
    ) public view {
        (uint256 amountWei,) = _denom(denomRaw);
        uint8 gene = _gene(geneRaw);
        _diff(abi.encodeCall(IShapeRenderer.renderSVG, (seed, amountWei, inverted, gene)));
        _diff(abi.encodeCall(IShapeRenderer.moduleSequence, (seed, amountWei, gene)));
        _diff(abi.encodeCall(IShapeRenderer.renderUnicode, (seed, amountWei, gene)));
        _diff(abi.encodeCall(IShapeGeometry.cardGeometry, (seed, amountWei, gene)));
        _diff(abi.encodeCall(IShapeGeometry.moduleAt, (seed, amountWei, gene, 0)));
    }

    function testFuzz_SeedPath_MetadataAndTokenURI(
        bytes32 seed,
        uint8 denomRaw,
        uint8 geneRaw,
        bool inverted,
        uint256 tokenId,
        uint256 originCount,
        uint256 composeDepth
    ) public view {
        (uint256 amountWei,) = _denom(denomRaw);
        uint8 gene = _gene(geneRaw);
        _diff(
            abi.encodeCall(
                IShapeRenderer.metadataJSON,
                (
                    seed,
                    amountWei,
                    tokenId,
                    originCount,
                    inverted,
                    gene,
                    composeDepth,
                    NAME_PREFIX,
                    DESCRIPTION
                )
            )
        );
        _diff(
            abi.encodeCall(
                IShapeRenderer.tokenURI,
                (
                    seed,
                    amountWei,
                    tokenId,
                    originCount,
                    inverted,
                    gene,
                    composeDepth,
                    NAME_PREFIX,
                    DESCRIPTION
                )
            )
        );
    }

    /* ---------------------------------------------------------------- *
     *  Fuzz: materialized geometry (grammar v2, `composeSampled`)
     * ---------------------------------------------------------------- */

    /// forge-config: default.fuzz.runs = 4096
    function testFuzz_SampledPath_RenderAndModuleSurfaces(
        bytes32 seed,
        uint8 denomRaw,
        uint8 geneRaw,
        bool inverted
    ) public view {
        (uint256 amountWei, uint256 denomIndex) = _denom(denomRaw);
        uint8 gene = _gene(geneRaw);
        bytes memory modules = _validModules(seed, denomIndex);
        _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, inverted, gene)));
        _diff(abi.encodeCall(IShapeRenderer.moduleSequenceSampled, (modules, amountWei, gene)));
        _diff(abi.encodeCall(IShapeRenderer.renderUnicodeSampled, (modules, amountWei, gene)));
        _diff(abi.encodeCall(IShapeGeometry.cardGeometrySampled, (modules, amountWei, gene)));
        _diff(abi.encodeCall(IShapeGeometry.moduleAtSampled, (modules, amountWei, gene, 0)));
    }

    function testFuzz_SampledPath_MetadataAndTokenURI(
        bytes32 seed,
        uint8 denomRaw,
        uint8 geneRaw,
        bool inverted,
        uint256 tokenId,
        uint256 originCount,
        uint256 composeDepth
    ) public view {
        (uint256 amountWei, uint256 denomIndex) = _denom(denomRaw);
        uint8 gene = _gene(geneRaw);
        bytes memory modules = _validModules(seed, denomIndex);
        _diff(
            abi.encodeCall(
                IShapeRenderer.metadataJSONSampled,
                (
                    modules,
                    amountWei,
                    tokenId,
                    originCount,
                    inverted,
                    gene,
                    composeDepth,
                    NAME_PREFIX,
                    DESCRIPTION
                )
            )
        );
        _diff(
            abi.encodeCall(
                IShapeRenderer.tokenURISampled,
                (
                    modules,
                    amountWei,
                    tokenId,
                    originCount,
                    inverted,
                    gene,
                    composeDepth,
                    NAME_PREFIX,
                    DESCRIPTION
                )
            )
        );
    }

    /* ---------------------------------------------------------------- *
     *  Exhaustive: every (denomination x ink gene x inverted) triple
     * ---------------------------------------------------------------- */

    function test_ExhaustiveDenomGeneInvertedSweep_SeedPath() public view {
        bytes32[4] memory seeds =
            [bytes32(0), bytes32(uint256(1)), keccak256("shapes/difftest/sweep"), bytes32(type(uint256).max)];
        for (uint256 di = 0; di < Denominations.COUNT; ++di) {
            uint256 amountWei = Denominations.amountAt(di);
            for (uint8 gene = 0; gene < 7; ++gene) {
                for (uint256 s = 0; s < seeds.length; ++s) {
                    bytes32 seed = seeds[s];
                    _diff(abi.encodeCall(IShapeRenderer.renderSVG, (seed, amountWei, false, gene)));
                    _diff(abi.encodeCall(IShapeRenderer.renderSVG, (seed, amountWei, true, gene)));
                    _diff(abi.encodeCall(IShapeRenderer.moduleSequence, (seed, amountWei, gene)));
                    _diff(abi.encodeCall(IShapeRenderer.renderUnicode, (seed, amountWei, gene)));
                }
            }
        }
    }

    function test_ExhaustiveDenomGeneInvertedSweep_SampledPath() public view {
        bytes32[2] memory seeds = [bytes32(uint256(7)), keccak256("shapes/difftest/sampled-sweep")];
        for (uint256 di = 0; di < Denominations.COUNT; ++di) {
            uint256 amountWei = Denominations.amountAt(di);
            for (uint8 gene = 0; gene < 7; ++gene) {
                for (uint256 s = 0; s < seeds.length; ++s) {
                    bytes memory modules = _validModules(seeds[s], di);
                    _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, false, gene)));
                    _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, true, gene)));
                    _diff(abi.encodeCall(IShapeRenderer.moduleSequenceSampled, (modules, amountWei, gene)));
                    _diff(abi.encodeCall(IShapeRenderer.renderUnicodeSampled, (modules, amountWei, gene)));
                }
            }
        }
    }

    /* ---------------------------------------------------------------- *
     *  Exhaustive: every valid module byte (primitive x rotation x solid)
     * ---------------------------------------------------------------- */

    /// @notice Every `ModuleCodec.isValid` byte, in isolation on a 1x1 grid, across a spread of
    ///         ink genes and both inverted states.
    function test_ExhaustiveValidModuleByte_SingleCellGrid() public view {
        bytes memory validBytes = _allValidBytes();
        assertGt(validBytes.length, 0, "no valid module bytes found");
        uint256 amountWei = Denominations.amountAt(8); // 1x1 grid
        uint8[3] memory genes = [0, 3, 6];
        for (uint256 i = 0; i < validBytes.length; ++i) {
            bytes memory modules = new bytes(1);
            modules[0] = validBytes[i];
            for (uint256 g = 0; g < genes.length; ++g) {
                _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, false, genes[g])));
                _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, true, genes[g])));
            }
        }
    }

    /// @notice Every valid module byte again, cycled across the largest grid (5x5, 25 cells) so
    ///         every primitive also appears alongside every other one in the same SVG body and
    ///         the same metadata JSON.
    function test_ExhaustiveValidModuleByte_MaxGridCycled() public view {
        bytes memory validBytes = _allValidBytes();
        uint256 amountWei = Denominations.amountAt(0); // 5x5 = 25 cells, the largest grid
        uint256 n = 25;
        bytes memory modules = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            modules[i] = validBytes[i % validBytes.length];
        }
        for (uint8 gene = 0; gene < 7; ++gene) {
            _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, false, gene)));
            _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, true, gene)));
            _diff(
                abi.encodeCall(
                    IShapeRenderer.metadataJSONSampled,
                    (modules, amountWei, 12345, 3, false, gene, 2, NAME_PREFIX, DESCRIPTION)
                )
            );
        }
    }

    /* ---------------------------------------------------------------- *
     *  Boundary values
     * ---------------------------------------------------------------- */

    function test_TokenIdAndComposeDepthBoundaries() public view {
        bytes32 seed = keccak256("shapes/difftest/boundary");
        uint256 amountWei = Denominations.amountAt(4);
        uint256[2] memory tokenIds = [uint256(0), type(uint256).max];
        uint256[2] memory depths = [uint256(0), type(uint256).max];
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            for (uint256 j = 0; j < depths.length; ++j) {
                _diff(
                    abi.encodeCall(
                        IShapeRenderer.metadataJSON,
                        (
                            seed,
                            amountWei,
                            tokenIds[i],
                            1,
                            false,
                            uint8(3),
                            depths[j],
                            NAME_PREFIX,
                            DESCRIPTION
                        )
                    )
                );
            }
        }
    }

    /// @notice `originCount` sweeps 0, 1, exactly `units` (Complete), `units + 1`, and
    ///         `type(uint256).max` (overflows `_densityPercent`'s `originCount * 10000`, so both
    ///         sides must revert the same way) at every denomination.
    function test_OriginCountBoundaries() public view {
        bytes32 seed = keccak256("shapes/difftest/origin-boundary");
        for (uint256 di = 0; di < Denominations.COUNT; ++di) {
            uint256 amountWei = Denominations.amountAt(di);
            uint256 units = Denominations.unitsAt(di);
            uint256[5] memory originCounts = [uint256(0), 1, units, units + 1, type(uint256).max];
            for (uint256 i = 0; i < originCounts.length; ++i) {
                _diff(
                    abi.encodeCall(
                        IShapeRenderer.metadataJSON,
                        (seed, amountWei, 1, originCounts[i], false, uint8(2), 0, NAME_PREFIX, DESCRIPTION)
                    )
                );
            }
        }
    }

    /// @notice An empty array and lengths one under/over the grid's cell count, at the largest
    ///         grid (25 cells): both sides must revert `InvalidModuleLength` identically.
    function test_EmptyAndWrongLengthModulesRevertIdentically() public view {
        uint256 amountWei = Denominations.amountAt(0); // 25-cell grid
        _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (new bytes(0), amountWei, false, uint8(0))));
        _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (new bytes(24), amountWei, false, uint8(0))));
        _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (new bytes(26), amountWei, false, uint8(0))));
    }

    /// @notice Every byte that fails `ModuleCodec.isValid` (bit 7 set, kind >= 10, or a
    ///         rotation the kind does not take): both sides must revert `InvalidModuleByte`
    ///         identically.
    function test_InvalidModuleByteRevertsIdentically() public view {
        uint256 amountWei = Denominations.amountAt(8); // 1-cell grid
        uint256 checked;
        for (uint256 b = 0; b < 256; ++b) {
            bytes1 v = bytes1(uint8(b));
            if (ModuleCodec.isValid(v)) continue;
            bytes memory modules = new bytes(1);
            modules[0] = v;
            _diff(abi.encodeCall(IShapeRenderer.renderSVGSampled, (modules, amountWei, false, uint8(0))));
            ++checked;
        }
        assertGt(checked, 0, "no invalid module bytes found");
    }

    /// @notice An out-of-range and a maximal out-of-range module index: both sides must revert
    ///         `ModuleIndexOutOfRange` identically.
    function test_ModuleIndexOutOfRangeRevertsIdentically() public view {
        bytes32 seed = keccak256("shapes/difftest/module-index");
        uint256 amountWei = Denominations.amountAt(8); // 1-cell grid, count == 1
        _diff(abi.encodeCall(IShapeGeometry.moduleAt, (seed, amountWei, uint8(0), 1)));
        _diff(abi.encodeCall(IShapeGeometry.moduleAt, (seed, amountWei, uint8(0), type(uint256).max)));
    }

    function test_GrammarVersionAndHashMatch() public view {
        _diff(abi.encodeCall(IShapeGeometry.grammarVersion, ()));
        _diff(abi.encodeCall(IShapeGeometry.grammarHash, ()));
    }
}

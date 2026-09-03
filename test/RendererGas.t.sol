// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {SplitProvenance} from "../src/interfaces/IShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {ModuleCodec} from "../src/lib/ModuleCodec.sol";

/// @notice Reproducible one- and 25-module gas probes for D-32's renderer-only refactor gate.
/// @dev Run with `forge test --match-contract RendererGasTest -vv`. Forge reports each test's
///      gas independently, making the before/after comparison stable on the pinned toolchain.
contract RendererGasTest is Test {
    string internal constant NAME_PREFIX = "Shape ";
    string internal constant DESCRIPTION =
        "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH.";

    ShapeRenderer internal renderer;

    function setUp() public {
        renderer = new ShapeRenderer();
    }

    function _modules(uint256 count) internal pure returns (bytes memory modules) {
        modules = new bytes(count);
        for (uint256 i = 0; i < count; ++i) {
            uint256 kind = i % ModuleCodec.KIND_COUNT;
            modules[i] = ModuleCodec.encode(kind, i % 2 == 0, i % ModuleCodec.rotCount(kind));
        }
    }

    function _splitInfo() internal pure returns (SplitProvenance memory) {
        return SplitProvenance({isSplitChild: false, parentDenomIndex: 0, originDenomIndex: 0});
    }

    function testGas_SeedSvg_OneModule() public view {
        assertGt(
            bytes(renderer.renderSVG(bytes32(uint256(1)), Denominations.amountAt(8), false, 3)).length, 0
        );
    }

    function testGas_SeedSvg_25Modules() public view {
        assertGt(
            bytes(renderer.renderSVG(bytes32(uint256(1)), Denominations.amountAt(0), false, 3)).length, 0
        );
    }

    function testGas_SampledSvg_OneModule() public view {
        assertGt(bytes(renderer.renderSVGSampled(_modules(1), Denominations.amountAt(8), false, 3)).length, 0);
    }

    function testGas_SampledSvg_25Modules() public view {
        assertGt(
            bytes(renderer.renderSVGSampled(_modules(25), Denominations.amountAt(0), false, 3)).length, 0
        );
    }

    function testGas_SeedMetadata_OneModule() public view {
        assertGt(
            bytes(
                renderer.metadataJSON(
                    bytes32(uint256(1)),
                    Denominations.amountAt(8),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SeedMetadata_25Modules() public view {
        assertGt(
            bytes(
                renderer.metadataJSON(
                    bytes32(uint256(1)),
                    Denominations.amountAt(0),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SampledMetadata_OneModule() public view {
        assertGt(
            bytes(
                renderer.metadataJSONSampled(
                    _modules(1),
                    Denominations.amountAt(8),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    _splitInfo(),
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SampledMetadata_25Modules() public view {
        assertGt(
            bytes(
                renderer.metadataJSONSampled(
                    _modules(25),
                    Denominations.amountAt(0),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    _splitInfo(),
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SeedTokenUri_OneModule() public view {
        assertGt(
            bytes(
                renderer.tokenURI(
                    bytes32(uint256(1)),
                    Denominations.amountAt(8),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SeedTokenUri_25Modules() public view {
        assertGt(
            bytes(
                renderer.tokenURI(
                    bytes32(uint256(1)),
                    Denominations.amountAt(0),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SampledTokenUri_OneModule() public view {
        assertGt(
            bytes(
                renderer.tokenURISampled(
                    _modules(1),
                    Denominations.amountAt(8),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    _splitInfo(),
                    false
                )
            )
            .length,
            0
        );
    }

    function testGas_SampledTokenUri_25Modules() public view {
        assertGt(
            bytes(
                renderer.tokenURISampled(
                    _modules(25),
                    Denominations.amountAt(0),
                    1,
                    1,
                    false,
                    3,
                    0,
                    NAME_PREFIX,
                    DESCRIPTION,
                    _splitInfo(),
                    false
                )
            )
            .length,
            0
        );
    }
}

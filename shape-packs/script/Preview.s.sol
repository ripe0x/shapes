// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {Shapes} from "shapes/Shapes.sol";
import {ShapeRenderer} from "shapes/ShapeRenderer.sol";
import {ShapeCollection} from "shapes/ShapeCollection.sol";
import {Denominations} from "shapes/lib/Denominations.sol";

import {ShapePacks} from "../src/ShapePacks.sol";
import {ShapePackRenderer} from "../src/ShapePackRenderer.sol";

/// @notice Writes sample pack artwork and metadata to `preview/` from a throwaway local Shapes.
///         Nothing is broadcast. `forge script script/Preview.s.sol`.
contract Preview is Script {
    /// @dev Everything runs as a funded EOA, since a script contract's own address is ephemeral.
    address internal constant USER = address(0xBEEF);

    function run() external {
        vm.deal(USER, 10_000 ether);
        vm.startPrank(USER);
        ShapeRenderer shapeRenderer = new ShapeRenderer();
        uint256 fee = Denominations.UNIT / 10;
        Shapes shapes = new Shapes{value: Denominations.UNIT}(fee, address(0xFEE), address(shapeRenderer), 0);
        shapes.setCollection(address(new ShapeCollection(shapeRenderer, shapes)));
        ShapePackRenderer renderer = new ShapePackRenderer(address(shapes));
        ShapePacks packs = new ShapePacks(address(shapes), address(renderer), USER);

        uint32[] memory counts = new uint32[](shapes.denominationCount());
        uint256[] memory none;

        counts[1] = 1;
        _write(packs, renderer, packs.createPack{value: _cost(shapes, counts)}(none, counts), "pack-1");

        counts[1] = 0;
        counts[0] = 3;
        _write(packs, renderer, packs.createPack{value: _cost(shapes, counts)}(none, counts), "pack-3");

        counts[0] = 6;
        counts[2] = 2;
        counts[4] = 2;
        _write(packs, renderer, packs.createPack{value: _cost(shapes, counts)}(none, counts), "pack-10");

        vm.writeFile("preview/collection.uri.txt", packs.contractURI());
        vm.stopPrank();
    }

    function _cost(Shapes shapes, uint32[] memory counts) private view returns (uint256 total) {
        for (uint256 d = 0; d < counts.length; ++d) {
            total += uint256(counts[d]) * (Denominations.amountAt(d) + shapes.mintFee());
        }
    }

    function _write(ShapePacks packs, ShapePackRenderer, uint256 packId, string memory name) private {
        vm.writeFile(string.concat("preview/", name, ".uri.txt"), packs.tokenURI(packId));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Seeds a deployed Shapes with the token shapes the provenance view is built to show:
///         a multi donor compose, a stacked compose whose donors include the survivor's own
///         earlier state, and split children. Every call stays well inside one block.
///
/// @dev    SHAPES_ADDRESS=0x... forge script script/SeedExamples.s.sol \
///           --rpc-url $RPC --account <account> --sender 0x<you> --broadcast
contract SeedExamples is Script {
    Shapes internal shapes;
    uint256 internal mintFee;

    function run() external {
        shapes = Shapes(payable(vm.envAddress("SHAPES_ADDRESS")));
        mintFee = shapes.mintFee();

        vm.startBroadcast();

        // A five donor compose: five index 0 cards become one index 3 card, so the result's
        // cells trace back to five different originals.
        uint256 aFirst = _mintBatch(0, 5);
        uint256 composed = _composeRange(aFirst, aFirst + 1, 4);
        console.log("composed index 3 from 5 index 0, depth 1:", composed);

        // Stack a second compose onto the same survivor. Its donors then include its own prior
        // state, which is the case the drill in view exists for.
        uint256 bFirst = _mintBatch(0, 5);
        uint256 second = _composeRange(bFirst, bFirst + 1, 4);
        uint256[] memory burn = new uint256[](1);
        burn[0] = second;
        shapes.compose(composed, burn);
        console.log("stacked to index 4, depth 2:", composed);

        // Split a fresh index 3 card into five index 2 children, each carrying split provenance
        // back to a parent that no longer exists.
        uint256 parent = _mint(3);
        uint8[] memory outs = new uint8[](5);
        for (uint256 i = 0; i < 5; i++) {
            outs[i] = 2;
        }
        uint256[] memory kids = shapes.split(parent, outs);
        console.log("split index 3 into 5 children, first:", kids[0]);

        vm.stopBroadcast();

        console.log("total minted", shapes.totalMinted());
    }

    function _mint(uint256 di) internal returns (uint256) {
        uint256 wei_ = Denominations.amountAt(di);
        return shapes.mint{value: wei_ + mintFee}(wei_);
    }

    function _mintBatch(uint256 di, uint256 quantity) internal returns (uint256) {
        uint256 wei_ = Denominations.amountAt(di);
        uint256 unit = wei_ + mintFee;
        return shapes.mintBatch{value: unit * quantity}(wei_, quantity);
    }

    function _composeRange(uint256 survivorId, uint256 firstBurn, uint256 count) internal returns (uint256) {
        uint256[] memory burns = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            burns[i] = firstBurn + i;
        }
        return shapes.compose(survivorId, burns);
    }
}

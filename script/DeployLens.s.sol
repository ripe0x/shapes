// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {LensEquivalence} from "./LensEquivalence.s.sol";

/// @notice Deploys a replacement `ShapeLens` against an already-deployed `Shapes`.
///
/// @dev A lens holds no state and no privileged position over the token, so replacing one is a
///      plain redeploy: nothing on `Shapes` points back at it, and clients pick up the new
///      address from configuration. The risk is linkage. `ShapeLens.previewCompose` and
///      `Shapes.compose` are bit-identical only while both resolve `ComposeCompute` to the same
///      deployment, and this script builds fresh library instances from the current working tree,
///      which the existing `Shapes` has never called. `_assertLensEquivalence` runs the compose
///      path through both contracts and requires the results to match before the script reports
///      success.
///
///        SHAPES_ADDRESS  the deployed token the new lens reads. Required.
///
///      Dry run first, always:
///        SHAPES_ADDRESS=0x... forge script script/DeployLens.s.sol --rpc-url $RPC
///        SHAPES_ADDRESS=0x... forge script script/DeployLens.s.sol --rpc-url $RPC \
///          --broadcast --verify
contract DeployLens is LensEquivalence {
    function run() external returns (ShapeLens lens) {
        address shapesAddress = vm.envAddress("SHAPES_ADDRESS");
        require(shapesAddress.code.length != 0, "SHAPES_ADDRESS has no code");
        Shapes shapes = Shapes(payable(shapesAddress));

        vm.startBroadcast();
        lens = new ShapeLens(shapesAddress);
        vm.stopBroadcast();

        _assertLensEquivalence(shapes, lens);

        console.log("chain id      ", block.chainid);
        console.log("Shapes        ", shapesAddress);
        console.log("ShapeLens     ", address(lens));
    }
}

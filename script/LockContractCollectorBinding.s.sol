// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeLens} from "../src/ShapeLens.sol";

/// @notice Permanently locks the contract collector token pointer on an already-deployed Shapes.
///
/// @dev Irreversible: there is no unlock. Keep set and lock as separate invocations so the
///      pointer can be reviewed before it becomes permanent.
///
///        SHAPES_ADDRESS                            the deployed Shapes contract.
///        LENS_ADDRESS                              the deployed ShapeLens for SHAPES_ADDRESS.
///        CONFIRM_LOCK_CONTRACT_COLLECTOR_BINDING    must be "true" to broadcast. Defaults to false.
///
///      Dry run (no broadcast, just logs the current state):
///        SHAPES_ADDRESS=0x... LENS_ADDRESS=0x... \
///          forge script script/LockContractCollectorBinding.s.sol --rpc-url $RPC
///
///      Real lock:
///        SHAPES_ADDRESS=0x... LENS_ADDRESS=0x... CONFIRM_LOCK_CONTRACT_COLLECTOR_BINDING=true \
///          forge script script/LockContractCollectorBinding.s.sol \
///          --rpc-url $RPC --account ripe0x --broadcast
contract LockContractCollectorBinding is Script {
    function run() external {
        Shapes shapes = Shapes(payable(vm.envAddress("SHAPES_ADDRESS")));
        ShapeLens lens = ShapeLens(vm.envAddress("LENS_ADDRESS"));
        bool confirmed = vm.envOr("CONFIRM_LOCK_CONTRACT_COLLECTOR_BINDING", false);

        require(address(lens.shapes()) == address(shapes), "lens points at another token");

        (address tokenContract, uint256 tokenId, bool alreadyLocked) = shapes.contractCollectorBinding();
        console.log("token contract", tokenContract);
        console.log("token id      ", tokenId);
        console.log("collector     ", lens.contractCollector());
        console.log("already locked", alreadyLocked);

        if (tokenContract == address(0)) revert("collector token not set");

        if (!confirmed) {
            console.log("dry run: set CONFIRM_LOCK_CONTRACT_COLLECTOR_BINDING=true to lock");
            return;
        }

        vm.startBroadcast();
        shapes.lockContractCollectorBinding();
        vm.stopBroadcast();

        (,, bool locked) = shapes.contractCollectorBinding();
        require(locked, "binding did not lock");
        console.log("binding locked");
    }
}

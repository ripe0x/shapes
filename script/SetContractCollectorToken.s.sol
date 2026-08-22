// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeLens} from "../src/ShapeLens.sol";

/// @notice Sets or replaces the contract collector token pointer on an already-deployed Shapes.
///
/// @dev Owner only, and only while the binding is unlocked. Does not lock; run
///      `LockContractCollectorBinding.s.sol` separately once the pointer is final.
///
///        SHAPES_ADDRESS            the deployed Shapes contract.
///        LENS_ADDRESS              the deployed ShapeLens for SHAPES_ADDRESS, for the read-back.
///        COLLECTOR_TOKEN_CONTRACT  the ERC-721 contract whose current owner becomes the collector.
///        COLLECTOR_TOKEN_ID        the token id within that contract.
///
///      forge script script/SetContractCollectorToken.s.sol \
///        --rpc-url $RPC --account ripe0x --broadcast
contract SetContractCollectorToken is Script {
    function run() external {
        Shapes shapes = Shapes(payable(vm.envAddress("SHAPES_ADDRESS")));
        ShapeLens lens = ShapeLens(vm.envAddress("LENS_ADDRESS"));
        address tokenContract = vm.envAddress("COLLECTOR_TOKEN_CONTRACT");
        uint256 tokenId = vm.envUint("COLLECTOR_TOKEN_ID");

        require(address(lens.shapes()) == address(shapes), "lens points at another token");

        (address previousTokenContract, uint256 previousTokenId,) = shapes.contractCollectorBinding();
        console.log("current token contract", previousTokenContract);
        console.log("current token id      ", previousTokenId);
        console.log("current collector     ", lens.contractCollector());

        console.log("candidate token contract", tokenContract);
        console.log("candidate token id      ", tokenId);

        vm.startBroadcast();
        shapes.setContractCollectorToken(tokenContract, tokenId);
        vm.stopBroadcast();

        (address newTokenContract, uint256 newTokenId, bool locked) = shapes.contractCollectorBinding();
        require(newTokenContract == tokenContract, "token contract did not update");
        require(newTokenId == tokenId, "token id did not update");
        require(!locked, "binding should still be unlocked");

        console.log("new token contract", newTokenContract);
        console.log("new token id      ", newTokenId);
        console.log("resolved collector", lens.contractCollector());
    }
}

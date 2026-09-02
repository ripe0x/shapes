// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Mints a small spread into an already-deployed Shapes so a testnet gallery has content.
///
/// @dev Run with a fixed --gas-limit so forge does not over-reserve gas on the guarded mint (its
///      SSTORE refund inflates eth_estimateGas, which otherwise trips OutOfFunds in the dry run):
///
///        SHAPES_ADDRESS=0x... forge script script/SeedShapes.s.sol \
///          --rpc-url $SEPOLIA_RPC_URL --account ripe0x --sender 0x<you> \
///          --gas-limit 800000 --broadcast
contract SeedShapes is Script {
    function run() external {
        Shapes shapes = Shapes(payable(vm.envAddress("SHAPES_ADDRESS")));
        uint256 mintFee = shapes.mintFee();
        address me = msg.sender;

        // five 0.01, two 0.05, one 0.1 (indices 0,1,2)
        uint8[3] memory counts = [5, 2, 1];

        vm.startBroadcast();
        for (uint256 di = 0; di < counts.length; di++) {
            uint256 wei_ = Denominations.amountAt(di);
            for (uint256 n = 0; n < counts[di]; n++) {
                shapes.mint{value: wei_ + mintFee}(wei_);
            }
        }
        vm.stopBroadcast();
    }
}

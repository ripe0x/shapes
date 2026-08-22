// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Testnet deploy + seed: deploys the renderer and token, then mints a small spread so the
///         gallery has content, all in one broadcast (one keystore prompt).
///
/// @dev Fee recipient defaults to the deployer (fine on a throwaway testnet; on mainnet it is an
///      immutable decision — use DeployShapes.s.sol there with SHAPES_FEE_RECIPIENT set).
///
///      The contract collector binding is not configured here. Configure the pointer later with
///      `SetContractCollectorToken.s.sol` and lock it with `LockContractCollectorBinding.s.sol`.
///
///        SHAPES_FEE_BPS   mint fee in basis points. Defaults to 100 (1%).
///        SEED_ETH         set to "false" to deploy without seeding any mints.
///
///      forge script script/DeploySepolia.s.sol \
///        --rpc-url $SEPOLIA_RPC_URL --account ripe0x --broadcast --verify
contract DeploySepolia is Script {
    uint256 internal constant DEFAULT_FEE_BPS = 100; // 1%

    function run()
        external
        returns (
            ShapeRenderer renderer,
            ShapeCollection collection,
            Shapes shapes,
            ShapeLens lens,
            ShapeAuctionHouse house
        )
    {
        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        bool seed = vm.envOr("SEED_ETH", true);
        address me = msg.sender;

        vm.startBroadcast();

        renderer = new ShapeRenderer();

        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(feeBps, me, address(renderer), address(collection));
        lens = new ShapeLens(address(shapes));
        house = new ShapeAuctionHouse(address(shapes));

        if (seed) {
            // A modest spread across the low denominations: five 0.01, two 0.05, one 0.1. Total
            // backing ~0.15 ETH; with the 1% fee and gas, fund the deployer with ~0.25 Sepolia ETH.
            uint8[3] memory counts = [5, 2, 1]; // by denomination index 0,1,2
            for (uint256 di = 0; di < counts.length; di++) {
                uint256 wei_ = Denominations.amountAt(di);
                uint256 fee = (wei_ * feeBps) / 10_000;
                for (uint256 n = 0; n < counts[di]; n++) {
                    shapes.mintTo{value: wei_ + fee}(wei_, me);
                }
            }
        }

        vm.stopBroadcast();

        require(shapes.feeBps() == feeBps, "fee bps mismatch");
        require(shapes.feeRecipient() == me, "fee recipient mismatch");
        require(shapes.renderer() == address(renderer), "renderer mismatch");
        require(address(lens.shapes()) == address(shapes), "lens points at another token");
        {
            (address collectorTokenContract, uint256 collectorTokenId,) = shapes.contractCollectorBinding();
            require(collectorTokenContract == address(0), "collector token should start unset");
            require(collectorTokenId == 0, "collector token id should start zero");
            require(!lens.contractCollectorBindingLocked(), "collector binding should start unlocked");
        }

        console.log("chain id      ", block.chainid);
        console.log("ShapeRenderer ", address(renderer));
        console.log("Shapes        ", address(shapes));
        console.log("ShapeLens     ", address(lens));
        console.log("fee (bps)     ", feeBps);
        console.log("fee recipient ", me);
        console.log("total minted  ", shapes.totalMinted());
    }
}

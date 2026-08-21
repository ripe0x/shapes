// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Testnet deploy + seed: deploys the renderer and token, then mints a small spread so the
///         gallery has content, all in one broadcast (one keystore prompt).
///
/// @dev Fee recipient defaults to the deployer (fine on a throwaway testnet; on mainnet it is an
///      immutable decision — use DeployShapes.s.sol there with SHAPES_FEE_RECIPIENT set).
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
        returns (ShapeRenderer renderer, ShapeCollection collection, Shapes shapes, ShapeAuctionHouse house)
    {
        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        bool seed = vm.envOr("SEED_ETH", true);
        address me = msg.sender;
        address titleHolder = vm.envOr("SHAPES_TITLE_HOLDER", me);

        vm.startBroadcast();

        renderer = new ShapeRenderer();

        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(feeBps, me, address(renderer), address(collection), titleHolder);
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
        require(shapes.collection() == address(collection), "collection mismatch");
        require(shapes.titleHolder() == titleHolder, "title holder mismatch");
        // The house is wired to the token and holds no role on it.
        require(house.shapes() == address(shapes), "auction house points at another token");
        require(house.auctionCount() == 0, "auction house is not fresh");
        // The seeded spread starts at id 0, so the genesis token is the auctionable one.
        require(!seed || shapes.ownerOf(0) == me, "token 0 is not held by the deployer");

        console.log("chain id      ", block.chainid);
        console.log("ShapeRenderer ", address(renderer));
        console.log("ShapeCollection", address(collection));
        console.log("Shapes        ", address(shapes));
        console.log("AuctionHouse  ", address(house));
        console.log("fee (bps)     ", feeBps);
        console.log("fee recipient ", me);
        console.log("title holder  ", titleHolder);
        console.log("total minted  ", shapes.totalMinted());

        // Printed ready to paste: the site reads these four addresses from a deployment file, and
        // transcribing them by hand is how a site ends up pointed at a contract that is not there.
        console.log("");
        console.log("--- web/public/deployment.json ---");
        console.log("{");
        console.log('  "rpc": "https://ethereum-sepolia-rpc.publicnode.com",');
        console.log('  "chainId": 11155111,');
        console.log(string.concat('  "shapes": "', vm.toString(address(shapes)), '",'));
        console.log(string.concat('  "renderer": "', vm.toString(address(renderer)), '",'));
        console.log(string.concat('  "collection": "', vm.toString(address(collection)), '",'));
        console.log(string.concat('  "auctionHouse": "', vm.toString(address(house)), '",'));
        console.log(string.concat('  "feeBps": "', vm.toString(feeBps), '",'));
        console.log(string.concat('  "fromBlock": ', vm.toString(block.number)));
        console.log("}");
    }
}

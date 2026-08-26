// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {LensEquivalence} from "./LensEquivalence.s.sol";

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
///      Prefer the wrapper, which always verifies on Etherscan (deploy + verify in one step):
///        ETHERSCAN_API_KEY=... script/deploy-sepolia.sh
///
///      Or directly (keep --verify so the contracts land verified):
///        FOUNDRY_PROFILE=testnet ETHERSCAN_API_KEY=... forge script script/DeploySepolia.s.sol \
///          --rpc-url $SEPOLIA_RPC_URL --account ripe0x --broadcast --verify
///
///      FOUNDRY_PROFILE=testnet selects the 100x-smaller ladder. The run reverts without it.
contract DeploySepolia is LensEquivalence {
    uint256 internal constant DEFAULT_FEE_BPS = 100; // 1%

    error WrongLadder(string compiled, string expected);

    /// @dev The ladder is compiled in, so a run without FOUNDRY_PROFILE=testnet would put mainnet
    ///      amounts on a testnet where nobody can fund the upper rungs. Stop before broadcasting.
    function _requireTestnetLadder() internal pure {
        if (keccak256(bytes(Denominations.LADDER_NAME)) != keccak256("testnet")) {
            revert WrongLadder(Denominations.LADDER_NAME, "testnet");
        }
    }

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
        _requireTestnetLadder();

        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        bool seed = vm.envOr("SEED_ETH", true);
        address me = msg.sender;

        // Shapes.mint reads blockhash(block.number - 1), which underflows at genesis. Only a
        // freshly started local chain sits at block 0; a real network is far past it.
        if (block.number == 0) vm.roll(1);

        vm.startBroadcast();

        renderer = new ShapeRenderer();

        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(feeBps, me, address(renderer), address(collection));
        lens = new ShapeLens(address(shapes));
        house = new ShapeAuctionHouse(address(shapes));

        if (seed) {
            // Token 0 is the auction lot, minted before the spread so the listing is the
            // collection's first token. 24 hour clock starting at the first bid, no reserve, 5%
            // minimum increment, 15 minute extension window.
            uint256 lotFee = (Denominations.amountAt(0) * feeBps) / 10_000;
            uint256 lot = shapes.mint{value: Denominations.amountAt(0) + lotFee}(Denominations.amountAt(0));
            shapes.approve(address(house), lot);
            house.createAuction(address(shapes), lot, 1 days, 0, 500, 15 minutes);

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

        // Runs last: the probe advances simulated token state, so the counts logged above
        // are the seeded mints alone.
        _assertLensEquivalence(shapes, lens);
    }
}

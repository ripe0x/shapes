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
/// @dev The initial Sepolia fee recipient is pinned below. The deployer starts as `admin()` and
///      may redirect future fee withdrawals and adjust the fee amount up to one denomination unit; the
///      reserve rules remain immutable.
///
///      Backed Shape #0 is minted atomically to the deployer as the powerless contract-ownership
///      token. When seeding is enabled, the launch auction therefore lists Shape #1.
///
///        SHAPES_MINT_FEE_WEI   flat fee per Shape in wei. Pinned to 0.00001 ETH on Sepolia.
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
    uint256 internal constant DEFAULT_MINT_FEE = Denominations.UNIT / 10;
    address internal constant SEPOLIA_FEE_RECIPIENT = 0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4;

    error WrongLadder(string compiled, string expected);

    function _requirePointersUnset(Shapes shapes) private view {
        (address positions, bool positionsLocked) = shapes.positions();
        (address market, bool marketLocked) = shapes.market();
        require(positions == address(0), "positions should start unset");
        require(market == address(0), "market should start unset");
        require(!positionsLocked, "positions should start unlocked");
        require(!marketLocked, "market should start unlocked");
    }

    /// @dev The ladder is compiled in, so a run without FOUNDRY_PROFILE=testnet would put mainnet
    ///      amounts on a testnet where nobody can fund the upper rungs. Stop before broadcasting.
    function _requireTestnetLadder() internal pure {
        if (keccak256(bytes(Denominations.LADDER_NAME)) != keccak256("testnet")) {
            revert WrongLadder(Denominations.LADDER_NAME, "testnet");
        }
    }

    function _postflight(
        ShapeRenderer renderer,
        ShapeCollection collection,
        Shapes shapes,
        ShapeLens lens,
        ShapeAuctionHouse house,
        address deployer,
        bool seeded
    ) private {
        require(shapes.mintFee() == DEFAULT_MINT_FEE, "mint fee mismatch");
        require(shapes.feeRecipient() == SEPOLIA_FEE_RECIPIENT, "fee recipient mismatch");
        require(shapes.renderer() == address(renderer), "renderer mismatch");
        require(shapes.collection() == address(collection), "collection mismatch");
        require(address(lens.shapes()) == address(shapes), "lens points at another token");
        require(house.shapes() == address(shapes), "house points at another token");
        require(shapes.ownerOf(0) == deployer, "Shape #0 not minted to deployer");
        require(shapes.owner() == deployer, "contract owner mismatch");
        require(shapes.admin() == deployer, "admin mismatch");
        require(shapes.artist() == deployer, "artist mismatch");
        require(shapes.artistReleaseHash() == bytes32(0), "artist attribution should start unsigned");
        require(shapes.artistSignature().length == 0, "artist signature should start empty");
        require(lens.exists(0), "Shape #0 must exist");
        require(shapes.denominationCount() == 9, "denomination count mismatch");
        require(shapes.denominationAt(0) == Denominations.amountAt(0), "minimum denomination mismatch");
        require(shapes.denomIndexOf(0) == 0, "Shape #0 denomination mismatch");
        require(shapes.backingOf(0) == Denominations.amountAt(0), "Shape #0 backing mismatch");
        _requirePointersUnset(shapes);
        require(house.auctionCount() == (seeded ? 1 : 0), "auction count mismatch");

        console.log("chain id      ", block.chainid);
        console.log("ShapeRenderer ", address(renderer));
        console.log("Shapes        ", address(shapes));
        console.log("ShapeLens     ", address(lens));
        console.log("mint fee (wei)", DEFAULT_MINT_FEE);
        console.log("fee recipient ", shapes.feeRecipient());
        console.log("artist        ", shapes.artist());
        console.log("total minted  ", shapes.totalMinted());
        console.log("positions      unset and unlocked");
        console.log("market         unset and unlocked");

        _assertLensEquivalence(shapes, lens);
    }

    function run() external {
        _requireTestnetLadder();

        uint256 mintFee = vm.envOr("SHAPES_MINT_FEE_WEI", DEFAULT_MINT_FEE);
        bool seed = vm.envOr("SEED_ETH", true);
        address me = msg.sender;

        // This script is the approved Sepolia release path, not a general-purpose deployer.
        // Keep the mutable shell environment from silently changing the reviewed fee terms.
        require(mintFee == DEFAULT_MINT_FEE, "Sepolia fee must be 0.00001 ETH per Shape");

        // Shapes.mint reads blockhash(block.number - 1), which underflows at genesis. Only a
        // freshly started local chain sits at block 0; a real network is far past it.
        if (block.number == 0) vm.roll(1);

        vm.startBroadcast();

        ShapeRenderer renderer = new ShapeRenderer();

        ShapeCollection collection = new ShapeCollection(address(renderer));
        Shapes shapes = new Shapes{value: Denominations.amountAt(0)}(
            mintFee, SEPOLIA_FEE_RECIPIENT, address(renderer), address(collection)
        );
        ShapeLens lens = new ShapeLens(address(shapes));
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));

        if (seed) {
            // Shape #0 already represents contract ownership. Shape #1 is the first ordinary artwork
            // and the launch lot. 24 hour clock from the first bid, no reserve, 5% minimum
            // increment, 15 minute extension window.
            uint256 lot = shapes.mint{value: Denominations.amountAt(0) + mintFee}(Denominations.amountAt(0));
            require(lot == 1, "launch lot must be Shape #1");
            shapes.approve(address(house), lot);
            house.createAuction(address(shapes), lot, 1 days, 0, 500, 15 minutes);

            // A modest spread across the low denominations: five 0.01, two 0.05, one 0.1. Total
            // Backing is ~0.15 ETH. Each seeded Shape adds the same 0.00001 ETH fee.
            uint8[3] memory counts = [5, 2, 1]; // by denomination index 0,1,2
            for (uint256 di = 0; di < counts.length; di++) {
                uint256 wei_ = Denominations.amountAt(di);
                for (uint256 n = 0; n < counts[di]; n++) {
                    shapes.mintTo{value: wei_ + mintFee}(wei_, me);
                }
            }
        }

        vm.stopBroadcast();

        // Runs last: the probe advances simulated token state, so the counts logged inside it
        // are the seeded mints alone.
        _postflight(renderer, collection, shapes, lens, house, me, seed);
    }
}

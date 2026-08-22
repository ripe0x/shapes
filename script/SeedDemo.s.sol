// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Seeds an already-deployed Shapes on a local dev chain with a spread of composed,
///         split and original tokens, including three 100 ETH compositions: one from 2 x 50,
///         one from 10 x 10, and one apex composed from 10,000 x 0.01.
///
/// @dev Local chains only. The apex mint batch and its compose each need gas far past any
///      mainnet block limit; run against an anvil started with a large --gas-limit
///      (5,000,000,000 covers both) and give forge the same ceiling per transaction:
///
///        SHAPES_ADDRESS=0x... forge script script/SeedDemo.s.sol \
///          --rpc-url http://127.0.0.1:8545 --private-key $ANVIL_PK0 \
///          --gas-limit 5000000000 --broadcast
///
///      The deployer needs about 420 ETH plus fees; anvil's default accounts hold 10,000.
contract SeedDemo is Script {
    Shapes internal shapes;
    uint256 internal feeBps;

    function run() external {
        shapes = Shapes(payable(vm.envAddress("SHAPES_ADDRESS")));
        feeBps = shapes.feeBps();

        vm.startBroadcast();

        // First mint on a fresh chain, so the auction lot is token 0.
        _seedAuction();

        // Small spread: a stacked compose, a split, and loose originals.
        uint256 dustFirst = _mintBatch(0, 5); // five 0.01
        uint256 survivor = _composeRange(dustFirst, dustFirst + 1, 4); // 0.05, depth 1
        uint256 nickel = _mint(1); // 0.05 original
        _composeOne(survivor, nickel); // 0.1, depth 2

        uint256 half = _mint(3); // 0.5 to split
        uint8[] memory fifths = new uint8[](5);
        for (uint256 i = 0; i < 5; i++) {
            fifths[i] = 2; // 0.1 each
        }
        shapes.split(half, fifths);

        _mint(4); // 1 ETH original
        _mint(6); // 10 ETH original

        // 100 ETH, three ways.
        _mint(8); // direct 100 ETH original, 1 module

        uint256 fiftyA = _mint(7);
        uint256 fiftyB = _mint(7);
        _composeOne(fiftyA, fiftyB); // 100 from 2 x 50

        uint256 tenFirst = _mintBatch(6, 10);
        _composeRange(tenFirst, tenFirst + 1, 9); // 100 from 10 x 10

        // Pure-dust ladder: at every denomination above 0.01, one token composed solely from
        // 0.01 grains in a single compose (5 grains for 0.05 up to 5,000 for 50).
        for (uint256 di = 1; di <= 7; di++) {
            uint256 n = Denominations.unitsAt(di);
            uint256 first = _mintBatch(0, n);
            _composeRange(first, first + 1, n - 1);
        }

        // Apex: 10,000 x 0.01 composed into one 100 ETH token, completing the ladder.
        uint256 grainFirst = _mintBatch(0, 10_000);
        _composeRange(grainFirst, grainFirst + 1, 9_999);

        _seedTiered();

        vm.stopBroadcast();
    }

    /// @dev With AUCTION_HOUSE set, mints a 0.01 ETH Shape and lists it: 24 hour duration, no
    ///      reserve, 5% minimum increment, 15 minute extension window. Called before any other
    ///      mint so the lot is token 0 on a fresh chain. Skipped when the env var is absent.
    function _seedAuction() internal {
        address house = vm.envOr("AUCTION_HOUSE", address(0));
        if (house == address(0)) return;
        uint256 lot = _mint(0);
        shapes.approve(house, lot);
        ShapeAuctionHouse(house).createAuction(address(shapes), lot, 1 days, 0, 500, 15 minutes);
    }

    /// @notice Incremental entry point: only the tiered builds, for a chain already seeded by
    ///         `run`. `forge script script/SeedDemo.s.sol --sig "runTiered()" ...`
    function runTiered() external {
        shapes = Shapes(payable(vm.envAddress("SHAPES_ADDRESS")));
        feeBps = shapes.feeBps();
        vm.startBroadcast();
        _seedTiered();
        vm.stopBroadcast();
    }

    /// @dev Tiered builds: survivors that climb the denomination ladder one compose per rung,
    ///      absorbing freshly minted fuel at each step. The 100 ETH flagship passes through
    ///      every denomination (compose depth 8); the 1 ETH build stops at depth 4.
    function _seedTiered() internal {
        _tieredClimb(8);
        _tieredClimb(4);
    }

    function _tieredClimb(uint256 topIndex) internal returns (uint256 survivor) {
        uint256 dustFirst = _mintBatch(0, 5);
        survivor = _composeRange(dustFirst, dustFirst + 1, 4); // 0.05, depth 1
        for (uint256 di = 1; di < topIndex; di++) {
            // Fuel to lift the survivor from amountAt(di) to amountAt(di + 1), as freshly
            // minted originals of denomination di scaled by the gap (5x steps need 4 fuel
            // tokens, 2x steps need 1). The 0.05 -> 0.1 step has no 2x sibling below it, so
            // it absorbs five more grains instead.
            uint256 gap = Denominations.amountAt(di + 1) / Denominations.amountAt(di) - 1;
            uint256[] memory burns;
            if (di == 1 && gap == 1) {
                uint256 f = _mintBatch(0, 5);
                burns = new uint256[](5);
                for (uint256 i = 0; i < 5; i++) {
                    burns[i] = f + i;
                }
            } else {
                burns = new uint256[](gap);
                for (uint256 i = 0; i < gap; i++) {
                    burns[i] = _mint(di);
                }
            }
            shapes.compose(survivor, burns);
        }
    }

    function _mint(uint256 di) internal returns (uint256 id) {
        uint256 wei_ = Denominations.amountAt(di);
        id = shapes.mint{value: wei_ + (wei_ * feeBps) / 10_000}(wei_);
    }

    function _mintBatch(uint256 di, uint256 quantity) internal returns (uint256 firstId) {
        uint256 wei_ = Denominations.amountAt(di);
        uint256 unit = wei_ + (wei_ * feeBps) / 10_000;
        firstId = shapes.mintBatch{value: unit * quantity}(wei_, quantity);
    }

    function _composeOne(uint256 survivorId, uint256 burnId) internal returns (uint256) {
        uint256[] memory burns = new uint256[](1);
        burns[0] = burnId;
        return shapes.compose(survivorId, burns);
    }

    function _composeRange(uint256 survivorId, uint256 firstBurn, uint256 count) internal returns (uint256) {
        uint256[] memory burns = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            burns[i] = firstBurn + i;
        }
        return shapes.compose(survivorId, burns);
    }
}

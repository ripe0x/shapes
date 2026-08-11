// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {DeployShapes} from "../script/DeployShapes.s.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

/// @notice Full lifecycle against a real mainnet fork.
///
/// @dev Shapes reads no external contract, so a fork is not needed for correctness — the
///      default suite already proves that. What the fork adds is a real block environment:
///      chain id 1, a post-merge `prevrandao`, a real prior blockhash and timestamp, all of
///      which feed the mint seed, plus realistic gas. This suite deploys through the actual
///      deploy script under those conditions and drives mint, transfer, redeem and batch
///      redeem end to end, asserting the reserve invariant and exact payouts throughout.
///
///      Gated on `MAINNET_RPC_URL`. Unset, every test is skipped rather than failed, so the
///      default `forge test` is unaffected. Pin `FORK_BLOCK` to make Foundry's persistent RPC
///      cache compound across reruns.
///
///        MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///          forge test --mc ForkTest -vv
contract ForkTest is Test {
    using Base64Decode for string;

    uint256 internal constant FEE_BPS = 100; // 1%

    function feeOf(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }

    ShapeRenderer internal renderer;
    Shapes internal shapes;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bool internal live;
    /// @dev A CREATE address on a fork can coincide with a mainnet account that already holds
    ///      a little ETH. That surplus is outside backing and permanently stranded — exactly
    ///      the forced-ETH case in SECURITY.md. Captured post-deploy so the reserve checks
    ///      compare against it instead of assuming a pristine zero balance.
    uint256 internal strayWei;

    uint256[9] internal DENOMS = [
        uint256(0.01 ether),
        0.05 ether,
        0.1 ether,
        0.5 ether,
        1 ether,
        5 ether,
        10 ether,
        50 ether,
        100 ether
    ];

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpc);
        } else {
            vm.createSelectFork(rpc, forkBlock);
        }

        live = true;
        renderer = new ShapeRenderer();
        shapes = new Shapes(FEE_BPS, feeRecipient, address(renderer));
        strayWei = address(shapes).balance;
    }

    /// @dev Skip rather than fail when no RPC is configured.
    modifier onlyFork() {
        if (!live) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @notice The fork really is post-merge mainnet, and the values that seed a mint are live.
    function test_ForkIsMainnet() external onlyFork {
        assertEq(block.chainid, 1, "not mainnet");
        assertGt(block.number, 21_000_000, "block number implausibly low for mainnet");
        // Post-merge, block.prevrandao carries the beacon RANDAO; pre-merge it was the fixed
        // difficulty. A nonzero value confirms the fork is a real post-merge block.
        assertTrue(block.prevrandao != 0, "prevrandao is zero: not a post-merge fork");
    }

    /// @notice The deploy script lands every immutable and produces metadata, under fork state.
    function test_DeployScriptSucceedsOnFork() external onlyFork {
        // The script requires an explicit recipient off anvil, and refuses a contract one.
        vm.setEnv("SHAPES_FEE_RECIPIENT", vm.toString(feeRecipient));

        DeployShapes deployer = new DeployShapes();
        (ShapeRenderer r, Shapes s) = deployer.run();

        assertEq(s.feeBps(), 100, "default fee bps not applied");
        assertEq(s.feeRecipient(), feeRecipient, "fee recipient mismatch");
        assertEq(s.renderer(), address(r), "renderer mismatch");
        assertGt(address(r).code.length, 0, "renderer has no code");
        // Smoke the renderer through the interface the token uses; no mint needed.
        assertGt(bytes(r.tokenURI(bytes32(0), 0.01 ether, 1)).length, 500, "no metadata");
    }

    /// @notice Mint every denomination, prove solvency at each step, redeem it all back out.
    function test_FullLifecycleUnderRealBlockEnv() external onlyFork {
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 10 ether);

        uint256[9] memory ids;
        for (uint256 i = 0; i < DENOMS.length; i++) {
            uint256 amount = DENOMS[i];
            vm.prank(alice);
            ids[i] = shapes.mint{value: amount + feeOf(amount)}(amount, alice);

            assertEq(shapes.backingOf(ids[i]), amount, "backing wrong");
            assertTrue(shapes.seedOf(ids[i]) != bytes32(0), "seed is zero");
            _assertSolvent();
            _assertMetadataValid(ids[i]);
        }

        // The fee left the contract on every mint; only backing (plus any stray wei) remains.
        assertEq(address(shapes).balance, shapes.totalBacking() + strayWei, "unexpected reserve");
        uint256 expectedFees;
        for (uint256 i = 0; i < DENOMS.length; i++) expectedFees += feeOf(DENOMS[i]);
        assertEq(feeRecipient.balance, expectedFees, "fees not forwarded");

        // Transfer the 1 ETH token (index 3) to bob; redemption rights follow the token.
        uint256 oneEth = ids[3];
        vm.prank(alice);
        shapes.transferFrom(alice, bob, oneEth);
        assertEq(shapes.ownerOf(oneEth), bob, "transfer failed");

        // Previous owner cannot redeem.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, oneEth, alice));
        shapes.redeem(oneEth);

        // Current owner redeems and receives exactly the wrapped amount.
        uint256 before = bob.balance;
        vm.prank(bob);
        shapes.redeem(oneEth);
        assertEq(bob.balance - before, 1 ether, "payout not exact");
        _assertSolvent();

        // Redeem the remaining eight in one batch; the reserve fully unwinds.
        uint256[] memory rest = new uint256[](8);
        uint256 k = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == oneEth) continue;
            rest[k++] = ids[i];
        }
        vm.prank(alice);
        uint256 total = shapes.redeemBatch(rest);
        assertEq(total, _sumExcept(1 ether), "batch total wrong");
        assertEq(shapes.totalBacking(), 0, "backing remains");
        // Backing is fully unwound; only the pre-existing stray wei is left behind, stranded.
        assertEq(address(shapes).balance, strayWei, "reserve not unwound to stray");
        assertEq(shapes.totalSupply(), 0, "supply remains");
    }

    /// @notice Real-conditions gas for the two hot paths, for the record.
    function test_GasProfileUnderRealConditions() external onlyFork {
        vm.deal(alice, 10 ether);

        vm.prank(alice);
        uint256 g0 = gasleft();
        uint256 id = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, alice);
        uint256 mintGas = g0 - gasleft();

        vm.prank(alice);
        uint256 g1 = gasleft();
        shapes.redeem(id);
        uint256 redeemGas = g1 - gasleft();

        console.log("mint(1 ETH)  gas", mintGas);
        console.log("redeem       gas", redeemGas);

        // Loose ceilings: catch a regression, not micro-optimise. Cold single mint is ~150k.
        assertLt(mintGas, 250_000, "mint gas regressed");
        assertLt(redeemGas, 100_000, "redeem gas regressed");
    }

    /* ------------------------------- helpers ------------------------------- */

    function _assertSolvent() internal view {
        assertGe(address(shapes).balance, shapes.totalBacking(), "INSOLVENT");
    }

    function _sumExcept(uint256 excludedAmount) internal view returns (uint256 sum) {
        for (uint256 i = 0; i < DENOMS.length; i++) {
            if (DENOMS[i] == excludedAmount) continue;
            sum += DENOMS[i];
        }
    }

    /// @dev tokenURI must decode to real JSON carrying a real inline SVG, under fork state.
    function _assertMetadataValid(uint256 tokenId) internal view {
        string memory uri = shapes.tokenURI(tokenId);
        string memory prefix = "data:application/json;base64,";
        assertTrue(_startsWith(uri, prefix), "not a json data uri");

        string memory json = string(Base64Decode.decode(_after(uri, prefix)));
        string memory image = vm.parseJsonString(json, ".image");
        assertTrue(_startsWith(image, "data:image/svg+xml;base64,"), "image not an svg data uri");

        string memory svg =
            string(Base64Decode.decode(_after(image, "data:image/svg+xml;base64,")));
        assertTrue(_startsWith(svg, "<svg "), "decoded image is not an svg");
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; i++) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }

    function _after(string memory s, string memory prefix) internal pure returns (string memory) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        bytes memory out = new bytes(sb.length - pb.length);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = sb[i + pb.length];
        }
        return string(out);
    }
}

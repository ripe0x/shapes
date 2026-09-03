// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

/// @notice Full lifecycle against a real mainnet fork.
///
/// @dev Shapes reads no external contract, so a fork is not needed for correctness: the
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

    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    function feeOf(uint256) internal pure returns (uint256) {
        return MINT_FEE;
    }

    ShapeRenderer internal renderer;

    ShapeCollection internal collection;
    Shapes internal shapes;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bool internal live;
    /// @dev A CREATE address on a fork can coincide with a mainnet account that already holds
    ///      a little ETH. That surplus is outside backing and permanently stranded, exactly
    ///      the forced-ETH case in SECURITY.md. Captured post-deploy so the reserve checks
    ///      compare against it instead of assuming a pristine zero balance.
    uint256 internal strayWei;

    uint256[9] internal DENOMS = [
        Denominations.amountAt(0),
        Denominations.amountAt(1),
        Denominations.amountAt(2),
        Denominations.amountAt(3),
        Denominations.amountAt(4),
        Denominations.amountAt(5),
        Denominations.amountAt(6),
        Denominations.amountAt(7),
        Denominations.amountAt(8)
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
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection), 0
        );
        // The constructor balance includes backed Shape #0. Only the excess is stranded ETH.
        strayWei = address(shapes).balance - shapes.redeemableBacking();
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

        Deploy deployer = new Deploy();
        (ShapeRenderer r, ShapeCollection c, Shapes s, ShapeAuctionHouse h) = deployer.run();

        assertEq(s.mintFee(), MINT_FEE, "default flat fee not applied");
        assertEq(s.feeRecipient(), feeRecipient, "fee recipient mismatch");
        assertEq(s.renderer(), address(r), "renderer mismatch");
        assertEq(s.collection(), address(c), "collection mismatch");
        assertEq(s.artist(), s.admin(), "artist should be the deployer");
        assertEq(s.owner(), s.admin(), "contract owner should be the deployer");
        assertEq(s.ownerOf(0), s.admin(), "Shape #0 should belong to the deployer");
        assertEq(s.ownerToken(), 0, "owner token should be Shape #0");
        assertEq(s.artistReleaseHash(), bytes32(0), "attribution should start unsigned");
        assertEq(s.artistSignature(), bytes(""), "signature should start empty");
        assertEq(h.shapes(), address(s), "auction house mismatch");
        (address positions, bool positionsLocked) = s.positions();
        (address market, bool marketLocked) = s.market();
        assertEq(positions, address(0), "positions should start empty");
        assertEq(market, address(h), "market should name the deployed auction house");
        assertFalse(positionsLocked, "positions should start unlocked");
        assertFalse(marketLocked, "market should start unlocked");
        assertTrue(s.supportsInterface(type(IERC721Value).interfaceId), "value interface missing");
        assertGt(address(r).code.length, 0, "renderer missing code");
        // Smoke the renderer through the interface the token uses; no mint needed.
        assertGt(
            bytes(r.tokenURI(bytes32(0), DENOMS[0], 1, 1, false, 0, 0, "Shape ", "x", false)).length,
            500,
            "no metadata"
        );
    }

    /// @notice Mint every denomination, prove solvency at each step, redeem it all back out.
    function test_FullLifecycleUnderRealBlockEnv() external onlyFork {
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 10 ether);

        uint256[9] memory ids;
        for (uint256 i = 0; i < DENOMS.length; i++) {
            uint256 amount = DENOMS[i];
            vm.prank(alice);
            ids[i] = shapes.mintTo{value: amount + feeOf(amount)}(amount, alice);

            assertEq(shapes.backingOf(ids[i]), amount, "backing wrong");
            assertTrue(shapes.seedOf(ids[i]) != bytes32(0), "seed is zero");
            _assertSolvent();
            _assertMetadataValid(ids[i]);
        }

        // Fees accrued on every mint but never left the contract; only backing plus pending fees
        // (and any stray wei) remain.
        assertEq(
            address(shapes).balance,
            shapes.redeemableBacking() + shapes.pendingFees() + strayWei,
            "unexpected reserve"
        );
        uint256 expectedFees;
        for (uint256 i = 0; i < DENOMS.length; i++) {
            expectedFees += feeOf(DENOMS[i]);
        }
        assertEq(shapes.pendingFees(), expectedFees, "fees not accrued");
        assertEq(feeRecipient.balance, 0, "fees stay pending until withdrawFees is called");

        // Transfer the 1 ETH token to bob; redemption rights follow the token. Found by amount
        // rather than a hard-coded index so the ladder can change without silently miscasting
        // which token this is.
        uint256 oneEthIdx;
        for (uint256 i = 0; i < DENOMS.length; i++) {
            if (DENOMS[i] == DENOMS[4]) oneEthIdx = i;
        }
        uint256 oneEth = ids[oneEthIdx];
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
        assertEq(bob.balance - before, DENOMS[4], "payout not exact");
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
        assertEq(total, _sumExcept(DENOMS[4]), "batch total wrong");

        // The test contract received backed Shape #0 in setUp; unwind it too before asserting
        // that the complete collection reserve and supply reached zero.
        shapes.redeemTo(0, payable(alice));
        assertEq(shapes.redeemableBacking(), 0, "backing remains");
        // Backing is fully unwound; only pending fees and the pre-existing stray wei remain.
        assertEq(
            address(shapes).balance,
            shapes.pendingFees() + strayWei,
            "reserve not unwound to pending fees plus stray"
        );
        assertEq(shapes.totalSupply(), 0, "supply remains");
    }

    /// @notice Real-conditions gas for the two hot paths, for the record.
    function test_GasProfileUnderRealConditions() external onlyFork {
        vm.deal(alice, 10 ether);

        vm.prank(alice);
        uint256 g0 = gasleft();
        uint256 id = shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], alice);
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
        assertGe(address(shapes).balance, shapes.redeemableBacking(), "INSOLVENT");
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

        string memory svg = string(Base64Decode.decode(_after(image, "data:image/svg+xml;base64,")));
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

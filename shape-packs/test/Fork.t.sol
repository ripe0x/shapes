// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IShapes} from "shapes/interfaces/IShapes.sol";
import {IShapeRenderer} from "shapes/interfaces/IShapeRenderer.sol";
import {ShapeState} from "shapes/ShapeTypes.sol";

import {ShapePacks} from "../src/ShapePacks.sol";
import {ShapePackRenderer} from "../src/ShapePackRenderer.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

/// @notice The pack lifecycle against the real mainnet `Shapes` and its deployed renderer.
///
/// @dev Gated on `MAINNET_RPC_URL`. Unset, the suite is skipped rather than failed, so the default
///      `forge test` needs no network. Only the pack contract and its renderer are deployed here;
///      Shapes, its renderer and its collection are the live ones. The mainnet ladder is fixed, so
///      the literals below are the mainnet values.
///
///        MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mc ForkTest -vv
contract ForkTest is Test {
    IShapes internal constant SHAPES = IShapes(0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0);

    ShapePackRenderer internal packRenderer;
    ShapePacks internal packs;
    address internal user;
    address internal admin;
    /// @dev A CREATE address on a fork can coincide with a mainnet account that already holds a
    ///      little ETH. That surplus is outside any pack and permanently stranded, exactly the
    ///      forced-ETH case (design I4), so balance checks compare against what was there at
    ///      deployment instead of assuming zero.
    uint256 internal strayWei;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);

        admin = makeAddr("forkAdmin");
        user = makeAddr("forkUser");
        vm.deal(user, 100 ether);

        packRenderer = new ShapePackRenderer(address(SHAPES));
        packs = new ShapePacks(address(SHAPES), address(packRenderer), admin);
        strayWei = address(packs).balance;
    }

    /* ------------------------------ helpers ------------------------------ */

    function _counts(uint256 index, uint32 n) internal pure returns (uint32[] memory counts) {
        counts = new uint32[](SHAPES.denominationCount());
        counts[index] = n;
    }

    function _json(uint256 packId) internal view returns (string memory) {
        string memory uri = packs.tokenURI(packId);
        bytes memory raw = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        require(raw.length > prefix.length, "short URI");
        bytes memory b64 = new bytes(raw.length - prefix.length);
        for (uint256 i = 0; i < prefix.length; ++i) {
            require(raw[i] == prefix[i], "not a base64 JSON data URI");
        }
        for (uint256 i = 0; i < b64.length; ++i) {
            b64[i] = raw[i + prefix.length];
        }
        return string(Base64Decode.decode(string(b64)));
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0) return true;
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            if (h[i] != n[0]) continue;
            bool ok = true;
            for (uint256 j = 1; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _svgOf(string memory json) internal pure returns (string memory) {
        bytes memory h = bytes(json);
        bytes memory key = bytes('"image":"data:image/svg+xml;base64,');
        uint256 at = type(uint256).max;
        for (uint256 i = 0; i + key.length <= h.length && at == type(uint256).max; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < key.length; ++j) {
                if (h[i + j] != key[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) at = i + key.length;
        }
        require(at != type(uint256).max, "no image");
        uint256 to = at;
        while (h[to] != '"') {
            ++to;
        }
        bytes memory b64 = new bytes(to - at);
        for (uint256 i = 0; i < b64.length; ++i) {
            b64[i] = h[at + i];
        }
        return string(Base64Decode.decode(string(b64)));
    }

    /* -------------------------------- tests -------------------------------- */

    /// @notice Mint a floor pack from ETH, read its metadata, extend it, redeem it, and get the
    ///         exact ETH back.
    function test_ForkMintedPackLifecycle() public {
        assertEq(block.chainid, 1, "not mainnet");
        assertGe(block.timestamp, SHAPES.mintStart(), "minting not open at this block");
        assertEq(SHAPES.unit(), 0.01 ether, "mainnet ladder");
        assertEq(SHAPES.denominationCount(), 9);

        assertEq(packs.MIN_PACK_VALUE(), 0.03 ether, "floor");
        assertEq(packs.MIN_PACK_VALUE(), 3 * SHAPES.unit());
        assertEq(packs.shapes(), address(SHAPES));

        // The floor: three 0.01 ETH Shapes minted from ETH.
        uint32[] memory counts = _counts(0, 3);
        (uint256 backing, uint256 fee, uint256 total, uint256 n) = packs.quoteMint(counts);
        assertEq(backing, 0.03 ether);
        assertEq(n, 3);
        assertEq(total, backing + fee);
        assertEq(fee, 3 * SHAPES.mintFee());

        uint256 shapesBefore = SHAPES.totalMinted();
        uint256 reserveBefore = SHAPES.redeemableBacking();
        uint256 userBefore = user.balance;

        vm.prank(user);
        uint256 packId = packs.createPack{value: total}(new uint256[](0), counts);
        assertEq(packId, 1);
        assertEq(packs.ownerOf(packId), user);
        assertEq(packs.creatorOf(packId), user);
        assertEq(packs.valueOf(packId), 0.03 ether, "pack value is exactly the floor");
        assertEq(user.balance, userBefore - total, "caller paid exactly the quote");
        assertEq(address(packs).balance, strayWei, "the pack contract holds no ETH of its own");
        assertEq(SHAPES.redeemableBacking(), reserveBefore + 0.03 ether, "reserve grew by the backing only");

        uint256[] memory ids = packs.contentsOf(packId);
        assertEq(ids.length, 3);
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(ids[i], shapesBefore + i, "contiguous ids from Shapes");
            assertEq(SHAPES.ownerOf(ids[i]), address(packs), "custodied by the pack contract");
            assertEq(packs.packOf(ids[i]), packId);
            assertEq(SHAPES.backingOf(ids[i]), 0.01 ether);
        }

        // Metadata through the live, deployed Shapes renderer.
        string memory json = _json(packId);
        assertEq(bytes(json)[0], bytes1("{"));
        assertTrue(_contains(json, '"name":"Shape Pack 1"'), "name");
        assertTrue(_contains(json, "3 x 0.01 ETH. 0.03 ETH total."), "makeup sentence");
        assertTrue(_contains(json, '{"trait_type":"Shapes","value":3}'));
        assertTrue(_contains(json, '{"trait_type":"Value","value":"0.03 ETH"}'));
        assertTrue(_contains(json, '{"display_type":"number","trait_type":"Units","value":3}'));
        assertTrue(_contains(json, '{"trait_type":"0.01 ETH","value":3}'));
        assertTrue(_contains(json, '{"trait_type":"Source","value":"Minted"}'));
        string memory svg = _svgOf(json);
        assertTrue(_contains(svg, "<svg"));
        // Each of the three cards is the live renderer's artwork for that Shape.
        IShapeRenderer live = IShapeRenderer(SHAPES.renderer());
        for (uint256 i = 0; i < 3; ++i) {
            ShapeState memory st = SHAPES.shapeState(ids[i]);
            assertTrue(
                _contains(svg, live.renderSVG(st.seed, st.faceValueWei, st.isBlack, st.inkGene)),
                "card drawn by the deployed renderer"
            );
        }
        assertGt(bytes(packs.contractURI()).length, 0, "contractURI against the live collection");

        // Extend with one 0.05 ETH Shape.
        uint32[] memory more = _counts(1, 1);
        (,, uint256 moreTotal,) = packs.quoteMint(more);
        vm.prank(user);
        packs.addToPack{value: moreTotal}(packId, new uint256[](0), more);
        assertEq(packs.valueOf(packId), 0.08 ether);
        assertEq(packs.contentsOf(packId).length, 4);
        json = _json(packId);
        assertTrue(_contains(json, "3 x 0.01 ETH, 1 x 0.05 ETH. 0.08 ETH total."), "extended makeup");
        assertTrue(_contains(json, '{"trait_type":"Shapes","value":4}'));
        assertTrue(_contains(json, '{"trait_type":"Value","value":"0.08 ETH"}'));
        assertTrue(_contains(json, '{"display_type":"number","trait_type":"Units","value":8}'));
        assertTrue(_contains(json, '{"trait_type":"0.05 ETH","value":1}'));

        // Redeem: the ETH comes back exactly, and nothing is left behind.
        uint256 beforeRedeem = user.balance;
        uint256 reserveBeforeRedeem = SHAPES.redeemableBacking();
        vm.prank(user);
        packs.redeem(packId);
        assertEq(user.balance, beforeRedeem + 0.08 ether, "the exact backing came back");
        assertEq(SHAPES.redeemableBacking(), reserveBeforeRedeem - 0.08 ether);
        assertEq(address(packs).balance, strayWei);
        assertEq(packs.totalSupply(), 0);
        assertEq(packs.totalMinted(), 1);
        assertFalse(packs.exists(packId));
        assertEq(packs.contentsOf(packId).length, 0);
        for (uint256 i = 0; i < ids.length; ++i) {
            assertFalse(SHAPES.exists(ids[i]), "redeemed Shape burned");
            assertEq(packs.packOf(ids[i]), 0);
        }
        // Net cost to the user: the three mint fees plus the one for the addition.
        assertEq(userBefore - user.balance, 4 * SHAPES.mintFee(), "only Shapes' mint fees were spent");
    }

    /// @notice Pull Shapes the user already holds, add them to a pack, and open it again.
    function test_ForkPulledPackOpensBackToTheHolder() public {
        uint256 amount = 0.01 ether;
        uint256 fee = SHAPES.mintFee();
        vm.prank(user);
        uint256 first = SHAPES.mintBatchTo{value: 3 * (amount + fee)}(amount, 3, user);
        vm.prank(user);
        SHAPES.setApprovalForAll(address(packs), true);

        uint256[] memory pulled = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) {
            pulled[i] = first + i;
        }
        // Built before the prank: a helper that calls Shapes would consume it.
        uint32[] memory noMints = _counts(0, 0);
        vm.prank(user);
        uint256 packId = packs.createPack(pulled, noMints);
        assertEq(packs.valueOf(packId), 0.03 ether);
        assertTrue(_contains(_json(packId), '{"trait_type":"Source","value":"Packed"}'));
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(SHAPES.ownerOf(pulled[i]), address(packs));
        }

        vm.prank(user);
        packs.open(packId);
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(SHAPES.ownerOf(pulled[i]), user, "Shapes returned to the holder");
            assertEq(packs.packOf(pulled[i]), 0);
        }
        assertEq(packs.totalSupply(), 0);
        assertEq(address(packs).balance, strayWei);
    }
}

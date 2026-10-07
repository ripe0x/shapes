// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721Value} from "shapes/interfaces/IERC721Value.sol";
import {IShapes} from "shapes/interfaces/IShapes.sol";

import {PacksTest} from "./utils/PacksTest.sol";
import {IShapePacks} from "../src/interfaces/IShapePacks.sol";

/// @notice The `onERC721Received` window, unsolicited deposits, direct ETH, forced ETH and ERC-165.
contract ReceiverTest is PacksTest {
    address internal carol = address(0xCA401);

    function _create(address who, uint256[] memory ids, uint32[] memory counts)
        internal
        returns (uint256 packId)
    {
        uint256 cost = costOf(counts);
        vm.prank(who);
        packId = packs.createPack{value: cost}(ids, counts);
    }

    /* --------------------------- unsolicited Shapes --------------------------- */

    function test_RevertSafeTransferFromShapeIntoPacks() public {
        uint256 id = mintShape(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, alice));
        vm.prank(alice);
        shapes.safeTransferFrom(alice, address(packs), id);

        assertEq(shapes.ownerOf(id), alice, "nothing moved");
        assertEq(shapes.balanceOf(address(packs)), 0);
    }

    function test_RevertSafeTransferFromWithDataIntoPacks() public {
        uint256 id = mintShape(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, alice));
        vm.prank(alice);
        shapes.safeTransferFrom(alice, address(packs), id, hex"c0ffee");
        assertEq(shapes.ownerOf(id), alice);
    }

    function test_RevertSafeTransferFromByOperatorReportsTheOwnerAsFrom() public {
        uint256 id = mintShape(alice, 0);
        vm.prank(alice);
        shapes.approve(bob, id);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, alice));
        vm.prank(bob);
        shapes.safeTransferFrom(alice, address(packs), id);
        assertEq(shapes.ownerOf(id), alice);
    }

    function test_RevertSafeTransferFromWhileOtherPacksExist() public {
        // A safe transfer outside any mint is refused whoever sends it, including a pack holder.
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        uint256 id = mintShape(bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, bob));
        vm.prank(bob);
        shapes.safeTransferFrom(bob, address(packs), id);
        assertEq(packs.contentsOf(packId).length, 3);
    }

    function test_RevertMintShapeDirectlyToPacksByThirdParty() public {
        uint256 amount = amountAt(0);
        uint256 cost = amount + shapes.mintFee();
        // The window is closed: Shapes' `_safeMint` calls the hook with from == 0 and it refuses.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, address(0)));
        vm.prank(bob);
        shapes.mintTo{value: cost}(amount, address(packs));

        uint256 batchCost = 3 * cost;
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, address(0)));
        vm.prank(bob);
        shapes.mintBatchTo{value: batchCost}(amount, 3, address(packs));

        assertEq(shapes.balanceOf(address(packs)), 0);
        assertEq(shapes.totalMinted(), 1, "mints rolled back");
    }

    function test_RevertDirectCallsToTheReceiverHook() public {
        // From an EOA: not Shapes.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, address(0)));
        vm.prank(alice);
        packs.onERC721Received(alice, address(0), 1, "");

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, alice));
        vm.prank(alice);
        packs.onERC721Received(alice, alice, 1, "");

        // Even as Shapes, with the right `from`, the window is closed outside a mint.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, address(0)));
        vm.prank(address(shapes));
        packs.onERC721Received(alice, address(0), 1, "");

        // And as Shapes with a nonzero `from`.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsolicitedToken.selector, bob));
        vm.prank(address(shapes));
        packs.onERC721Received(alice, bob, 1, "");
    }

    function test_PlainTransferFromStrandsAShapeButNoPackNamesIt() public {
        // Documents the accepted residual: a hook-less push cannot be refused.
        uint256 stray = mintShape(alice, 1);
        vm.prank(alice);
        shapes.transferFrom(alice, address(packs), stray);

        assertEq(shapes.ownerOf(stray), address(packs), "the pack contract now holds it");
        assertEq(packs.packOf(stray), 0, "but no pack names it");
        assertEq(shapes.balanceOf(address(packs)), 1);

        // A real pack, then open it: the stray is not released with it.
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        assertEq(packs.packOf(stray), 0);
        assertEq(shapes.balanceOf(address(packs)), 4);
        uint256[] memory contents = packs.contentsOf(packId);
        for (uint256 i = 0; i < contents.length; ++i) {
            assertTrue(contents[i] != stray, "stray is not in any pack");
        }
        assertEq(packs.valueOf(packId), 3 * unit(), "its backing is in nobody's value");

        vm.prank(alice);
        packs.open(packId);
        assertEq(shapes.ownerOf(stray), address(packs), "open of an unrelated pack does not release it");
        assertEq(shapes.balanceOf(address(packs)), 1);
        assertEq(packs.packOf(stray), 0);

        // Same for the other exits.
        uint256 packB = _create(alice, noIds(), mintsOf(0, 3));
        vm.prank(alice);
        packs.redeem(packB);
        uint256 packC = _create(alice, noIds(), mintsOf(0, 3));
        vm.prank(alice);
        packs.unseal(packC, alice);
        vm.prank(alice);
        packs.claim(packC, 100);
        assertEq(shapes.ownerOf(stray), address(packs));
        assertEq(shapes.balanceOf(address(packs)), 1);
    }

    function test_NoOneCanPullOrMoveAStrandedShape() public {
        uint256 stray = mintShape(alice, 1);
        vm.prank(alice);
        shapes.transferFrom(alice, address(packs), stray);
        approveAll(alice);
        approveAll(bob);
        uint32[] memory none = noMints();
        uint32[] memory three = mintsOf(0, 3);
        uint256 cost = costOf(three);

        // The pack contract is its own owner for any pull, so a pull fails the `from` check for
        // the former owner and for everybody else.
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, stray, address(packs))
        );
        vm.prank(alice);
        packs.createPack(ids1(stray), none);

        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, bob, stray, address(packs))
        );
        vm.prank(bob);
        packs.createPack{value: cost}(ids1(stray), three);

        uint256 packId = _create(alice, noIds(), three);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, stray, address(packs))
        );
        vm.prank(alice);
        packs.addToPack(packId, ids1(stray), none);

        // Nor can its former owner reclaim it through Shapes.
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, alice, stray)
        );
        vm.prank(alice);
        shapes.transferFrom(address(packs), alice, stray);

        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, stray, alice));
        vm.prank(alice);
        shapes.redeem(stray);

        assertEq(shapes.ownerOf(stray), address(packs));
        assertEq(packs.packOf(stray), 0);
    }

    /* ------------------------------- direct ETH ------------------------------- */

    function test_RevertDirectEthTransfer() public {
        uint256 before = address(packs).balance;
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(packs).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), IShapePacks.DirectDepositRejected.selector);
        assertEq(address(packs).balance, before);
    }

    function test_RevertDirectEthWithCalldata() public {
        uint256 before = address(packs).balance;
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(packs).call{value: 1}(abi.encodeWithSignature("nonexistent()"));
        assertFalse(ok);
        assertEq(bytes4(ret), IShapePacks.DirectDepositRejected.selector);
        assertEq(address(packs).balance, before);
    }

    function test_RevertCalldataWithoutEthHitsTheFallback() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(packs).call(abi.encodeWithSignature("nonexistent()"));
        assertFalse(ok);
        assertEq(bytes4(ret), IShapePacks.DirectDepositRejected.selector);

        vm.prank(alice);
        (ok, ret) = address(packs).call("");
        assertFalse(ok, "empty call reaches receive, which also reverts");
        assertEq(bytes4(ret), IShapePacks.DirectDepositRejected.selector);
    }

    function test_RevertDirectEthEvenWith2300Gas() public {
        // A `transfer`/`send` style call forwards 2300 gas; it is refused all the same.
        vm.prank(alice);
        (bool ok,) = address(packs).call{value: 1, gas: 2300}("");
        assertFalse(ok);
        assertEq(address(packs).balance, 0);
    }

    function test_ForcedEthDoesNotBreakCreateAddOpenOrRedeem() public {
        // Forced ETH (selfdestruct or block rewards) can still arrive. It is stranded, never used.
        vm.deal(address(packs), 3 ether);

        uint256 packA = _create(alice, noIds(), mintsOf(0, 3));
        assertEq(packs.valueOf(packA), 3 * unit());

        uint256 held = mintShape(alice, 1);
        approveAll(alice);
        uint32[] memory one = mintsOf(0, 1);
        uint256 cost = costOf(one);
        vm.prank(alice);
        packs.addToPack{value: cost}(packA, ids1(held), one);
        assertEq(packs.valueOf(packA), 3 * unit() + amountAt(1) + unit());

        // Redeem pays exactly valueOf, nothing of the forced ETH.
        uint256 packB = _create(alice, noIds(), mintsOf(0, 4));
        uint256 valueB = packs.valueOf(packB);
        uint256 before = alice.balance;
        vm.prank(alice);
        packs.redeem(packB);
        assertEq(alice.balance - before, valueB);

        // Chunked claimEth too.
        uint256 packC = _create(alice, noIds(), mintsOf(0, 5));
        vm.prank(alice);
        packs.unseal(packC, alice);
        before = carol.balance;
        vm.prank(alice);
        packs.claimEth(packC, 2, payable(carol));
        assertEq(carol.balance - before, 2 * unit());

        // Open works.
        vm.prank(alice);
        packs.open(packA);
        assertEq(shapes.ownerOf(held), alice);

        assertEq(address(packs).balance, 3 ether, "forced ETH is untouched and unreachable");
    }

    /* -------------------------------- ERC-165 -------------------------------- */

    function test_SupportsInterface() public view {
        assertTrue(packs.supportsInterface(type(IShapePacks).interfaceId), "IShapePacks");
        assertTrue(packs.supportsInterface(type(IERC721Value).interfaceId), "IERC721Value");
        assertTrue(packs.supportsInterface(type(IERC2981).interfaceId), "IERC2981");
        assertTrue(packs.supportsInterface(bytes4(0x49064906)), "ERC-4906");
        assertTrue(packs.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(packs.supportsInterface(type(IERC721Metadata).interfaceId), "IERC721Metadata");
        assertTrue(packs.supportsInterface(type(IERC165).interfaceId), "IERC165");
    }

    function test_DoesNotSupportOtherInterfaces() public view {
        assertFalse(packs.supportsInterface(0xffffffff), "0xffffffff");
        assertFalse(packs.supportsInterface(0x12345678), "random");
        assertFalse(packs.supportsInterface(0x00000000), "zero");
        // Not claimed by design: Shapes' own interface and the position resolver.
        assertFalse(packs.supportsInterface(type(IShapes).interfaceId), "IShapes");
    }

    function testFuzz_SupportsInterfaceUnknownIdIsFalse(bytes4 id) public view {
        vm.assume(id != type(IShapePacks).interfaceId);
        vm.assume(id != type(IERC721Value).interfaceId);
        vm.assume(id != type(IERC2981).interfaceId);
        vm.assume(id != bytes4(0x49064906));
        vm.assume(id != type(IERC721).interfaceId);
        vm.assume(id != type(IERC721Metadata).interfaceId);
        vm.assume(id != type(IERC165).interfaceId);
        assertFalse(packs.supportsInterface(id));
    }

    function test_RoyaltyInfoIsZero() public view {
        (address receiver, uint256 amount) = packs.royaltyInfo(1, 1 ether);
        assertEq(receiver, address(0));
        assertEq(amount, 0);
        (receiver, amount) = packs.royaltyInfo(123_456, type(uint128).max);
        assertEq(receiver, address(0));
        assertEq(amount, 0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ShapesBase} from "./Shapes.t.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {IAdminControl} from "../src/interfaces/IAdminControl.sol";
import {ComposeRecordView} from "../src/interfaces/IShapeCapabilities.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {BadReceiver, OwnerTokenConsistencyRecorder} from "./mocks/Mocks.sol";
import {Base64Decode} from "./utils/Base64Decode.sol";

/// @notice Issue #56: ownership follows the owner token through compose, decompose and split
///         instead of being pinned to Shape #0.
contract OwnerTokenTest is ShapesBase {
    function _keepGenesisShape() internal pure override returns (bool) {
        return true;
    }

    function _mintDust(address to, uint256 k) internal returns (uint256 first) {
        vm.prank(to);
        first = shapes.mintBatchTo{value: k * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], k, to);
    }

    function _ids4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](4);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
        ids[3] = d;
    }

    function _decodeTokenUri(string memory uri) internal pure returns (string memory json) {
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory raw = bytes(uri);
        bytes memory b64 = new bytes(raw.length - prefix.length);
        for (uint256 i = 0; i < b64.length; ++i) {
            b64[i] = raw[i + prefix.length];
        }
        return string(Base64Decode.decode(string(b64)));
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return n.length == 0;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    /* ------------------------------ genesis ------------------------------ */

    function test_GenesisOwnerTokenIsShapeZero() public view {
        assertEq(shapes.ownerToken(), 0);
        assertEq(shapes.owner(), address(this));
    }

    function test_ConstructorEmitsOwnerTokenMoved() public {
        vm.recordLogs();
        Shapes fresh = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("OwnerTokenMoved(uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(fresh) && logs[i].topics[0] == sig) {
                assertEq(uint256(logs[i].topics[1]), type(uint256).max, "fromTokenId");
                assertEq(uint256(logs[i].topics[2]), 0, "toTokenId");
                found = true;
            }
        }
        assertTrue(found, "constructor did not emit OwnerTokenMoved");
        assertEq(fresh.ownerToken(), 0);
    }

    function test_OwnerTokenRevertsWhenNone() public {
        shapes.redeem(0);
        vm.expectRevert(IShapes.NoOwnerToken.selector);
        shapes.ownerToken();
    }

    /* ------------------------------ compose ------------------------------ */

    function test_ComposeSurvivorAlreadyOwnerTokenIsUnaffected() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4
        vm.recordLogs();
        vm.prank(alice);
        shapes.compose(0, _ids4(1, 2, 3, 4));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("OwnerTokenMoved(uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != sig, "owner token must not move when the survivor holds it");
        }
        assertEq(shapes.ownerToken(), 0);
        assertEq(shapes.owner(), alice);
    }

    function test_ComposeDonorMovesOwnerTokenToSurvivor() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4

        vm.expectEmit(true, true, false, false, address(shapes));
        emit IShapes.OwnerTokenMoved(0, 1);
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));

        assertEq(shapes.ownerToken(), 1, "owner token followed the donor into the survivor");
        assertEq(shapes.owner(), alice);
    }

    function test_DecomposeRestoresOwnerTokenExactly() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));
        assertEq(shapes.ownerToken(), 1);

        vm.expectEmit(true, true, false, false, address(shapes));
        emit IShapes.OwnerTokenMoved(1, 0);
        vm.prank(alice);
        shapes.decompose(1);

        assertEq(shapes.ownerToken(), 0, "owner token restored to #0");
        assertEq(shapes.owner(), alice);
        assertEq(shapes.ownerOf(0), alice);
    }

    function test_NestedComposeLayersRestoreOwnerTokenOnlyAtTheRightDepth() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4)); // 0.05 ETH; owner token moves 0 -> 1

        _mintDust(alice, 5); // ids 5..9
        uint256[] memory secondBurn = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            secondBurn[i] = 5 + i;
        }
        vm.prank(alice);
        shapes.compose(1, secondBurn); // 0.10 ETH; this layer carries no owner token
        assertEq(shapes.ownerToken(), 1);

        vm.prank(alice);
        shapes.decompose(1); // pops the second layer first (LIFO)
        assertEq(shapes.ownerToken(), 1, "second layer carried no owner token to restore");

        vm.prank(alice);
        shapes.decompose(1); // pops the first layer
        assertEq(shapes.ownerToken(), 0, "first layer restored ownership to #0");
        assertEq(shapes.owner(), alice);
    }

    /* ------------------------- ShapeLens.composeRecordAt ------------------------- */

    function test_LensComposeRecordAtOwnerTokenFromIsNoneWhenSurvivorAlreadyHeldIt() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4
        vm.prank(alice);
        shapes.compose(0, _ids4(1, 2, 3, 4));

        ComposeRecordView memory rec = lens.composeRecordAt(0, 0);
        assertEq(rec.ownerTokenFrom, type(uint256).max, "no input carried ownership into this compose");
    }

    function test_LensComposeRecordAtOwnerTokenFromNamesTheDonor() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));

        ComposeRecordView memory rec = lens.composeRecordAt(1, 0);
        assertEq(rec.ownerTokenFrom, 0, "the burned owner token's id");
    }

    function test_LensComposeRecordAtOwnerTokenFromPerDepthAcrossNestedComposes() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4)); // depth 0; owner token moves 0 -> 1

        _mintDust(alice, 5); // ids 5..9
        uint256[] memory secondBurn = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            secondBurn[i] = 5 + i;
        }
        vm.prank(alice);
        shapes.compose(1, secondBurn); // depth 1; carries no owner token

        ComposeRecordView memory inner = lens.composeRecordAt(1, 0);
        assertEq(inner.ownerTokenFrom, 0, "depth 0 recorded the donor that carried ownership");

        ComposeRecordView memory outer = lens.composeRecordAt(1, 1);
        assertEq(outer.ownerTokenFrom, type(uint256).max, "depth 1 carried no owner token");
    }

    function test_ComposeManyAndDecomposeManyMoveAndRestoreOwnerToken() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 9); // ids 1..9

        IShapes.ComposeCall[] memory calls = new IShapes.ComposeCall[](2);
        calls[0] = IShapes.ComposeCall({survivorId: 1, burnIds: _ids4(0, 2, 3, 4)});
        uint256[] memory secondBurn = new uint256[](4);
        secondBurn[0] = 6;
        secondBurn[1] = 7;
        secondBurn[2] = 8;
        secondBurn[3] = 9;
        calls[1] = IShapes.ComposeCall({survivorId: 5, burnIds: secondBurn});

        vm.prank(alice);
        shapes.composeMany(calls);
        assertEq(shapes.ownerToken(), 1, "owner token followed the compose call that absorbed it");

        uint256[] memory survivors = new uint256[](1);
        survivors[0] = 1;
        vm.prank(alice);
        shapes.decomposeMany(survivors);
        assertEq(shapes.ownerToken(), 0);
    }

    function test_DecomposeToRecipientBecomesOwner() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));
        assertEq(shapes.ownerToken(), 1);

        vm.prank(alice);
        shapes.decomposeTo(1, bob);

        assertEq(shapes.ownerToken(), 0);
        assertEq(shapes.owner(), bob, "decomposeTo recipient becomes the collection owner");
        assertEq(shapes.ownerOf(0), bob);
    }

    function test_DecomposeToOwnerTokenNotFirstKeepsCallbacksConsistent() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 5); // ids 1..5
        // survivor #5 + burns [1, 0, 2, 3] sums to 5 dust units, a valid denomination
        uint256[] memory burnIds = new uint256[](4);
        burnIds[0] = 1;
        burnIds[1] = 0; // the owner token, restored second, not first, in the mint loop
        burnIds[2] = 2;
        burnIds[3] = 3;
        vm.prank(alice);
        shapes.compose(5, burnIds);
        assertEq(shapes.ownerToken(), 5, "owner token followed donor #0 into survivor #5");

        OwnerTokenConsistencyRecorder recorder = new OwnerTokenConsistencyRecorder(shapes);
        vm.prank(alice);
        shapes.decomposeTo(5, address(recorder));

        uint256 n = recorder.recordedCount();
        assertEq(n, 4, "one callback per restored input");
        for (uint256 i = 0; i < n; ++i) {
            assertTrue(
                recorder.recordedConsistent(i), "owner()/ownerToken() must agree in every restore callback"
            );
        }
        assertEq(shapes.ownerToken(), 0, "owner token restored to #0 once every input is minted");
        assertEq(shapes.owner(), address(recorder));
    }

    /* ------------------------------- split -------------------------------- */

    function test_SplitGivesOwnershipToFirstChild() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4
        vm.prank(alice);
        shapes.compose(0, _ids4(1, 2, 3, 4)); // grow #0 to 0.05 ETH

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory children = shapes.split(0, outs);

        assertEq(shapes.ownerToken(), children[0]);
        assertEq(shapes.owner(), alice);
    }

    function test_SplitToRecipientBecomesOwner() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(0, _ids4(1, 2, 3, 4));

        uint8[] memory outs = new uint8[](5);
        vm.expectEmit(true, false, false, false, address(shapes));
        emit IShapes.OwnerTokenMoved(0, 5);
        vm.prank(alice);
        uint256[] memory children = shapes.splitTo(0, outs, bob);

        assertEq(shapes.ownerToken(), children[0]);
        assertEq(shapes.owner(), bob, "splitTo recipient becomes the collection owner");
    }

    function test_SplitToKeepsCallbacksConsistentAcrossOutputs() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(0, _ids4(1, 2, 3, 4)); // grow #0 to 0.05 ETH, owner token stays on #0

        OwnerTokenConsistencyRecorder recorder = new OwnerTokenConsistencyRecorder(shapes);
        uint8[] memory outs = new uint8[](5); // 5 outputs > 3 required
        vm.prank(alice);
        uint256[] memory children = shapes.splitTo(0, outs, address(recorder));

        uint256 n = recorder.recordedCount();
        assertEq(n, children.length, "one callback per split output");
        for (uint256 i = 0; i < n; ++i) {
            assertTrue(
                recorder.recordedConsistent(i), "owner()/ownerToken() must agree in every split callback"
            );
        }
        assertEq(shapes.ownerToken(), children[0], "owner token moved to the first child");
        assertEq(shapes.owner(), address(recorder));
    }

    /* --------------------------- redeem / burn ---------------------------- */

    function test_RedeemOwnerTokenEndsOwnershipPermanently() public {
        vm.expectEmit(true, true, false, false, address(shapes));
        emit IShapes.OwnerTokenMoved(0, type(uint256).max);
        shapes.redeem(0);

        assertEq(shapes.owner(), address(0));
        vm.expectRevert(IShapes.NoOwnerToken.selector);
        shapes.ownerToken();
    }

    function test_BurnOwnerTokenEndsOwnershipPermanently() public {
        shapes.burn(0);
        assertEq(shapes.owner(), address(0));
        vm.expectRevert(IShapes.NoOwnerToken.selector);
        shapes.ownerToken();
    }

    /* ------------------------------- Black -------------------------------- */

    /// @dev A genuine apex Complete built on #0 itself: 9,999 dust mints composed onto the
    ///      owner token, mirroring `BlackShapeTest._buildApexComplete` (test/Shapes.t.sol).
    function test_BlackOwnerTokenKeepsOwnershipUntilBurned() public {
        shapes.transferFrom(address(this), alice, 0);
        vm.prank(alice);
        uint256 first =
            shapes.mintBatchTo{value: 9_999 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 9_999, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + i;
        }
        vm.prank(alice);
        shapes.compose(0, burn);
        assertTrue(shapes.isComplete(0), "apex Complete");
        assertEq(shapes.ownerToken(), 0);

        vm.prank(alice);
        shapes.sacrifice(0);
        assertTrue(shapes.isBlack(0));
        assertEq(shapes.owner(), alice, "sacrifice keeps ownership");
        assertEq(shapes.ownerToken(), 0);

        vm.prank(alice);
        shapes.burn(0);
        assertEq(shapes.owner(), address(0), "burning the Black owner token ends ownership");
        vm.expectRevert(IShapes.NoOwnerToken.selector);
        shapes.ownerToken();
    }

    /* ------------------------------ metadata ------------------------------ */

    function test_MetadataTracksOwnerTokenAfterAMove() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);

        string memory ownerBefore = _decodeTokenUri(shapes.tokenURI(0));
        assertEq(vm.parseJsonString(ownerBefore, ".name"), "Shapes Collection Owner");
        assertTrue(_contains(ownerBefore, '"trait_type":"Collection Owner"'));

        string memory survivorBefore = _decodeTokenUri(shapes.tokenURI(1));
        assertFalse(_contains(survivorBefore, '"trait_type":"Collection Owner"'));

        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));

        string memory survivorAfter = _decodeTokenUri(shapes.tokenURI(1));
        assertEq(vm.parseJsonString(survivorAfter, ".name"), "Shapes Collection Owner");
        assertTrue(
            _contains(survivorAfter, '"trait_type":"Collection Owner"'), "new owner token carries the trait"
        );
    }

    /* ---------------------------- hostile receiver ---------------------------- */

    function test_HostileReceiverRevertRollsBackOwnerTokenOnDecomposeTo() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));
        assertEq(shapes.ownerToken(), 1);

        BadReceiver bad = new BadReceiver();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(bad)));
        shapes.decomposeTo(1, address(bad));

        assertEq(shapes.ownerToken(), 1, "failed decomposeTo left the owner token untouched");
    }

    function test_HostileReceiverRevertRollsBackOwnerTokenOnSplitTo() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(0, _ids4(1, 2, 3, 4));

        BadReceiver bad = new BadReceiver();
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(bad)));
        shapes.splitTo(0, outs, address(bad));

        assertEq(shapes.ownerToken(), 0, "failed splitTo left the owner token untouched");
        assertEq(shapes.ownerOf(0), alice);
    }

    /* ------------------------------- admin --------------------------------- */

    function test_OwnerTokenHolderHasNoAdminPermissions() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4);
        vm.prank(alice);
        shapes.compose(1, _ids4(0, 2, 3, 4));
        assertEq(shapes.ownerToken(), 1);
        assertEq(shapes.ownerOf(1), alice);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setMetadataCopy("x", "y");
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.lockRenderer();
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setFeeRecipient(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.transferAdmin(alice);
        vm.stopPrank();
    }

    receive() external payable {}
}

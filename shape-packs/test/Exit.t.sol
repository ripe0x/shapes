// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IShapes} from "shapes/interfaces/IShapes.sol";

import {PacksTest} from "./utils/PacksTest.sol";
import {IShapePacks} from "../src/interfaces/IShapePacks.sol";
import {ShapePacks} from "../src/ShapePacks.sol";

/// @dev An ETH recipient whose `receive` always reverts.
contract RevertingRecipient {
    receive() external payable {
        revert("no ETH here");
    }
}

/// @dev Owns packs, is a payout recipient, and on receiving ETH tries a list of calls into the pack
///      contract. With `swallow` the results are recorded; without it the first failure is bubbled
///      so the whole payout fails.
contract ReentrantActor {
    ShapePacks public immutable packs;

    bytes[] internal _payloads;
    uint256[] internal _values;
    bool public swallow;
    bool public armed;
    bool[] public oks;
    bytes[] internal _rets;

    constructor(ShapePacks packs_) payable {
        packs = packs_;
    }

    function setAttack(bytes[] memory payloads, uint256[] memory values, bool swallow_) external {
        _payloads = payloads;
        _values = values;
        swallow = swallow_;
        armed = true;
        delete oks;
        delete _rets;
    }

    function exec(bytes calldata data) external payable {
        (bool ok, bytes memory ret) = address(packs).call{value: msg.value}(data);
        if (!ok) _bubble(ret);
    }

    function attempts() external view returns (uint256) {
        return oks.length;
    }

    function retAt(uint256 i) external view returns (bytes memory) {
        return _rets[i];
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        for (uint256 i = 0; i < _payloads.length; ++i) {
            (bool ok, bytes memory ret) = address(packs).call{value: _values[i]}(_payloads[i]);
            oks.push(ok);
            _rets.push(ret);
            if (!ok && !swallow) _bubble(ret);
        }
    }

    function _bubble(bytes memory ret) private pure {
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}

/// @dev A `createPackTo` recipient whose hook calls back into the pack contract.
contract HookReceiver is IERC721Receiver {
    uint8 internal constant OPEN = 0;
    uint8 internal constant REDEEM = 1;
    uint8 internal constant UNSEAL = 2;
    uint8 internal constant ADD = 3;
    uint8 internal constant CREATE = 4;

    ShapePacks public immutable packs;
    uint8 public mode;
    bool public swallow;

    bool public called;
    bool public ok;
    bytes public ret;
    address public seenOwner;
    uint256 public seenValue;
    uint256 public seenCount;

    constructor(ShapePacks packs_) {
        packs = packs_;
    }

    function configure(uint8 mode_, bool swallow_) external {
        mode = mode_;
        swallow = swallow_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        called = true;
        seenOwner = packs.ownerOf(tokenId);
        seenValue = packs.valueOf(tokenId);
        seenCount = packs.contentsOf(tokenId).length;

        bytes memory data;
        if (mode == OPEN) {
            data = abi.encodeCall(IShapePacks.open, (tokenId));
        } else if (mode == REDEEM) {
            data = abi.encodeCall(IShapePacks.redeem, (tokenId));
        } else if (mode == UNSEAL) {
            data = abi.encodeCall(IShapePacks.unseal, (tokenId, address(this)));
        } else if (mode == ADD) {
            data = abi.encodeCall(IShapePacks.addToPack, (tokenId, new uint256[](0), new uint32[](9)));
        } else {
            data = abi.encodeCall(IShapePacks.createPack, (new uint256[](0), new uint32[](9)));
        }
        (ok, ret) = address(packs).call(data);
        if (!ok && !swallow) {
            bytes memory r = ret;
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice Every way out of a pack: open, redeem, burn, unseal and the chunked claims, plus the
///         owner-only, reentrancy and self-custody rules around them.
contract ExitTest is PacksTest {
    address internal carol = address(0xCA401);

    /* ------------------------------ helpers ------------------------------ */

    function _create(address who, uint256[] memory ids, uint32[] memory counts)
        internal
        returns (uint256 packId)
    {
        uint256 cost = costOf(counts);
        vm.prank(who);
        packId = packs.createPack{value: cost}(ids, counts);
    }

    /// @dev 2 pulled 0.01 Shapes then 3 minted 0.01 Shapes: five Shapes, 5 units.
    function _mixedPack(address who) internal returns (uint256 packId) {
        uint256[] memory held = mintShapes(who, 0, 2);
        approveAll(who);
        packId = _create(who, held, mintsOf(0, 3));
    }

    /// @dev Four Shapes of different sizes: 2 x unit, 1 x 5 units, 1 x 10 units = 17 units.
    function _variedPack(address who) internal returns (uint256 packId) {
        uint32[] memory counts = noMints();
        counts[0] = 2;
        counts[1] = 1;
        counts[2] = 1;
        packId = _create(who, noIds(), counts);
    }

    function _reverse(uint256[] memory a) internal pure returns (uint256[] memory out) {
        out = new uint256[](a.length);
        for (uint256 i = 0; i < a.length; ++i) {
            out[i] = a[a.length - 1 - i];
        }
    }

    function _slice(uint256[] memory a, uint256 from, uint256 to)
        internal
        pure
        returns (uint256[] memory out)
    {
        out = new uint256[](to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = a[i];
        }
    }

    function _assertNotAPack(uint256 packId) internal {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, packId));
        packs.ownerOf(packId);
        assertFalse(packs.exists(packId), "exists");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, packId));
        packs.valueOf(packId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, packId));
        packs.makeupOf(packId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, packId));
        packs.packState(packId);
    }

    /// @dev Pack still live and exactly as it was.
    function _assertUntouched(uint256 packId, address holder, uint256[] memory ids, uint256 value)
        internal
        view
    {
        assertEq(packs.ownerOf(packId), holder, "still owned");
        assertEq(packs.valueOf(packId), value, "same value");
        uint256[] memory now_ = packs.contentsOf(packId);
        assertEq(now_.length, ids.length, "same length");
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(now_[i], ids[i], "same contents");
            assertEq(packs.packOf(ids[i]), packId);
            assertEq(shapes.ownerOf(ids[i]), address(packs));
        }
        assertEq(packs.claimantOf(packId), address(0));
        assertTrue(packs.exists(packId));
    }

    function _isTransfer(Vm.Log memory l, address emitter, address from, address to, uint256 tokenId)
        internal
        pure
    {
        assertEq(l.emitter, emitter, "transfer emitter");
        assertEq(l.topics[0], IERC721.Transfer.selector, "transfer sig");
        assertEq(address(uint160(uint256(l.topics[1]))), from, "transfer from");
        assertEq(address(uint160(uint256(l.topics[2]))), to, "transfer to");
        assertEq(uint256(l.topics[3]), tokenId, "transfer id");
    }

    /* ---------------------------------- open ---------------------------------- */

    function test_Open() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        assertEq(contents.length, 5);
        uint256 supplyBefore = packs.totalSupply();
        uint256 mintedBefore = packs.totalMinted();
        uint256 shapesSupply = shapes.totalSupply();

        vm.recordLogs();
        vm.prank(alice);
        packs.open(packId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertNotAPack(packId);
        assertEq(packs.totalSupply(), supplyBefore - 1, "totalSupply decremented");
        assertEq(packs.totalMinted(), mintedBefore, "totalMinted unchanged");
        assertEq(shapes.totalSupply(), shapesSupply, "no Shape destroyed");
        for (uint256 i = 0; i < contents.length; ++i) {
            assertEq(shapes.ownerOf(contents[i]), alice, "returned to the caller");
            assertEq(packs.packOf(contents[i]), 0, "packOf cleared");
        }
        assertEq(packs.claimantOf(packId), address(0), "claimant cleared");
        assertEq(packs.contentsOf(packId).length, 0, "contents empty");
        assertEq(packs.creatorOf(packId), alice, "creator survives");
        assertEq(address(packs).balance, 0);
        assertEq(shapes.balanceOf(address(packs)), 0);

        // Exact log sequence: pack burn Transfer, PackUnsealed, one Shapes Transfer per Shape in
        // reverse insertion order, then ShapesClaimed.
        uint256 n = contents.length;
        assertEq(logs.length, n + 3, "log count");
        _isTransfer(logs[0], address(packs), alice, address(0), packId);

        assertEq(logs[1].emitter, address(packs));
        assertEq(logs[1].topics[0], IShapePacks.PackUnsealed.selector);
        assertEq(uint256(logs[1].topics[1]), packId);
        assertEq(address(uint160(uint256(logs[1].topics[2]))), alice, "owner");
        assertEq(address(uint160(uint256(logs[1].topics[3]))), alice, "claimant");
        assertEq(abi.decode(logs[1].data, (uint256)), n, "count");

        uint256[] memory reversed = _reverse(contents);
        for (uint256 i = 0; i < n; ++i) {
            _isTransfer(logs[2 + i], address(shapes), address(packs), alice, reversed[i]);
        }

        Vm.Log memory claimed = logs[n + 2];
        assertEq(claimed.emitter, address(packs));
        assertEq(claimed.topics[0], IShapePacks.ShapesClaimed.selector);
        assertEq(uint256(claimed.topics[1]), packId);
        assertEq(address(uint160(uint256(claimed.topics[2]))), alice);
        uint256[] memory claimedIds = abi.decode(claimed.data, (uint256[]));
        assertEq(claimedIds.length, n);
        for (uint256 i = 0; i < n; ++i) {
            assertEq(claimedIds[i], reversed[i], "ShapesClaimed lists reverse insertion order");
        }
    }

    function test_OpenSingleShapePack() public {
        uint256 id = mintShape(alice, 1);
        approveAll(alice);
        uint256 packId = _create(alice, ids1(id), noMints());
        vm.prank(alice);
        packs.open(packId);
        assertEq(shapes.ownerOf(id), alice);
        _assertNotAPack(packId);
    }

    function test_OpenTo() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackUnsealed(packId, alice, bob, 5);
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.ShapesClaimed(packId, bob, _reverse(contents));
        vm.prank(alice);
        packs.openTo(packId, bob);

        _assertNotAPack(packId);
        for (uint256 i = 0; i < contents.length; ++i) {
            assertEq(shapes.ownerOf(contents[i]), bob, "Shapes to bob");
            assertEq(packs.packOf(contents[i]), 0);
        }
        assertEq(shapes.balanceOf(alice), 0);
        assertEq(packs.claimantOf(packId), address(0));
    }

    function test_RevertOpenToZeroAndToThePack() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(0)));
        vm.prank(alice);
        packs.openTo(packId, address(0));

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(packs)));
        vm.prank(alice);
        packs.openTo(packId, address(packs));

        _assertUntouched(packId, alice, contents, value);
    }

    function test_OpenByPackBuyerAfterTransfer() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        vm.prank(alice);
        packs.transferFrom(alice, bob, packId);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, alice));
        vm.prank(alice);
        packs.open(packId);

        vm.prank(bob);
        packs.open(packId);
        for (uint256 i = 0; i < contents.length; ++i) {
            assertEq(shapes.ownerOf(contents[i]), bob);
        }
        assertEq(packs.creatorOf(packId), alice);
    }

    /* --------------------------------- redeem --------------------------------- */

    function test_Redeem() public {
        uint256 packId = _variedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        assertEq(value, 17 * unit());
        uint256 balBefore = alice.balance;
        uint256 shapesSupply = shapes.totalSupply();
        uint256 backingBefore = shapes.redeemableBacking();

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackUnsealed(packId, alice, alice, 4);
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.EthClaimed(packId, alice, _reverse(contents), value);
        vm.prank(alice);
        packs.redeem(packId);

        assertEq(alice.balance, balBefore + value, "alice receives exactly valueOf");
        for (uint256 i = 0; i < contents.length; ++i) {
            assertFalse(shapes.exists(contents[i]), "Shape burned");
            assertEq(packs.packOf(contents[i]), 0);
        }
        _assertNotAPack(packId);
        assertEq(packs.totalSupply(), 0);
        assertEq(packs.totalMinted(), 1);
        assertEq(shapes.totalSupply(), shapesSupply - 4);
        assertEq(backingBefore - shapes.redeemableBacking(), value);
        assertEq(address(packs).balance, 0, "the pack contract never touches the ETH");
        assertEq(packs.claimantOf(packId), address(0));
    }

    function test_RedeemTo() public {
        uint256 packId = _variedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        uint256 aliceBefore = alice.balance;
        uint256 carolBefore = carol.balance;

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackUnsealed(packId, alice, alice, 4);
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.EthClaimed(packId, carol, _reverse(contents), value);
        vm.prank(alice);
        packs.redeemTo(packId, payable(carol));

        assertEq(carol.balance, carolBefore + value, "recipient is paid");
        assertEq(alice.balance, aliceBefore, "caller is not");
        for (uint256 i = 0; i < contents.length; ++i) {
            assertFalse(shapes.exists(contents[i]));
        }
        _assertNotAPack(packId);
    }

    function test_BurnIsIdenticalToRedeem() public {
        uint256 packA = _variedPack(alice);
        uint256 packB = _variedPack(alice);
        uint256[] memory contentsA = packs.contentsOf(packA);
        uint256[] memory contentsB = packs.contentsOf(packB);
        uint256 value = packs.valueOf(packA);
        assertEq(packs.valueOf(packB), value);

        uint256 b0 = alice.balance;
        vm.prank(alice);
        packs.redeem(packA);
        uint256 redeemDelta = alice.balance - b0;

        uint256 b1 = alice.balance;
        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackUnsealed(packB, alice, alice, 4);
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.EthClaimed(packB, alice, _reverse(contentsB), value);
        vm.prank(alice);
        packs.burn(packB);
        uint256 burnDelta = alice.balance - b1;

        assertEq(burnDelta, redeemDelta, "same payout");
        assertEq(burnDelta, value);
        for (uint256 i = 0; i < contentsB.length; ++i) {
            assertFalse(shapes.exists(contentsB[i]));
            assertFalse(shapes.exists(contentsA[i]));
        }
        _assertNotAPack(packA);
        _assertNotAPack(packB);
        assertEq(packs.totalSupply(), 0);
    }

    function test_BurnPaysTheCallerNotAnyoneElse() public {
        uint256 packId = _variedPack(alice);
        uint256 value = packs.valueOf(packId);
        uint256 before = alice.balance;
        vm.prank(alice);
        packs.burn(packId);
        assertEq(alice.balance - before, value);
    }

    function test_RevertRedeemToZero() public {
        uint256 packId = _variedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(0)));
        vm.prank(alice);
        packs.redeemTo(packId, payable(address(0)));
        _assertUntouched(packId, alice, contents, value);
    }

    function test_RevertRedeemToRevertingRecipientLeavesPackUntouched() public {
        uint256 packId = _variedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        RevertingRecipient rr = new RevertingRecipient();
        uint256 supplyBefore = packs.totalSupply();

        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(rr), value));
        vm.prank(alice);
        packs.redeemTo(packId, payable(address(rr)));

        _assertUntouched(packId, alice, contents, value);
        assertEq(packs.totalSupply(), supplyBefore);
        assertEq(address(rr).balance, 0);
        for (uint256 i = 0; i < contents.length; ++i) {
            assertTrue(shapes.exists(contents[i]), "no Shape burned");
        }

        // And the owner can still exit normally.
        vm.prank(alice);
        packs.redeem(packId);
        _assertNotAPack(packId);
    }

    function test_RevertRedeemToThePackContractLeavesPackUntouched() public {
        uint256 packId = _variedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);

        // The pack contract refuses ETH, so Shapes' payout fails and the transaction reverts.
        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(packs), value));
        vm.prank(alice);
        packs.redeemTo(packId, payable(address(packs)));

        _assertUntouched(packId, alice, contents, value);
        assertEq(address(packs).balance, 0);
    }

    function test_RevertClaimEthToRevertingRecipientKeepsTheChunk() public {
        uint256 packId = _variedPack(alice);
        uint256[] memory contents = packs.contentsOf(packId);
        RevertingRecipient rr = new RevertingRecipient();
        vm.prank(alice);
        packs.unseal(packId, alice);

        // The last Shape is the 10-unit one.
        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(rr), 10 * unit()));
        vm.prank(alice);
        packs.claimEth(packId, 1, payable(address(rr)));

        // Nothing was popped: all four remain and the claim is still alice's.
        uint256[] memory remaining = packs.contentsOf(packId);
        assertEq(remaining.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(remaining[i], contents[i]);
            assertEq(packs.packOf(contents[i]), packId);
        }
        assertEq(packs.claimantOf(packId), alice);
    }

    /* ------------------------- unseal + chunked claim ------------------------- */

    function test_UnsealAndChunkedClaim() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 10));
        uint256[] memory ids = packs.contentsOf(packId);
        assertEq(ids.length, 10);

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackUnsealed(packId, alice, alice, 10);
        vm.prank(alice);
        packs.unseal(packId, alice);

        // Unsealed: no longer an NFT, still custodied, claim recorded.
        _assertNotAPack(packId);
        assertEq(packs.totalSupply(), 0);
        assertEq(packs.claimantOf(packId), alice);
        assertEq(packs.contentsOf(packId).length, 10);
        for (uint256 i = 0; i < 10; ++i) {
            assertEq(packs.packOf(ids[i]), packId, "packOf still names the pack");
            assertEq(shapes.ownerOf(ids[i]), address(packs));
        }

        // Chunk 1: 3 Shapes from the end.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.ShapesClaimed(packId, alice, _reverse(_slice(ids, 7, 10)));
        vm.prank(alice);
        packs.claim(packId, 3);
        _assertRemaining(packId, ids, 7, alice);
        assertEq(shapes.ownerOf(ids[9]), alice);
        assertEq(shapes.ownerOf(ids[8]), alice);
        assertEq(shapes.ownerOf(ids[7]), alice);

        // Chunk 2: 3 more.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.ShapesClaimed(packId, alice, _reverse(_slice(ids, 4, 7)));
        vm.prank(alice);
        packs.claim(packId, 3);
        _assertRemaining(packId, ids, 4, alice);

        // Chunk 3: the last 4, exactly the remainder.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.ShapesClaimed(packId, alice, _reverse(_slice(ids, 0, 4)));
        vm.prank(alice);
        packs.claim(packId, 4);
        _assertRemaining(packId, ids, 0, alice);
        assertEq(packs.claimantOf(packId), address(0), "claimant cleared after the last Shape");
        for (uint256 i = 0; i < 10; ++i) {
            assertEq(shapes.ownerOf(ids[i]), alice);
            assertEq(packs.packOf(ids[i]), 0);
        }
        assertEq(shapes.balanceOf(address(packs)), 0);

        // Drained.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NothingToClaim.selector, packId));
        vm.prank(alice);
        packs.claim(packId, 1);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NothingToClaim.selector, packId));
        vm.prank(alice);
        packs.claimEth(packId, 1, payable(alice));
    }

    /// @dev Remaining contents are the first `len` of `ids`; the rest are released.
    function _assertRemaining(uint256 packId, uint256[] memory ids, uint256 len, address claimant)
        internal
        view
    {
        uint256[] memory rem = packs.contentsOf(packId);
        assertEq(rem.length, len, "remaining length");
        for (uint256 i = 0; i < ids.length; ++i) {
            if (i < len) {
                assertEq(rem[i], ids[i], "remaining is a prefix");
                assertEq(packs.packOf(ids[i]), packId, "unclaimed still packed");
                assertEq(shapes.ownerOf(ids[i]), address(packs));
            } else {
                assertEq(packs.packOf(ids[i]), 0, "claimed packOf cleared");
                assertEq(shapes.ownerOf(ids[i]), claimant);
            }
        }
        if (len > 0) assertEq(packs.claimantOf(packId), claimant, "claimant kept until the end");
    }

    function test_ClaimMoreThanRemainingPopsAll() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 5));
        uint256[] memory ids = packs.contentsOf(packId);
        vm.prank(alice);
        packs.unseal(packId, alice);

        vm.prank(alice);
        packs.claim(packId, 2);
        vm.prank(alice);
        packs.claim(packId, type(uint256).max);

        _assertRemaining(packId, ids, 0, alice);
        assertEq(packs.claimantOf(packId), address(0));
    }

    function test_RevertClaimZeroQuantity() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        vm.prank(alice);
        packs.unseal(packId, alice);
        vm.expectRevert(IShapePacks.ZeroQuantity.selector);
        vm.prank(alice);
        packs.claim(packId, 0);
        vm.expectRevert(IShapePacks.ZeroQuantity.selector);
        vm.prank(alice);
        packs.claimEth(packId, 0, payable(alice));
        assertEq(packs.contentsOf(packId).length, 3);
    }

    function test_RevertClaimByNonClaimant() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        vm.prank(alice);
        packs.unseal(packId, alice);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotClaimant.selector, packId, bob));
        vm.prank(bob);
        packs.claim(packId, 1);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotClaimant.selector, packId, bob));
        vm.prank(bob);
        packs.claimEth(packId, 1, payable(bob));

        assertEq(packs.contentsOf(packId).length, 3);
    }

    function test_RevertClaimOnALivePackOrUnknownPack() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        // Never unsealed: there is no claim to draw on, even for the owner.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NothingToClaim.selector, packId));
        vm.prank(alice);
        packs.claim(packId, 1);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NothingToClaim.selector, packId));
        vm.prank(alice);
        packs.claimEth(packId, 1, payable(alice));
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NothingToClaim.selector, 999));
        vm.prank(alice);
        packs.claim(999, 1);
    }

    function test_RevertUnsealByNonOwner() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob));
        vm.prank(bob);
        packs.unseal(packId, bob);
        assertEq(packs.ownerOf(packId), alice);
        assertEq(packs.claimantOf(packId), address(0));
    }

    function test_RevertUnsealTwiceAndUnknownPack() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        vm.prank(alice);
        packs.unseal(packId, alice);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, alice));
        vm.prank(alice);
        packs.unseal(packId, alice);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, 77, alice));
        vm.prank(alice);
        packs.unseal(77, alice);
    }

    function test_RevertUnsealToZeroAndToThePack() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        uint256[] memory ids = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(0)));
        vm.prank(alice);
        packs.unseal(packId, address(0));

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(packs)));
        vm.prank(alice);
        packs.unseal(packId, address(packs));

        _assertUntouched(packId, alice, ids, value);
    }

    function test_RevertClaimEthToZeroKeepsTheClaim() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 3));
        uint256[] memory ids = packs.contentsOf(packId);
        vm.prank(alice);
        packs.unseal(packId, alice);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.InvalidRecipient.selector, address(0)));
        vm.prank(alice);
        packs.claimEth(packId, 3, payable(address(0)));

        _assertRemaining(packId, ids, 3, alice);
    }

    /* ----------------------- unseal + claimEth, mixed with claim ----------------------- */

    function test_ChunkedClaimEthMixedWithClaim() public {
        // Seven Shapes: 4 x 0.01, 2 x 0.05, 1 x 0.1 = 24 units; contents ascend by denomination.
        uint32[] memory counts = noMints();
        counts[0] = 4;
        counts[1] = 2;
        counts[2] = 1;
        uint256 packId = _create(alice, noIds(), counts);
        uint256[] memory ids = packs.contentsOf(packId);
        assertEq(ids.length, 7);
        assertEq(packs.valueOf(packId), 24 * unit());
        vm.prank(alice);
        packs.unseal(packId, alice);

        // Chunk 1: claimEth 3 to carol: the 0.1 and both 0.05s = 20 units.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.EthClaimed(packId, carol, _reverse(_slice(ids, 4, 7)), 20 * unit());
        vm.prank(alice);
        packs.claimEth(packId, 3, payable(carol));
        assertEq(carol.balance, 20 * unit());
        for (uint256 i = 4; i < 7; ++i) {
            assertFalse(shapes.exists(ids[i]));
            assertEq(packs.packOf(ids[i]), 0);
        }
        assertEq(packs.contentsOf(packId).length, 4);
        assertEq(packs.claimantOf(packId), alice);

        // Chunk 2: claim 2 as Shapes to alice.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.ShapesClaimed(packId, alice, _reverse(_slice(ids, 2, 4)));
        vm.prank(alice);
        packs.claim(packId, 2);
        assertEq(shapes.ownerOf(ids[3]), alice);
        assertEq(shapes.ownerOf(ids[2]), alice);
        assertEq(packs.contentsOf(packId).length, 2);
        assertEq(carol.balance, 20 * unit(), "claim paid no ETH");

        // Chunk 3: claimEth the last 2 to carol: 2 units.
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.EthClaimed(packId, carol, _reverse(_slice(ids, 0, 2)), 2 * unit());
        vm.prank(alice);
        packs.claimEth(packId, 2, payable(carol));

        assertEq(carol.balance, 22 * unit());
        assertEq(packs.claimantOf(packId), address(0));
        assertEq(packs.contentsOf(packId).length, 0);
        assertEq(shapes.balanceOf(address(packs)), 0);
        assertEq(address(packs).balance, 0);
        // Total Shapes ETH paid out plus Shapes still held equals the pack's original value.
        assertEq(carol.balance + 2 * unit(), 24 * unit());
    }

    function test_UnsealToADifferentClaimant() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 6));
        uint256[] memory ids = packs.contentsOf(packId);

        vm.expectEmit(true, true, true, true, address(packs));
        emit IShapePacks.PackUnsealed(packId, alice, bob, 6);
        vm.prank(alice);
        packs.unseal(packId, bob);
        assertEq(packs.claimantOf(packId), bob);

        // Alice gave the claim away: she can no longer draw on it.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotClaimant.selector, packId, alice));
        vm.prank(alice);
        packs.claim(packId, 1);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.NotClaimant.selector, packId, alice));
        vm.prank(alice);
        packs.claimEth(packId, 1, payable(alice));

        vm.prank(bob);
        packs.claim(packId, 2);
        assertEq(shapes.ownerOf(ids[5]), bob);
        assertEq(shapes.ownerOf(ids[4]), bob);

        uint256 carolBefore = carol.balance;
        vm.expectEmit(true, true, false, true, address(packs));
        emit IShapePacks.EthClaimed(packId, carol, _reverse(_slice(ids, 2, 4)), 2 * unit());
        vm.prank(bob);
        packs.claimEth(packId, 2, payable(carol));
        assertEq(carol.balance - carolBefore, 2 * unit());

        vm.prank(bob);
        packs.claim(packId, 10);
        assertEq(shapes.ownerOf(ids[0]), bob);
        assertEq(shapes.ownerOf(ids[1]), bob);
        assertEq(packs.claimantOf(packId), address(0));
        assertEq(shapes.balanceOf(alice), 0);
    }

    /* ----------------------------- owner-only exits ----------------------------- */

    function test_RevertApprovedOperatorCannotExit() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory ids = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        vm.prank(alice);
        packs.approve(bob, packId);

        bytes memory err = abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob);
        vm.startPrank(bob);
        vm.expectRevert(err);
        packs.open(packId);
        vm.expectRevert(err);
        packs.openTo(packId, bob);
        vm.expectRevert(err);
        packs.redeem(packId);
        vm.expectRevert(err);
        packs.redeemTo(packId, payable(bob));
        vm.expectRevert(err);
        packs.burn(packId);
        vm.expectRevert(err);
        packs.unseal(packId, bob);
        vm.stopPrank();

        _assertUntouched(packId, alice, ids, value);
    }

    function test_RevertApprovalForAllOperatorCannotExit() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory ids = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        vm.prank(alice);
        packs.setApprovalForAll(bob, true);

        bytes memory err = abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, bob);
        vm.startPrank(bob);
        vm.expectRevert(err);
        packs.open(packId);
        vm.expectRevert(err);
        packs.redeem(packId);
        vm.expectRevert(err);
        packs.unseal(packId, bob);
        vm.stopPrank();

        _assertUntouched(packId, alice, ids, value);
    }

    function test_OperatorCanTransferToItselfThenOpen() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory ids = packs.contentsOf(packId);
        vm.prank(alice);
        packs.approve(bob, packId);

        vm.startPrank(bob);
        packs.transferFrom(alice, bob, packId);
        packs.open(packId);
        vm.stopPrank();

        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(shapes.ownerOf(ids[i]), bob);
        }
    }

    function test_RevertStrangerCannotExit() public {
        uint256 packId = _mixedPack(alice);
        bytes memory err = abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, carol);
        vm.startPrank(carol);
        vm.expectRevert(err);
        packs.open(packId);
        vm.expectRevert(err);
        packs.redeem(packId);
        vm.expectRevert(err);
        packs.unseal(packId, carol);
        vm.stopPrank();
    }

    function test_RevertExitOfAnAlreadyExitedPack() public {
        uint256 packId = _mixedPack(alice);
        vm.prank(alice);
        packs.open(packId);
        bytes memory err = abi.encodeWithSelector(IShapePacks.NotPackOwner.selector, packId, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        packs.open(packId);
        vm.expectRevert(err);
        packs.redeem(packId);
        vm.expectRevert(err);
        packs.burn(packId);
        vm.stopPrank();
    }

    /* ------------------------------- self custody ------------------------------- */

    function test_RevertPackTransferToThePackContract() public {
        uint256 packId = _mixedPack(alice);
        uint256[] memory ids = packs.contentsOf(packId);
        uint256 value = packs.valueOf(packId);
        bytes memory err = abi.encodeWithSelector(IShapePacks.SelfCustodyRejected.selector, packId);

        vm.expectRevert(err);
        vm.prank(alice);
        packs.transferFrom(alice, address(packs), packId);

        // `_update` refuses first, so a safe transfer fails with the same error before the
        // receiver hook would be asked.
        vm.expectRevert(err);
        vm.prank(alice);
        packs.safeTransferFrom(alice, address(packs), packId);

        vm.expectRevert(err);
        vm.prank(alice);
        packs.safeTransferFrom(alice, address(packs), packId, "data");

        _assertUntouched(packId, alice, ids, value);
    }

    /* ------------------------------- reentrancy ------------------------------- */

    function _guardError() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function _giveToActor(ReentrantActor actor, uint256 packId) internal {
        vm.prank(alice);
        packs.transferFrom(alice, address(actor), packId);
    }

    /// @dev Calls an attacker could try from inside a payout, all against packs the actor really
    ///      controls, so only the reentrancy guard stands in the way.
    function _attackPayloads(uint256 livePack, uint256 unsealedPack, address actor)
        internal
        view
        returns (bytes[] memory p, uint256[] memory v)
    {
        uint32[] memory three = mintsOf(0, 3);
        uint32[] memory one = mintsOf(0, 1);
        p = new bytes[](8);
        v = new uint256[](8);
        p[0] = abi.encodeCall(packs.redeem, (livePack));
        p[1] = abi.encodeCall(packs.open, (livePack));
        p[2] = abi.encodeCall(packs.claimEth, (unsealedPack, 1, payable(actor)));
        p[3] = abi.encodeCall(packs.claim, (unsealedPack, 1));
        p[4] = abi.encodeCall(packs.unseal, (livePack, actor));
        p[5] = abi.encodeCall(packs.createPack, (noIds(), three));
        v[5] = costOf(three);
        p[6] = abi.encodeCall(packs.addToPack, (livePack, noIds(), one));
        v[6] = costOf(one);
        p[7] = abi.encodeCall(packs.burn, (livePack));
    }

    function test_ReentrantRecipientEveryCallFailsWithTheGuard() public {
        ReentrantActor actor = new ReentrantActor(packs);
        vm.deal(address(actor), 10 ether);

        uint256 outer = _variedPack(alice);
        uint256 live = _variedPack(alice);
        uint256 drained = _create(alice, noIds(), mintsOf(0, 4));
        _giveToActor(actor, outer);
        _giveToActor(actor, live);
        _giveToActor(actor, drained);
        actor.exec(abi.encodeCall(packs.unseal, (drained, address(actor))));
        assertEq(packs.claimantOf(drained), address(actor));

        (bytes[] memory p, uint256[] memory v) = _attackPayloads(live, drained, address(actor));
        actor.setAttack(p, v, true);

        uint256 liveValue = packs.valueOf(live);
        uint256[] memory liveIds = packs.contentsOf(live);
        uint256 outerValue = packs.valueOf(outer);
        uint256 before = address(actor).balance;

        actor.exec(abi.encodeCall(packs.redeem, (outer)));

        // The outer redeem went through and paid exactly its value; every inner attempt failed.
        assertEq(address(actor).balance, before + outerValue);
        assertEq(actor.attempts(), 8);
        for (uint256 i = 0; i < 8; ++i) {
            assertFalse(actor.oks(i), "inner call must fail");
            assertEq(actor.retAt(i), _guardError(), "with the reentrancy guard");
        }
        _assertNotAPack(outer);
        _assertUntouched(live, address(actor), liveIds, liveValue);
        assertEq(packs.claimantOf(drained), address(actor));
        assertEq(packs.contentsOf(drained).length, 4);
        assertEq(packs.totalSupply(), 1, "only `live` remains a pack");
    }

    function test_RevertReentrantRecipientMakesTheOuterRedeemFail() public {
        ReentrantActor actor = new ReentrantActor(packs);
        vm.deal(address(actor), 10 ether);

        uint256 outer = _variedPack(alice);
        uint256 live = _variedPack(alice);
        uint256 drained = _create(alice, noIds(), mintsOf(0, 4));
        _giveToActor(actor, outer);
        _giveToActor(actor, live);
        _giveToActor(actor, drained);
        actor.exec(abi.encodeCall(packs.unseal, (drained, address(actor))));

        uint256 outerValue = packs.valueOf(outer);
        uint256[] memory outerIds = packs.contentsOf(outer);

        (bytes[] memory all, uint256[] memory allValues) = _attackPayloads(live, drained, address(actor));
        for (uint256 i = 0; i < all.length; ++i) {
            bytes[] memory p = new bytes[](1);
            uint256[] memory v = new uint256[](1);
            p[0] = all[i];
            v[0] = allValues[i];
            actor.setAttack(p, v, false);

            // The inner call reverts with the guard, `receive` bubbles it, Shapes' ETH transfer
            // fails, and the outer redeem reverts with Shapes' EthTransferFailed.
            vm.expectRevert(
                abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(actor), outerValue)
            );
            actor.exec(abi.encodeCall(packs.redeem, (outer)));
        }
        _assertUntouched(outer, address(actor), outerIds, outerValue);
        assertEq(packs.totalSupply(), 2);
    }

    function test_ReentrantClaimantCannotReenterClaimEth() public {
        ReentrantActor actor = new ReentrantActor(packs);
        vm.deal(address(actor), 10 ether);

        uint256 drained = _create(alice, noIds(), mintsOf(0, 6));
        _giveToActor(actor, drained);
        actor.exec(abi.encodeCall(packs.unseal, (drained, address(actor))));

        bytes[] memory p = new bytes[](2);
        uint256[] memory v = new uint256[](2);
        p[0] = abi.encodeCall(packs.claimEth, (drained, 1, payable(address(actor))));
        p[1] = abi.encodeCall(packs.claim, (drained, 1));
        actor.setAttack(p, v, true);

        uint256 before = address(actor).balance;
        actor.exec(abi.encodeCall(packs.claimEth, (drained, 2, payable(address(actor)))));

        assertEq(address(actor).balance, before + 2 * unit(), "only the outer chunk paid");
        assertEq(actor.attempts(), 2);
        assertFalse(actor.oks(0));
        assertFalse(actor.oks(1));
        assertEq(actor.retAt(0), _guardError());
        assertEq(actor.retAt(1), _guardError());
        assertEq(packs.contentsOf(drained).length, 4);
        assertEq(packs.claimantOf(drained), address(actor));
    }

    function test_RevertReceiverHookCannotOpenTheNewPack() public {
        HookReceiver hook = new HookReceiver(packs);
        hook.configure(0, false);
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);

        vm.expectRevert(_guardError());
        vm.prank(alice);
        packs.createPackTo{value: cost}(noIds(), counts, address(hook));

        assertEq(packs.totalMinted(), 0, "creation rolled back");
        assertEq(packs.totalSupply(), 0);
    }

    function test_ReceiverHookSeesAFinishedPackAndEveryCallbackFails() public {
        for (uint8 mode = 0; mode <= 4; ++mode) {
            HookReceiver hook = new HookReceiver(packs);
            hook.configure(mode, true);
            uint32[] memory counts = mintsOf(0, 3);
            uint256 cost = costOf(counts);

            vm.prank(alice);
            uint256 packId = packs.createPackTo{value: cost}(noIds(), counts, address(hook));

            assertTrue(hook.called(), "hook ran");
            assertFalse(hook.ok(), "callback failed");
            assertEq(hook.ret(), _guardError(), "with the reentrancy guard");
            // By the time the hook ran the pack was already complete and owned by the hook.
            assertEq(hook.seenOwner(), address(hook));
            assertEq(hook.seenValue(), 3 * unit());
            assertEq(hook.seenCount(), 3);
            assertEq(packs.ownerOf(packId), address(hook));
            assertEq(packs.contentsOf(packId).length, 3);
            assertEq(packs.valueOf(packId), 3 * unit());
        }
    }

    /* ------------------------------ gas sanity ------------------------------ */

    function test_GasOpenHundredShapePack() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 100));
        assertEq(packs.contentsOf(packId).length, 100);

        vm.prank(alice);
        uint256 g = gasleft();
        packs.open(packId);
        uint256 used = g - gasleft();

        emit log_named_uint("gas: open of a 100-Shape pack", used);
        assertLt(used, 30_000_000, "fits in one block");
        assertEq(shapes.balanceOf(alice), 100);
    }

    function test_GasRedeemHundredShapePack() public {
        uint256 packId = _create(alice, noIds(), mintsOf(0, 100));
        uint256 value = packs.valueOf(packId);
        uint256 before = alice.balance;

        vm.prank(alice);
        uint256 g = gasleft();
        packs.redeem(packId);
        uint256 used = g - gasleft();

        emit log_named_uint("gas: redeem of a 100-Shape pack", used);
        assertLt(used, 30_000_000, "fits in one block");
        assertEq(alice.balance - before, value);
    }
}

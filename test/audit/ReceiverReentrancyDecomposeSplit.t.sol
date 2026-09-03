// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {AuditBase} from "./AuditBase.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice Required adversarial attempt 1: reenter `Shapes` from an ERC-721 receiver callback
///         raised during `decomposeTo` and `splitTo`, aiming at the owner-token pointer, the
///         reserve counters and the compose/split record stacks.
///
/// @dev The callback fires from inside `_safeMint`, which both mutators run after every storage
///      write. The attempts below are made from the recipient of those mints, which is the only
///      code the protocol hands control to during those calls.
contract ReceiverReentrancyDecomposeSplitTest is AuditBase {
    ReentrantRecipient internal attacker;

    function setUp() public override {
        super.setUp();
        attacker = new ReentrantRecipient(shapes);
        vm.deal(address(attacker), 100 ether);
    }

    /* --------------------------- decomposeTo --------------------------- */

    /// @notice Every guarded entrypoint is refused from inside the decompose mint loop, and the
    ///         owner-token pointer never names an id that does not exist while a callback runs.
    function test_DecomposeToCallbackCannotReenterOrDesyncOwnerToken() public {
        // Alice builds a 0.05 survivor out of five dust, with Shape #0 (the owner token) among
        // the inputs, so the record carries collection ownership.
        uint256 first = _mintBatchTo(alice, DENOMS[0], 4);
        vm.prank(address(this));
        shapes.transferFrom(address(this), alice, 0); // hand the owner token to alice

        uint256[] memory burn = new uint256[](4);
        burn[0] = 0;
        for (uint256 i = 0; i < 3; ++i) {
            burn[i + 1] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn); // survivor `first` is now 0.05, holds the owner token

        assertEq(shapes.ownerToken(), first, "owner token moved to the survivor");
        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();

        attacker.arm(first);
        vm.prank(alice);
        uint256[] memory restored = shapes.decomposeTo(first, address(attacker));

        assertEq(restored.length, 4, "four inputs restored");
        assertEq(attacker.callbackCount(), 4, "one callback per restored token");
        assertTrue(attacker.everyGuardedCallReverted(), "a guarded entrypoint was reachable");
        assertTrue(attacker.everyOwnerTokenObservationConsistent(), "ownerToken() named a dead id");

        // The record's owner token is restored only after every mint, so no callback saw it.
        assertEq(shapes.ownerToken(), 0, "collection ownership handed back to Shape #0");
        assertEq(shapes.owner(), shapes.ownerOf(0), "owner() disagrees with ownerOf(ownerToken())");

        assertEq(shapes.redeemableBacking(), reserveBefore, "decompose moved backing");
        assertEq(shapes.totalSupply(), supplyBefore + 4, "supply moved by anything but the revival");
        assertEq(shapes.composeDepth(first), 0, "the record was not popped exactly once");
        _assertReserveInvariant();
    }

    /* ------------------------------ splitTo ---------------------------- */

    /// @notice Same battery during `splitTo`, where the owner token moves to the first child
    ///         before any child is minted.
    function test_SplitToCallbackCannotReenterOrDesyncOwnerToken() public {
        uint256 parent = _mint(alice, DENOMS[2]); // 0.1
        // Move the owner token onto the parent by composing Shape #0 away is not possible here;
        // instead split the genesis-owning token directly.
        shapes.transferFrom(address(this), alice, 0);

        // Build a 0.05 token that holds the owner token, then split it into five dust.
        uint256 first = _mintBatchTo(alice, DENOMS[0], 4);
        uint256[] memory burn = new uint256[](4);
        burn[0] = 0;
        for (uint256 i = 0; i < 3; ++i) {
            burn[i + 1] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(shapes.ownerToken(), first, "owner token sits on the split parent");

        uint256 reserveBefore = shapes.redeemableBacking();
        uint8[] memory outs = new uint8[](5);
        for (uint256 i = 0; i < 5; ++i) {
            outs[i] = 0;
        }

        attacker.arm(parent);
        vm.prank(alice);
        uint256[] memory kids = shapes.splitTo(first, outs, address(attacker));

        assertEq(kids.length, 5, "five children");
        assertEq(attacker.callbackCount(), 5, "one callback per child");
        assertTrue(attacker.everyGuardedCallReverted(), "a guarded entrypoint was reachable");
        assertTrue(attacker.everyOwnerTokenObservationConsistent(), "ownerToken() named a dead id");

        assertEq(shapes.ownerToken(), kids[0], "owner token should sit on the first child");
        assertEq(shapes.owner(), shapes.ownerOf(kids[0]), "owner() disagrees with ownerOf");
        assertEq(shapes.redeemableBacking(), reserveBefore, "split moved backing");
        _assertReserveInvariant();
    }

    /// @notice A callback that moves an already-minted sibling cannot park it on `Shapes` itself.
    function test_CallbackCannotPushAChildIntoShapesCustody() public {
        uint256 parentId = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1; // 0.05 + 0.05 == 0.1

        attacker.armSelfCustody();
        vm.prank(alice);
        vm.expectRevert(); // the sibling transfer inside the callback bubbles up
        shapes.splitTo(parentId, outs, address(attacker));
    }

    /// @notice The callback may transfer a sibling to a third party. That is allowed, and it must
    ///         not corrupt the owner-token pointer or the reserve.
    function test_CallbackSiblingTransferIsHarmless() public {
        shapes.transferFrom(address(this), alice, 0);
        uint256 first = _mintBatchTo(alice, DENOMS[0], 4);
        uint256[] memory burn = new uint256[](4);
        burn[0] = 0;
        for (uint256 i = 0; i < 3; ++i) {
            burn[i + 1] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);

        uint8[] memory outs = new uint8[](5);
        attacker.armSiblingTransfer(bob);
        vm.prank(alice);
        uint256[] memory kids = shapes.splitTo(first, outs, address(attacker));

        assertEq(shapes.ownerToken(), kids[0], "owner token pointer moved unexpectedly");
        assertEq(shapes.owner(), shapes.ownerOf(kids[0]), "owner() disagrees with ownerOf");
        _assertReserveInvariant();
    }
}

/// @dev The receiver the two mutators hand control to. On every `onERC721Received` it records
///      whether the owner-token pointer is self-consistent and whether each guarded entrypoint
///      refused it.
contract ReentrantRecipient is IERC721Receiver {
    IShapes public immutable shapes;

    uint256 public callbackCount;
    bool public everyGuardedCallReverted = true;
    bool public everyOwnerTokenObservationConsistent = true;

    uint256 private _target;
    bool private _selfCustody;
    bool private _siblingTransfer;
    address private _siblingTo;
    uint256[] private _received;

    receive() external payable {}

    constructor(IShapes shapes_) {
        shapes = shapes_;
    }

    function arm(uint256 target) external {
        _target = target;
        _selfCustody = false;
        _siblingTransfer = false;
        callbackCount = 0;
        everyGuardedCallReverted = true;
        everyOwnerTokenObservationConsistent = true;
        delete _received;
    }

    function armSelfCustody() external {
        _selfCustody = true;
        _siblingTransfer = false;
        callbackCount = 0;
        delete _received;
    }

    function armSiblingTransfer(address to) external {
        _siblingTransfer = true;
        _selfCustody = false;
        _siblingTo = to;
        callbackCount = 0;
        delete _received;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        ++callbackCount;
        _received.push(tokenId);
        _observeOwnerToken();

        if (_selfCustody && _received.length == 2) {
            // Attempt to leave a Shape in the token contract's own custody.
            shapes.transferFrom(address(this), address(shapes), _received[0]);
        }
        if (_siblingTransfer && _received.length == 2) {
            shapes.transferFrom(address(this), _siblingTo, _received[0]);
        }
        if (!_selfCustody && !_siblingTransfer) _attemptGuardedEntrypoints(tokenId);

        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev `ownerToken()` must never name an id with no live holder while a callback runs, and
    ///      `owner()` must agree with `ownerOf(ownerToken())`.
    function _observeOwnerToken() private {
        try shapes.ownerToken() returns (uint256 tid) {
            try shapes.ownerOf(tid) returns (address holder) {
                if (holder != shapes.owner()) everyOwnerTokenObservationConsistent = false;
            } catch {
                everyOwnerTokenObservationConsistent = false;
            }
        } catch {
            if (shapes.owner() != address(0)) everyOwnerTokenObservationConsistent = false;
        }
    }

    /// @dev Every guarded entrypoint, tried against state the callback can see. Each must revert.
    function _attemptGuardedEntrypoints(uint256 tokenId) private {
        uint256[] memory one = new uint256[](1);
        one[0] = tokenId;

        _expectRevert(abi.encodeCall(IShapes.redeem, (tokenId)));
        _expectRevert(abi.encodeCall(IShapes.redeemTo, (tokenId, payable(address(this)))));
        _expectRevert(abi.encodeCall(IShapes.redeemBatch, (one)));
        _expectRevert(abi.encodeWithSignature("burn(uint256)", tokenId));
        _expectRevert(abi.encodeCall(IShapes.decompose, (_target)));
        _expectRevert(abi.encodeCall(IShapes.decomposeTo, (_target, address(this))));
        _expectRevert(abi.encodeCall(IShapes.compose, (_target, one)));
        _expectRevert(abi.encodeCall(IShapes.burnBacking, (_target)));
        _expectRevert(abi.encodeCall(IShapes.withdrawFees, ()));
        _expectRevert(abi.encodeWithSelector(IShapes.mint.selector, uint256(0.01 ether)));

        uint8[] memory outs = new uint8[](2);
        _expectRevert(abi.encodeCall(IShapes.split, (tokenId, outs)));
    }

    function _expectRevert(bytes memory data) private {
        (bool ok,) = address(shapes).call(data);
        if (ok) everyGuardedCallReverted = false;
    }
}

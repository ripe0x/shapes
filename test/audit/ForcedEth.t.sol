// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";

/// @notice Required adversarial attempt 3: force ETH into `Shapes` outside its payable
///         entrypoints and try to make any view, any accounting counter, or `withdrawFees` treat
///         it as protocol funds.
contract ForcedEthTest is AuditBase {
    /// @notice The two payable entrypoints refuse a bare transfer, which is why forcing is the
    ///         only way in.
    function test_PlainTransferAndUnknownSelectorAreRejected() public {
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        (bool ok, bytes memory err) = address(shapes).call{value: 1 ether}("");
        assertFalse(ok, "receive() accepted a bare transfer");
        assertEq(bytes4(err), IShapes.DirectDepositRejected.selector, "wrong rejection");

        vm.prank(alice);
        (ok, err) = address(shapes).call{value: 1 ether}(abi.encodeWithSignature("nope()"));
        assertFalse(ok, "fallback() accepted a bare transfer");
        assertEq(bytes4(err), IShapes.DirectDepositRejected.selector, "wrong rejection");
    }

    /// @notice `selfdestruct` credits the balance even under EIP-6780. Nothing on the token
    ///         notices, and nothing can withdraw it.
    function test_SelfdestructedEthIsCountedNowhereAndIsUnwithdrawable() public {
        uint256 id = _mint(alice, DENOMS[1]);

        uint256 balBefore = address(shapes).balance;
        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 feesBefore = shapes.pendingFees();
        uint256 burnedBefore = shapes.burnedBacking();
        uint256 supplyBefore = shapes.totalSupply();
        uint256 mintedBefore = shapes.totalMinted();

        vm.deal(address(this), 7 ether);
        new ForceEth{value: 7 ether}(payable(address(shapes)));

        assertEq(address(shapes).balance, balBefore + 7 ether, "force did not land");
        assertEq(shapes.redeemableBacking(), reserveBefore, "forced ETH entered the reserve");
        assertEq(shapes.pendingFees(), feesBefore, "forced ETH entered pendingFees");
        assertEq(shapes.burnedBacking(), burnedBefore, "forced ETH moved burnedBacking");
        assertEq(shapes.totalSupply(), supplyBefore, "forced ETH moved supply");
        assertEq(shapes.totalMinted(), mintedBefore, "forced ETH moved the counter");
        assertEq(shapes.backingOf(id), DENOMS[1], "forced ETH changed a token's backing");
        assertEq(shapes.blackShapeCount(), 0, "forced ETH moved the Black count");
        _assertReserveInvariant();

        // `withdrawFees` pays exactly the accrued fee, never the surplus.
        uint256 pending = shapes.pendingFees();
        assertGt(pending, 0, "no fee accrued to test against");
        uint256 recipientBefore = feeRecipient.balance;
        shapes.withdrawFees(feeRecipient);
        assertEq(feeRecipient.balance, recipientBefore + pending, "withdrawFees paid the surplus");
        assertEq(shapes.pendingFees(), 0, "fees not cleared");
        assertEq(address(shapes).balance, reserveBefore + 7 ether, "surplus was spent");

        // A second withdrawal has nothing to pay even though 7 ETH sits in the contract.
        vm.expectRevert(IShapes.NoFeesPending.selector);
        shapes.withdrawFees(feeRecipient);

        // Redemption still pays exactly the token's backing, not a share of the surplus.
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, aliceBefore + DENOMS[1], "redemption paid more than the backing");

        // With every token gone the surplus is still stranded.
        shapes.redeemTo(0, payable(bob));
        assertEq(shapes.redeemableBacking(), 0, "reserve not drained");
        assertEq(shapes.totalSupply(), 0, "supply not drained");
        assertEq(address(shapes).balance, 7 ether, "the forced ETH left the contract");
        _assertReserveInvariant();
    }

    /// @notice A block-reward style credit (the coinbase case) behaves the same: no entrypoint
    ///         reads `address(this).balance`, so it cannot be claimed.
    function test_CoinbaseStyleCreditIsAlsoStranded() public {
        uint256 id = _mint(alice, DENOMS[0]);
        vm.deal(address(shapes), address(shapes).balance + 3 ether);

        assertEq(shapes.redeemableBacking(), DENOMS[0] + DENOMS[0], "reserve moved");
        _assertReserveInvariant();

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, aliceBefore + DENOMS[0], "redemption paid more than the backing");
        _assertReserveInvariant();
    }

    /// @notice `burnBacking` sends exactly the apex denomination, not the surplus.
    function test_BurnBackingIgnoresTheSurplus() public {
        // Build an apex Complete Shape from 10,000 dust in one compose.
        uint256 first = _mintBatchTo(alice, DENOMS[0], 10_000);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(shapes.backingOf(first), DENOMS[8], "apex not reached");

        vm.deal(address(this), 5 ether);
        new ForceEth{value: 5 ether}(payable(address(shapes)));

        uint256 deadBefore = address(0xdEaD).balance;
        vm.prank(alice);
        shapes.burnBacking(first);

        assertEq(address(0xdEaD).balance, deadBefore + DENOMS[8], "burnBacking sent the wrong amount");
        assertEq(shapes.burnedBacking(), DENOMS[8], "burnedBacking wrong");
        assertTrue(shapes.isBlack(first), "token not marked Black");
        assertEq(shapes.backingOf(first), 0, "Black token still redeemable");
        _assertReserveInvariant();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, first));
        shapes.redeem(first);
    }
}

/// @dev Forces ETH in with `selfdestruct` from the constructor, the one form EIP-6780 leaves
///      fully intact.
contract ForceEth {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

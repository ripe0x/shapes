// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {IAdminControl} from "../../src/interfaces/IAdminControl.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {AdminOps} from "../../src/lib/AdminOps.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice Required adversarial attempt 5: attack the fee ledger across `setMintFee`,
///         `setFeeRecipient`, `withdrawFees` and batch mints, including a fee recipient that
///         reverts and one that reenters from its own `receive`.
contract FeeAccountingTest is AuditBase {
    /// @notice Fees never enter the reserve, and the reserve is never paid out as a fee.
    function test_FeesAndReserveAreDisjointAcrossEveryPath() public {
        uint256 first = _mintBatchTo(alice, DENOMS[1], 7);
        assertEq(shapes.redeemableBacking(), DENOMS[0] + 7 * DENOMS[1], "backing wrong");
        assertEq(shapes.pendingFees(), 7 * MINT_FEE, "flat fee is not per token");
        _assertReserveInvariant();

        uint256 balBefore = address(shapes).balance;
        uint256 pending = shapes.pendingFees();
        shapes.withdrawFees();
        assertEq(address(shapes).balance, balBefore - pending, "withdrawFees moved more than the fees");
        assertEq(shapes.redeemableBacking(), DENOMS[0] + 7 * DENOMS[1], "withdrawFees touched the reserve");
        _assertReserveInvariant();

        // Every token still redeems for exactly its backing after the fees have left.
        for (uint256 i = 0; i < 7; ++i) {
            uint256 before = alice.balance;
            vm.prank(alice);
            shapes.redeem(first + i);
            assertEq(alice.balance, before + DENOMS[1], "redemption short after a fee withdrawal");
        }
        assertEq(shapes.redeemableBacking(), DENOMS[0], "reserve wrong after the drain");
        _assertReserveInvariant();
    }

    /// @notice The cap is enforced on the constructor and on every later change; no admin path
    ///         raises the fee above it.
    function test_MintFeeCapCannotBeExceededByAnyPath() public {
        uint256 cap = Denominations.UNIT;
        assertEq(AdminOps.MAX_MINT_FEE, cap, "cap is not one unit");

        vm.expectRevert(abi.encodeWithSelector(IShapes.MintFeeAboveCap.selector, cap + 1));
        shapes.setMintFee(cap + 1);

        shapes.setMintFee(cap);
        assertEq(shapes.mintFee(), cap, "cap value refused");

        vm.expectRevert(abi.encodeWithSelector(IShapes.MintFeeAboveCap.selector, type(uint256).max));
        shapes.setMintFee(type(uint256).max);
        assertEq(shapes.mintFee(), cap, "a rejected change still landed");

        // A non-admin cannot move it at all.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setMintFee(0);
    }

    /// @notice A mint that underpays or overpays by the fee is rejected exactly.
    function test_BatchMintPaymentIsExact() public {
        uint256 want = 3 * (DENOMS[2] + MINT_FEE);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.IncorrectPayment.selector, want, want - 1));
        shapes.mintBatch{value: want - 1}(DENOMS[2], 3);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.IncorrectPayment.selector, want, want + 1));
        shapes.mintBatch{value: want + 1}(DENOMS[2], 3);

        vm.prank(alice);
        vm.expectRevert(IShapes.ZeroQuantity.selector);
        shapes.mintBatch{value: 0}(DENOMS[2], 0);

        vm.prank(alice);
        shapes.mintBatch{value: want}(DENOMS[2], 3);
        assertEq(shapes.pendingFees(), 3 * MINT_FEE, "fee accrual wrong");
        _assertReserveInvariant();
    }

    /// @dev Mint at whatever fee is live right now, rather than the harness constant.
    function _mintAtLiveFee(address who, uint256 amountWei, uint256 k) private {
        uint256 paid = k * (amountWei + shapes.mintFee());
        vm.prank(who);
        shapes.mintBatch{value: paid}(amountWei, k);
    }

    /// @notice A fee change applies from the change forward; already-accrued fees are untouched.
    function test_FeeChangeDoesNotRepriceAccruedFees() public {
        _mintAtLiveFee(alice, DENOMS[0], 4);
        uint256 accrued = shapes.pendingFees();
        assertEq(accrued, 4 * MINT_FEE, "accrual wrong");

        shapes.setMintFee(0);
        _mintAtLiveFee(alice, DENOMS[0], 4);
        assertEq(shapes.pendingFees(), accrued, "a zero fee changed what was already accrued");

        shapes.setMintFee(Denominations.UNIT);
        _mintAtLiveFee(alice, DENOMS[0], 2);
        assertEq(shapes.pendingFees(), accrued + 2 * Denominations.UNIT, "new fee not applied forward");
        _assertReserveInvariant();
    }

    /// @notice A reverting fee recipient blocks only `withdrawFees`. Minting, redemption and
    ///         recomposition keep working, and the admin can redirect.
    function test_RevertingRecipientBlocksOnlyItsOwnWithdrawal() public {
        Reverter r = new Reverter();
        shapes.setFeeRecipient(address(r));

        uint256 id = _mint(alice, DENOMS[1]);
        assertEq(shapes.pendingFees(), MINT_FEE, "mint did not accrue while blocked");

        vm.expectRevert(
            abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(r), MINT_FEE)
        );
        shapes.withdrawFees();
        assertEq(shapes.pendingFees(), MINT_FEE, "a failed withdrawal consumed the ledger");

        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, before + DENOMS[1], "redemption blocked by the fee recipient");

        shapes.setFeeRecipient(bob);
        uint256 bobBefore = bob.balance;
        shapes.withdrawFees();
        assertEq(bob.balance, bobBefore + MINT_FEE, "redirect did not pay");
        assertEq(shapes.pendingFees(), 0, "ledger not cleared");
        _assertReserveInvariant();
    }

    /// @notice A recipient that changes `feeRecipient` from its own `receive` cannot redirect the
    ///         withdrawal in flight, and cannot draw the fee twice.
    function test_RecipientCannotRedirectOrDoubleDrawFromItsCallback() public {
        Reentrant r = new Reentrant(shapes);
        shapes.setFeeRecipient(address(r));
        shapes.transferAdmin(address(r)); // the recipient is also the admin: worst case

        _mintBatchTo(alice, DENOMS[0], 5);
        uint256 pending = shapes.pendingFees();

        shapes.withdrawFees();

        assertEq(address(r).balance, pending, "the recipient was not paid exactly once");
        assertEq(shapes.pendingFees(), 0, "ledger not cleared");
        assertTrue(r.reentrantWithdrawReverted(), "a second withdrawal succeeded from the callback");
        assertEq(shapes.feeRecipient(), address(r), "the in-flight recipient was redirected");
        _assertReserveInvariant();
    }

    /// @notice `setFeeRecipient` redirects the whole pending balance, including fees accrued while
    ///         a different recipient was configured. `IAdminControl.setFeeRecipient` documents the
    ///         opposite ("Already-accrued fees and the reserve are unaffected"), and
    ///         `IAdminControl`'s contract-level note says the admin "cannot reach ... accrued
    ///         fees". This is the exploit: the admin takes the standing recipient's balance.
    function test_AdminCanRedirectAlreadyAccruedFeesDespiteTheDocumentedPromise() public {
        // Fees accrue while `feeRecipient` is the configured recipient.
        _mintBatchTo(alice, DENOMS[0], 5);
        uint256 accrued = shapes.pendingFees();
        assertEq(accrued, 5 * MINT_FEE, "accrual wrong");
        assertEq(shapes.feeRecipient(), feeRecipient, "recipient wrong");

        uint256 originalBefore = feeRecipient.balance;
        uint256 attackerBefore = bob.balance;

        // The admin points the recipient somewhere else and takes the accrued balance.
        shapes.setFeeRecipient(bob);
        shapes.withdrawFees();

        assertEq(bob.balance, attackerBefore + accrued, "the accrued balance did not follow the change");
        assertEq(feeRecipient.balance, originalBefore, "the original recipient received anything");
        assertEq(shapes.pendingFees(), 0, "ledger not cleared");

        // The reserve is untouched, which is the part the documentation gets right.
        assertEq(shapes.redeemableBacking(), DENOMS[0] + 5 * DENOMS[0], "the reserve was reached");
        _assertReserveInvariant();
    }

    /// @notice After `renounceAdmin` the fee configuration is frozen: the standing recipient is
    ///         permanent and `withdrawFees` stays permissionless.
    function test_RenouncedAdminFreezesTheFeeConfiguration() public {
        Reverter r = new Reverter();
        shapes.setFeeRecipient(address(r));
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0), "admin not renounced");

        _mintBatchTo(alice, DENOMS[0], 2);
        assertGt(shapes.pendingFees(), 0, "no fee accrued");

        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this)));
        shapes.setFeeRecipient(bob);

        // The fees are now permanently unclaimable, because the recipient refuses them.
        vm.expectRevert();
        shapes.withdrawFees();

        // Backing is unaffected; every token still redeems.
        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(1);
        assertEq(alice.balance, before + DENOMS[0], "redemption blocked");
        _assertReserveInvariant();
    }

    /// @notice `setFeeRecipient(0)` is refused, so a withdrawal can never burn the fees.
    function test_ZeroRecipientRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminInvalidFeeRecipient.selector, address(0))
        );
        shapes.setFeeRecipient(address(0));
    }

    /// @notice `withdrawFees` is permissionless, which lets anyone push accrued fees to the
    ///         standing recipient but never to themselves.
    function test_WithdrawFeesIsPermissionlessButNotSelfDirected() public {
        _mintBatchTo(alice, DENOMS[0], 3);
        uint256 pending = shapes.pendingFees();
        uint256 recipientBefore = feeRecipient.balance;
        uint256 bobBefore = bob.balance;

        vm.prank(bob);
        shapes.withdrawFees();

        assertEq(feeRecipient.balance, recipientBefore + pending, "recipient not paid");
        assertEq(bob.balance, bobBefore, "the caller was paid");
        _assertReserveInvariant();
    }
}

contract Reverter {
    receive() external payable {
        revert("no");
    }
}

/// @dev A fee recipient that is also the admin. From its payout callback it tries to withdraw
///      again and to redirect the recipient mid-flight.
contract Reentrant {
    IShapes public immutable shapes;
    bool public reentrantWithdrawReverted;
    bool private _entered;

    constructor(IShapes shapes_) {
        shapes = shapes_;
    }

    receive() external payable {
        if (_entered) return;
        _entered = true;

        (bool ok,) = address(shapes).call(abi.encodeCall(IShapes.withdrawFees, ()));
        reentrantWithdrawReverted = !ok;

        // Redirecting here must not affect the transfer already under way.
        (ok,) = address(shapes).call(abi.encodeCall(IAdminControl.setFeeRecipient, (address(0xBEEF))));
        if (ok) {
            (ok,) =
                address(shapes).call(abi.encodeCall(IAdminControl.setFeeRecipient, (address(this))));
        }
    }
}

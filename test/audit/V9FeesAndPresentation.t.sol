// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {IAdminControl} from "../../src/interfaces/IAdminControl.sol";
import {IShapeCollection} from "../../src/interfaces/IShapeCollection.sol";
import {IShapeGeometry} from "../../src/interfaces/IShapeGeometry.sol";
import {IShapeRenderer} from "../../src/interfaces/IShapeRenderer.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Shapes} from "../../src/Shapes.sol";
import {ShapeCollection} from "../../src/ShapeCollection.sol";
import {SplitProvenance} from "../../src/interfaces/IShapeRenderer.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice v9 attempts 5 (fee accounting, now per recipient), 8 (presentation lock ordering) and
///         10 (a renderer or collection that answers ERC-165 for everything and then misbehaves,
///         installed and locked).
contract V9FeesAndPresentationTest is AuditBase {
    /* ------------------------------------------------------------------ */
    /*  attempt 5: per-recipient fee accounting                            */
    /* ------------------------------------------------------------------ */

    /// @notice The sum of `feesOwedTo` over every recipient a fee ever accrued to equals
    ///         `pendingFees()`, across mints, recipient changes and withdrawals.
    function test_Attempt5_PerRecipientFeesSumToPendingFees() public {
        address r1 = feeRecipient;
        address r2 = makeAddr("r2");
        address r3 = makeAddr("r3");

        _mintBatchTo(alice, DENOMS[0], 3);
        assertEq(shapes.feesOwedTo(r1), 3 * MINT_FEE);
        _assertFeeSum(r1, r2, r3);

        shapes.setFeeRecipient(r2);
        // `setFeeRecipient` moves no balance.
        assertEq(shapes.feesOwedTo(r1), 3 * MINT_FEE, "setFeeRecipient moved a credited balance");
        assertEq(shapes.feesOwedTo(r2), 0);
        _assertFeeSum(r1, r2, r3);

        _mintBatchTo(bob, DENOMS[0], 2);
        assertEq(shapes.feesOwedTo(r2), 2 * MINT_FEE);
        _assertFeeSum(r1, r2, r3);

        shapes.setFeeRecipient(r3);
        _mint(alice, DENOMS[0]);
        _assertFeeSum(r1, r2, r3);

        // Anyone may push a recipient its own balance, and only its own.
        uint256 before = r1.balance;
        vm.prank(bob);
        shapes.withdrawFees(r1);
        assertEq(r1.balance - before, 3 * MINT_FEE);
        assertEq(shapes.feesOwedTo(r1), 0);
        _assertFeeSum(r1, r2, r3);

        vm.expectRevert(IShapes.NoFeesPending.selector);
        shapes.withdrawFees(r1);

        shapes.withdrawFees(r2);
        shapes.withdrawFees(r3);
        assertEq(shapes.pendingFees(), 0);
        assertEq(address(shapes).balance, shapes.redeemableBacking(), "fees left the reserve alone");
        _assertReserveInvariant();
    }

    function _assertFeeSum(address a, address b, address c) internal view {
        assertEq(
            shapes.feesOwedTo(a) + shapes.feesOwedTo(b) + shapes.feesOwedTo(c),
            shapes.pendingFees(),
            "per-recipient balances do not sum to pendingFees()"
        );
    }

    /// @notice A recipient that reverts on receipt blocks only its own withdrawal.
    function test_Attempt5_ARevertingRecipientBlocksOnlyItself() public {
        RevertingRecipient bad = new RevertingRecipient();
        shapes.setFeeRecipient(address(bad));
        _mintBatchTo(alice, DENOMS[0], 2);

        address good = makeAddr("good");
        shapes.setFeeRecipient(good);
        _mint(alice, DENOMS[0]);

        vm.expectRevert(
            abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(bad), 2 * MINT_FEE)
        );
        shapes.withdrawFees(address(bad));

        uint256 before = good.balance;
        shapes.withdrawFees(good);
        assertEq(good.balance - before, MINT_FEE, "a reverting recipient blocked a healthy one");
        assertEq(shapes.feesOwedTo(address(bad)), 2 * MINT_FEE, "the stuck balance is still owed");
        _assertReserveInvariant();
    }

    /// @notice Per-recipient accrual makes a stuck balance permanent: no admin path re-routes it,
    ///         because `setFeeRecipient` deliberately moves nothing. Pointing the recipient back at
    ///         the reverting contract does not help either, since accrual is keyed by address.
    function test_Finding_ARevertingRecipientsBalanceIsPermanentlyStranded() public {
        RevertingRecipient bad = new RevertingRecipient();
        shapes.setFeeRecipient(address(bad));
        _mintBatchTo(alice, DENOMS[0], 2);
        uint256 stuck = shapes.feesOwedTo(address(bad));
        assertEq(stuck, 2 * MINT_FEE);

        address rescue = makeAddr("rescue");
        shapes.setFeeRecipient(rescue);
        assertEq(shapes.feesOwedTo(rescue), 0, "the balance did not follow the recipient change");
        assertEq(shapes.feesOwedTo(address(bad)), stuck);

        // Back again: still keyed by address, still unsendable.
        shapes.setFeeRecipient(address(bad));
        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(bad), stuck));
        shapes.withdrawFees(address(bad));

        // The ETH stays inside the contract forever, counted by pendingFees().
        assertEq(shapes.pendingFees(), stuck);
        assertEq(
            address(shapes).balance,
            shapes.redeemableBacking() + stuck,
            "the stranded fees sit on top of the reserve"
        );
        _assertReserveInvariant();
    }

    /// @notice `split` issues ids without new backing and without a mint fee, and the cycle
    ///         repeats, so `totalMinted` is bounded by gas rather than by deposited ETH. The
    ///         `uint96` id casts in `ComposeInput.id` and `ComposeRecord.ownerTokenFrom` therefore
    ///         rest on a gas bound, not on the per-mint ETH bound their comment states.
    function test_Finding_SplitIssuesIdsWithoutNewBacking() public {
        uint256 id = _mint(alice, DENOMS[1]);
        uint256 backing = shapes.redeemableBacking();
        uint256 fees = shapes.pendingFees();

        for (uint256 round = 0; round < 3; ++round) {
            uint256 mintedBefore = shapes.totalMinted();
            uint8[] memory outs = new uint8[](5);
            vm.prank(alice);
            uint256[] memory kids = shapes.split(id, outs);
            assertEq(shapes.totalMinted(), mintedBefore + 5, "split issued five fresh ids");
            assertEq(shapes.redeemableBacking(), backing, "split took no new backing");
            assertEq(shapes.pendingFees(), fees, "split charged no mint fee");

            uint256[] memory burnIds = new uint256[](4);
            for (uint256 i = 0; i < 4; ++i) {
                burnIds[i] = kids[i + 1];
            }
            vm.prank(alice);
            shapes.compose(kids[0], burnIds);
            id = kids[0];
        }
        assertEq(shapes.redeemableBacking(), backing);
        _assertReserveInvariant();
    }

    /// @notice `setFeeRecipient` rejects the zero address and the token's own address.
    function test_Attempt5_SetFeeRecipientRejectsZeroAndSelf() public {
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminInvalidFeeRecipient.selector, address(0)));
        shapes.setFeeRecipient(address(0));

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminInvalidFeeRecipient.selector, address(shapes))
        );
        shapes.setFeeRecipient(address(shapes));
    }

    /// @notice The constructor rejects a zero fee recipient but NOT the token's own address, which
    ///         `setFeeRecipient` refuses. A deployer that predicts the CREATE address and passes it
    ///         accrues fees to a balance `withdrawFees` can never pay out, because `receive()`
    ///         reverts. The reserve invariant still holds; the fees are simply stranded.
    function test_Finding_ConstructorAcceptsTheTokenItselfAsFeeRecipient() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        Shapes self = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, predicted, address(renderer), 0);
        assertEq(address(self), predicted, "CREATE address prediction");
        assertEq(self.feeRecipient(), address(self), "the constructor accepted address(this)");

        vm.prank(alice);
        self.mint{value: DENOMS[0] + MINT_FEE}(DENOMS[0]);
        assertEq(self.feesOwedTo(address(self)), MINT_FEE);

        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(self), MINT_FEE));
        self.withdrawFees(address(self));

        assertGe(
            address(self).balance, self.redeemableBacking() + self.pendingFees(), "reserve invariant broke"
        );
    }

    /// @notice The mint fee cap holds on every admin path and in the constructor.
    function test_Attempt5_MintFeeCap() public {
        uint256 cap = Denominations.UNIT;
        shapes.setMintFee(cap);
        assertEq(shapes.mintFee(), cap);

        vm.expectRevert(abi.encodeWithSelector(IShapes.MintFeeAboveCap.selector, cap + 1));
        shapes.setMintFee(cap + 1);

        vm.expectRevert(abi.encodeWithSelector(IShapes.MintFeeAboveCap.selector, cap + 1));
        new Shapes{value: Denominations.amountAt(0)}(cap + 1, feeRecipient, address(renderer), 0);
    }

    /* ------------------------------------------------------------------ */
    /*  attempt 8: presentation lock ordering                              */
    /* ------------------------------------------------------------------ */

    function test_Attempt8_LockOrdering() public {
        // A collection not bound to this token is refused.
        ShapeCollection foreign;
        {
            Shapes other =
                new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(renderer), 0);
            foreign = new ShapeCollection(renderer, other);
        }
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(foreign)));
        shapes.setCollection(address(foreign));

        // A new bound collection may replace the current one before the lock.
        ShapeCollection replacement = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(replacement));
        assertEq(shapes.collection(), address(replacement));

        shapes.lockPresentation();

        // Everything the lock covers is now permanent, on both contracts.
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setCollection(address(collection));
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setRenderer(address(renderer));
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.lockPresentation();
        vm.expectRevert(IShapeCollection.PresentationIsLocked.selector);
        replacement.setMetadataCopy("x ", "y", "z");
        // The collection that is no longer installed reads the same live lock.
        vm.expectRevert(IShapeCollection.PresentationIsLocked.selector);
        collection.setMetadataCopy("x ", "y", "z");
    }

    /// @notice `lockPresentation` requires a collection, so the lock cannot strand `tokenURI`.
    function test_Attempt8_LockRequiresACollection() public {
        Shapes fresh =
            new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(renderer), 0);
        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.lockPresentation();
    }

    /* ------------------------------------------------------------------ */
    /*  attempt 10: an ERC-165 liar, installed and then locked             */
    /* ------------------------------------------------------------------ */

    /// @notice A renderer that answers ERC-165 for every interface and then reverts on the calls
    ///         `tokenURI` makes installs, and `lockPresentation` then freezes it. The token's
    ///         metadata is permanently unreadable. Backing, redemption and ownership are not
    ///         touched, which is what bounds the severity.
    function test_Attempt10_HostileRendererCanBeInstalledAndLocked() public {
        uint256 id = _mint(alice, DENOMS[0]);
        shapes.tokenURI(id); // works before

        HostileRenderer bad = new HostileRenderer();
        shapes.setRenderer(address(bad)); // ERC-165 answers true for everything
        assertEq(shapes.renderer(), address(bad));

        shapes.lockPresentation();
        assertTrue(shapes.presentationLocked(), "presentation is locked over a hostile renderer");

        vm.expectRevert(bytes("hostile"));
        shapes.tokenURI(id);
        vm.expectRevert(bytes("hostile"));
        shapes.svg(id);
        vm.expectRevert(bytes("hostile"));
        shapes.geometryOf(id);

        // Unfixable: the lock is one way.
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setRenderer(address(renderer));

        // Redemption still works, which is the property that actually matters.
        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance - before, DENOMS[0], "redemption survived the hostile renderer");
        _assertReserveInvariant();
    }

    /// @notice A collection that answers ERC-165 and reports the right `shapes()` installs, and
    ///         `lockPresentation` freezes the POINTER but not that contract's own copy: the lock
    ///         only freezes copy for a collection that reads `presentationLocked()` back and
    ///         honours it. `ShapeCollection` does; an arbitrary installed collection need not.
    function test_Attempt10_LockDoesNotFreezeCopyInsideAForeignCollection() public {
        uint256 id = _mint(alice, DENOMS[0]);

        MutableCollection mutableCollection = new MutableCollection(address(shapes));
        shapes.setCollection(address(mutableCollection));
        shapes.lockPresentation();
        assertTrue(shapes.presentationLocked());

        string memory beforeCopy = shapes.tokenURI(id);
        mutableCollection.setDescription("rewritten after the lock");
        string memory afterCopy = shapes.tokenURI(id);
        assertTrue(
            keccak256(bytes(beforeCopy)) != keccak256(bytes(afterCopy)),
            "the metadata copy did not change, so the lock held"
        );
    }

    /// @notice `setCollection` refuses a target that answers ERC-165 but names a different token.
    function test_Attempt10_CollectionMustNameThisToken() public {
        MutableCollection wrong = new MutableCollection(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(wrong)));
        shapes.setCollection(address(wrong));
    }
}

contract RevertingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// @notice Answers ERC-165 true for every interface id and reverts on every real call.
contract HostileRenderer {
    fallback() external {
        revert("hostile");
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @notice A collection bound to a `Shapes` that ignores `presentationLocked()` for its own copy.
contract MutableCollection {
    address public immutable shapes;
    string private _description = "initial";

    constructor(address shapes_) {
        shapes = shapes_;
    }

    function setDescription(string calldata d) external {
        _description = d;
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function tokenNamePrefix() external pure returns (string memory) {
        return "Shape ";
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function ownerTokenDescription() external view returns (string memory) {
        return _description;
    }

    function contractURI() external pure returns (string memory) {
        return "x";
    }
}

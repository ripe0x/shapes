// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {IAdminControl} from "../src/interfaces/IAdminControl.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {ShapeFormation, ShapeState} from "../src/interfaces/IShapeCapabilities.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {InkGenes} from "../src/lib/InkGenes.sol";

import {
    BadReceiver,
    EthRejectingReceiver,
    GoodReceiver,
    ReentrantFeeRecipient,
    ReentrantMinter,
    ReentrantRedeemer,
    RevertingFeeRecipient,
    MockPositionResolver,
    HostileGasResolver,
    ShortReturnResolver,
    DirtyAddressResolver
} from "./mocks/Mocks.sol";

abstract contract ShapesBase is Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    function feeOf(uint256) internal pure returns (uint256) {
        return MINT_FEE;
    }

    ShapeRenderer internal renderer;

    ShapeCollection internal collection;
    Shapes internal shapes;
    ShapeLens internal lens;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

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

    function _keepGenesisShape() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public virtual {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection), 0
        );
        // Most legacy subsystem tests need an otherwise-empty collection. ContractOwnership.t.sol
        // exercises the live genesis token itself; burn it here while preserving issued id 0.
        if (!_keepGenesisShape()) shapes.redeemTo(0, payable(address(0xD15CA4D)));
        lens = new ShapeLens(address(shapes));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _mint(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = shapes.mint{value: amount + feeOf(amount)}(amount);
    }

    /// @dev The reserve invariant, asserted after anything interesting happens.
    function _assertSolvent() internal view {
        assertGe(
            address(shapes).balance,
            shapes.redeemableBacking(),
            "contract balance fell below redeemableBacking"
        );
    }

    function _positionsAddress() internal view returns (address target) {
        (target,) = shapes.positions();
    }

    function _positionsIsLocked() internal view returns (bool locked) {
        (, locked) = shapes.positions();
    }

    function _marketAddress() internal view returns (address target) {
        (target,) = shapes.market();
    }

    function _marketIsLocked() internal view returns (bool locked) {
        (, locked) = shapes.market();
    }
}

/* ==================================================================== *
 *  Minting
 * ==================================================================== */

contract MintTest is ShapesBase {
    function test_AllNineDenominationsMint() public {
        uint256 expectedBacking;
        for (uint256 i = 0; i < 9; ++i) {
            uint256 id = _mint(alice, DENOMS[i]);
            expectedBacking += DENOMS[i];

            assertEq(id, i + 1, "permissionless token ids are sequential from 1");
            assertEq(shapes.ownerOf(id), alice);
            assertEq(shapes.backingOf(id), DENOMS[i]);
            assertTrue(lens.exists(id), "freshly minted Shape exists");
            assertEq(shapes.denomIndexOf(id), i, "stored denomination index");
            assertEq(shapes.redeemableBacking(), expectedBacking);
            assertEq(shapes.totalSupply(), i + 1);
            assertEq(shapes.totalMinted(), i + 2);
        }
        assertEq(
            address(shapes).balance,
            expectedBacking + shapes.pendingFees(),
            "balance equals backing plus pending fees exactly"
        );
        _assertSolvent();
    }

    function test_PermissionlessTokenIdsStartAtOne() public {
        assertEq(shapes.totalMinted(), 1);
        assertEq(_mint(alice, DENOMS[4]), 1, "the first permissionless Shape is #1");
        assertEq(shapes.totalMinted(), 2, "totalMinted counts genesis plus public ids");
        assertEq(_mint(alice, DENOMS[4]), 2);
    }

    function test_MintToAnotherAddress() public {
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], bob);
        assertEq(shapes.ownerOf(id), bob);
    }

    function test_RevertsOnUnsupportedDenomination() public {
        uint256[6] memory bad = [
            uint256(1),
            DENOMS[0] + DENOMS[0] / 10,
            DENOMS[8] / 4,
            DENOMS[4] * 2,
            DENOMS[8] - DENOMS[4],
            DENOMS[8] + DENOMS[4]
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, bad[i]));
            shapes.mintTo{value: bad[i] + feeOf(bad[i])}(bad[i], alice);
        }
    }

    function test_RevertsOnZeroBacking() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, 0));
        shapes.mintTo{value: 0}(0, alice);
    }

    function testFuzz_OnlyLadderAmountsAreAccepted(uint256 amount) public {
        amount = bound(amount, 0, 200 ether);
        bool supported = lens.isSupportedDenomination(amount);

        vm.deal(alice, amount + feeOf(amount));
        vm.prank(alice);
        if (supported) {
            shapes.mintTo{value: amount + feeOf(amount)}(amount, alice);
            assertEq(shapes.redeemableBacking(), amount);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, amount));
            shapes.mintTo{value: amount + feeOf(amount)}(amount, alice);
            assertEq(shapes.redeemableBacking(), 0);
        }
        _assertSolvent();
    }

    function test_RequiresExactBackingPlusFee() public {
        vm.startPrank(alice);

        vm.expectRevert(
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, DENOMS[4] + feeOf(DENOMS[4]), DENOMS[4])
        );
        shapes.mintTo{value: DENOMS[4]}(DENOMS[4], alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector,
                DENOMS[4] + feeOf(DENOMS[4]),
                DENOMS[4] + feeOf(DENOMS[4]) - 1
            )
        );
        shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4]) - 1}(DENOMS[4], alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector,
                DENOMS[4] + feeOf(DENOMS[4]),
                DENOMS[4] + feeOf(DENOMS[4]) + 1
            )
        );
        shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4]) + 1}(DENOMS[4], alice);

        vm.stopPrank();
        assertEq(shapes.redeemableBacking(), 0);
    }

    function testFuzz_AnyIncorrectValueReverts(uint256 sent) public {
        uint256 required = DENOMS[4] + feeOf(DENOMS[4]);
        vm.assume(sent != required);
        sent = bound(sent, 0, 500 ether);
        vm.assume(sent != required);

        vm.deal(alice, sent);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.IncorrectPayment.selector, required, sent));
        shapes.mintTo{value: sent}(DENOMS[4], alice);
    }

    function test_BatchRequiresExactAggregate() public {
        uint256 qty = 10;
        uint256 required = qty * (DENOMS[4] + feeOf(DENOMS[4]));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.IncorrectPayment.selector, required, required - 1));
        shapes.mintBatchTo{value: required - 1}(DENOMS[4], qty, alice);

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: required}(DENOMS[4], qty);

        assertEq(first, 1);
        assertEq(shapes.totalMinted(), qty + 1);
        assertEq(shapes.totalSupply(), qty);
        assertEq(shapes.redeemableBacking(), qty * DENOMS[4], "fees are not part of backing");
        assertEq(address(shapes).balance, qty * DENOMS[4] + qty * feeOf(DENOMS[4]));
        assertEq(shapes.pendingFees(), qty * feeOf(DENOMS[4]), "aggregate fee accrued once");
    }

    function test_BatchGivesUniqueIdsAndSeeds() public {
        uint256 qty = 25;
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: qty * (DENOMS[2] + feeOf(DENOMS[2]))}(DENOMS[2], qty);

        bytes32[] memory seen = new bytes32[](qty);
        for (uint256 i = 0; i < qty; ++i) {
            uint256 id = first + i;
            assertEq(shapes.ownerOf(id), alice);
            assertEq(shapes.backingOf(id), DENOMS[2]);

            bytes32 seed = shapes.seedOf(id);
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(seed != seen[j], "duplicate seed within a batch");
            }
            seen[i] = seed;
        }
    }

    function test_RevertsOnZeroQuantity() public {
        vm.prank(alice);
        vm.expectRevert(IShapes.ZeroQuantity.selector);
        shapes.mintBatchTo{value: 0}(DENOMS[4], 0, alice);
    }

    function test_MintToContractReceiver() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(r));
        assertEq(shapes.ownerOf(id), address(r));
    }

    function test_MintToNonReceiverReverts() public {
        BadReceiver r = new BadReceiver();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(r)));
        shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(r));
        assertEq(shapes.redeemableBacking(), 0, "failed mint leaves no accounting behind");
    }

    function test_MintToZeroAddressReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0)));
        shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(0));
    }
}

/* ==================================================================== *
 *  Fees
 * ==================================================================== */

contract FeeTest is ShapesBase {
    function test_FeesReachRecipientAndNeverJoinBacking() public {
        _mint(alice, DENOMS[8]);
        assertEq(shapes.pendingFees(), MINT_FEE, "one flat fee accrued for one Shape");
        assertEq(feeRecipient.balance, 0, "nothing forwarded until withdrawFees is called");
        assertEq(shapes.redeemableBacking(), DENOMS[8]);
        assertEq(address(shapes).balance, DENOMS[8] + MINT_FEE);

        _mint(alice, DENOMS[0]);
        assertEq(shapes.pendingFees(), 2 * MINT_FEE, "two Shapes accrue two flat fees");
        assertEq(feeRecipient.balance, 0);
        assertEq(shapes.redeemableBacking(), DENOMS[8] + DENOMS[0]);
        assertEq(address(shapes).balance, DENOMS[8] + DENOMS[0] + 2 * MINT_FEE);

        shapes.withdrawFees();
        assertEq(feeRecipient.balance, 2 * MINT_FEE, "the recipient received exactly the accrued amount");
        assertEq(shapes.pendingFees(), 0, "nothing left pending");
        assertEq(address(shapes).balance, DENOMS[8] + DENOMS[0], "only backing remains");
    }

    function test_FeeIsFlatAtEveryDenomination() public {
        for (uint256 i = 0; i < 9; ++i) {
            uint256 before = shapes.pendingFees();
            _mint(alice, DENOMS[i]);
            assertEq(shapes.pendingFees() - before, MINT_FEE, "every Shape accrues the same flat fee");
        }
    }

    function test_ZeroFeeIsSupported() public {
        Shapes free = new Shapes{value: Denominations.amountAt(0)}(
            0, feeRecipient, address(renderer), address(collection), 0
        );
        vm.prank(alice);
        uint256 id = free.mintTo{value: DENOMS[4]}(DENOMS[4], alice);
        assertEq(free.backingOf(id), DENOMS[4]);
        assertEq(free.pendingFees(), 0);
        assertEq(feeRecipient.balance, 0);
    }

    /// @notice A reverting fee recipient makes no difference to minting: the mint path never
    ///         calls it. Only `withdrawFees` can reach it, and only that call reverts.
    function test_RevertingFeeRecipientBlocksWithdrawalButNotMintingOrRedemption() public {
        RevertingFeeRecipient bad = new RevertingFeeRecipient();
        Shapes s = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(bad), address(renderer), address(collection), 0
        );

        vm.prank(alice);
        uint256 id = s.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], alice);
        assertEq(s.ownerOf(id), alice, "minting to a reverting fee recipient still succeeds");
        assertEq(s.pendingFees(), MINT_FEE, "the fee accrued regardless");

        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(bad), MINT_FEE));
        s.withdrawFees();
        assertEq(s.pendingFees(), MINT_FEE, "the failed withdrawal left the fee pending, not lost");

        // Redemption is unaffected by the fee recipient's behavior.
        uint256 before = alice.balance;
        vm.prank(alice);
        s.redeem(id);
        assertEq(alice.balance - before, DENOMS[4]);

        // The admin recovers by redirecting the recipient; the pending fee then withdraws cleanly.
        uint256 bobBefore = bob.balance;
        s.setFeeRecipient(bob);
        s.withdrawFees();
        assertEq(
            bob.balance - bobBefore, MINT_FEE, "the redirected recipient received the previously stuck fee"
        );
        assertEq(s.pendingFees(), 0);
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminInvalidFeeRecipient.selector, address(0)));
        new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(0), address(renderer), address(collection), 0
        );

        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(0)));
        new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(0), address(collection), 0
        );
    }

    function test_ConstructorRejectsFeeAboveCap() public {
        uint256 cap = shapes.unit();
        vm.expectRevert(abi.encodeWithSelector(IShapes.MintFeeAboveCap.selector, cap + 1));
        new Shapes{value: Denominations.amountAt(0)}(
            cap + 1, feeRecipient, address(renderer), address(collection), 0
        );
    }

    function test_ConstructorStoresAndChargesTheFlatFee() public {
        uint256 customFee = Denominations.UNIT / 2;
        Shapes custom = new Shapes{value: Denominations.amountAt(0)}(
            customFee, feeRecipient, address(renderer), address(collection), 0
        );
        assertEq(custom.mintFee(), customFee);

        vm.prank(alice);
        custom.mint{value: DENOMS[4] + customFee}(DENOMS[4]);
        assertEq(custom.redeemableBacking(), DENOMS[0] + DENOMS[4], "fee stayed outside backing");
        assertEq(custom.pendingFees(), customFee, "the flat fee accrued");
    }

    function test_FeeConfigurationIsExposed() public view {
        assertEq(shapes.mintFee(), MINT_FEE);
        assertEq(shapes.feeRecipient(), feeRecipient);
        assertEq(shapes.renderer(), address(renderer));
        assertEq(shapes.unit(), Denominations.UNIT);
        assertEq(shapes.pendingFees(), 0);
    }

    function test_AdminCanChangeTheFeeWithinTheCap() public {
        uint256 cap = shapes.unit();
        uint256 raised = cap;
        uint256 lowered = cap / 4;

        vm.expectEmit(false, false, false, true, address(shapes));
        emit IAdminControl.MintFeeUpdated(MINT_FEE, raised);
        shapes.setMintFee(raised);
        assertEq(shapes.mintFee(), raised);
        vm.prank(alice);
        shapes.mint{value: DENOMS[2] + raised}(DENOMS[2]);
        assertEq(shapes.pendingFees(), raised, "the raised fee applied to the next mint");

        shapes.setMintFee(lowered);
        assertEq(shapes.mintFee(), lowered);
        vm.prank(alice);
        shapes.mint{value: DENOMS[2] + lowered}(DENOMS[2]);
        assertEq(shapes.pendingFees(), raised + lowered, "the lowered fee applied to the next mint");

        shapes.setMintFee(0);
        assertEq(shapes.mintFee(), 0);
        uint256 pendingBefore = shapes.pendingFees();
        vm.prank(alice);
        shapes.mint{value: DENOMS[2]}(DENOMS[2]);
        assertEq(shapes.pendingFees(), pendingBefore, "a zero fee accrues nothing further");

        // The auction house reads `mintFee()` live for its ETH-bid card minting cost.
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));
        assertEq(house.mintCostFor(DENOMS[2]), DENOMS[2], "mintCostFor follows the current zero fee");
        shapes.setMintFee(lowered);
        assertEq(
            house.mintCostFor(DENOMS[2]),
            DENOMS[2] + lowered * house.cardsFor(DENOMS[2])[2],
            "mintCostFor follows the fee once changed again"
        );
    }

    function test_SetMintFeeRejectsAboveCap() public {
        uint256 cap = shapes.unit();
        vm.expectRevert(abi.encodeWithSelector(IShapes.MintFeeAboveCap.selector, cap + 1));
        shapes.setMintFee(cap + 1);
        assertEq(shapes.mintFee(), MINT_FEE, "the fee did not change");
    }

    function test_SetMintFeeIsAdminOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setMintFee(0);
    }

    function test_WithdrawFeesWithNothingPendingReverts() public {
        vm.expectRevert(IShapes.NoFeesPending.selector);
        shapes.withdrawFees();
    }

    function test_AnyoneCanTriggerWithdrawFeesToTheRecipient() public {
        _mint(alice, DENOMS[4]);
        assertEq(shapes.pendingFees(), MINT_FEE);

        vm.prank(bob);
        shapes.withdrawFees();
        assertEq(feeRecipient.balance, MINT_FEE, "the recipient received it regardless of the caller");
        assertEq(shapes.pendingFees(), 0);
    }

    function test_WithdrawFeesPaysTheRecipientCurrentAtWithdrawTime() public {
        uint256 bobBefore = bob.balance;
        _mint(alice, DENOMS[4]);
        shapes.setFeeRecipient(bob);
        assertEq(feeRecipient.balance, 0, "the old recipient never receives a fee accrued before redirect");

        shapes.withdrawFees();
        assertEq(bob.balance - bobBefore, MINT_FEE, "the new recipient received the withdrawal");
        assertEq(feeRecipient.balance, 0);
    }

    function test_PendingFeesNeverCountAsBacking() public {
        uint256 a = _mint(alice, DENOMS[4]);
        uint256 b = _mint(alice, DENOMS[2]);
        uint256 pending = shapes.pendingFees();
        assertGt(pending, 0);

        vm.startPrank(alice);
        shapes.redeem(a);
        shapes.redeem(b);
        vm.stopPrank();

        assertEq(shapes.redeemableBacking(), 0, "every Shape redeemed in full");
        assertEq(shapes.pendingFees(), pending, "the fee is untouched by redemption");
        assertEq(address(shapes).balance, pending, "only the pending fee remains");
    }
}

/* ==================================================================== *
 *  Transfer and redemption
 * ==================================================================== */

contract RedeemTest is ShapesBase {
    function test_OwnerRedeemsExactBacking() public {
        uint256 id = _mint(alice, DENOMS[5]);
        uint256 before = alice.balance;

        vm.prank(alice);
        shapes.redeem(id);

        assertEq(alice.balance - before, DENOMS[5], "exactly the wrapped amount, no fee taken");
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        assertEq(shapes.totalMinted(), 2, "genesis plus the redeemed public id remain issued");
        assertEq(address(shapes).balance, shapes.pendingFees());
    }

    function test_RedeemedTokenNoLongerExists() public {
        uint256 id = _mint(alice, DENOMS[4]);
        vm.prank(alice);
        shapes.redeem(id);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.ownerOf(id);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.backingOf(id);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.seedOf(id);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.tokenURI(id);
    }

    function test_TransfersPreserveRedemptionRights() public {
        uint256 id = _mint(alice, DENOMS[6]);

        vm.prank(alice);
        shapes.transferFrom(alice, bob, id);
        assertEq(shapes.ownerOf(id), bob);
        assertEq(shapes.backingOf(id), DENOMS[6], "backing follows the token");

        // the previous owner has lost the right
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, alice));
        shapes.redeem(id);

        uint256 before = bob.balance;
        vm.prank(bob);
        shapes.redeem(id);
        assertEq(bob.balance - before, DENOMS[6]);
    }

    function test_NonOwnerCannotRedeem() public {
        uint256 id = _mint(alice, DENOMS[4]);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.redeem(id);
        assertEq(shapes.redeemableBacking(), DENOMS[4]);
    }

    /// @dev Approval grants the right to move a Shape, never the right to unwrap it.
    function test_ApprovedSpenderCannotRedeem() public {
        uint256 id = _mint(alice, DENOMS[4]);

        vm.prank(alice);
        shapes.approve(bob, id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.redeem(id);

        vm.prank(alice);
        shapes.setApprovalForAll(bob, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.redeem(id);

        // but the approval does still allow a transfer
        vm.prank(bob);
        shapes.transferFrom(alice, bob, id);
        assertEq(shapes.ownerOf(id), bob);
    }

    function test_RedeemNonexistentReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        shapes.redeem(7);
    }

    function test_RedeemBatchAccounting() public {
        uint256[] memory ids = new uint256[](4);
        uint256 total;
        uint256[4] memory amounts = [uint256(DENOMS[0]), DENOMS[3], DENOMS[5], DENOMS[7]];
        for (uint256 i = 0; i < 4; ++i) {
            ids[i] = _mint(alice, amounts[i]);
            total += amounts[i];
        }
        assertEq(shapes.redeemableBacking(), total);

        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 paid = shapes.redeemBatch(ids);

        assertEq(paid, total);
        assertEq(alice.balance - before, total, "one aggregate transfer of the exact total");
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        assertEq(address(shapes).balance, shapes.pendingFees());
    }

    function test_RedeemBatchRejectsForeignToken() public {
        uint256 a = _mint(alice, DENOMS[4]);
        uint256 b = _mint(bob, DENOMS[4]);

        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, b, alice));
        shapes.redeemBatch(ids);

        assertEq(shapes.redeemableBacking(), DENOMS[4] * 2, "nothing settled on a reverted batch");
        assertEq(shapes.ownerOf(a), alice);
    }

    function test_RedeemBatchRejectsDuplicates() public {
        uint256 id = _mint(alice, DENOMS[4]);
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.redeemBatch(ids);

        assertEq(shapes.redeemableBacking(), DENOMS[4], "no double spend");
        assertEq(address(shapes).balance, DENOMS[4] + shapes.pendingFees());
    }

    function test_RedeemBatchRejectsEmpty() public {
        uint256[] memory ids = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(IShapes.ZeroQuantity.selector);
        shapes.redeemBatch(ids);
    }

    function test_FailedPayoutRevertsEntireRedemption() public {
        EthRejectingReceiver r = new EthRejectingReceiver();
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(r));

        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(r), DENOMS[4]));
        r.redeem(shapes, id);

        assertEq(shapes.ownerOf(id), address(r), "token survives a failed payout");
        assertEq(shapes.backingOf(id), DENOMS[4]);
        assertEq(shapes.redeemableBacking(), DENOMS[4]);
        _assertSolvent();
    }

    function test_ContractOwnerCanRedeem() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: DENOMS[7] + feeOf(DENOMS[7])}(DENOMS[7], address(r));

        r.redeem(shapes, id);
        assertEq(address(r).balance, DENOMS[7]);
        assertEq(shapes.redeemableBacking(), 0);
    }

    function testFuzz_RedemptionReturnsExactlyBacking(uint8 which, address to) public {
        vm.assume(to != address(0) && to.code.length == 0 && to != address(shapes));
        assumeNotPrecompile(to);
        uint256 amount = DENOMS[which % 9];

        vm.deal(alice, amount + feeOf(amount));
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: amount + feeOf(amount)}(amount, to);

        uint256 before = to.balance;
        vm.prank(to);
        shapes.redeem(id);

        assertEq(to.balance - before, amount);
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(address(shapes).balance, shapes.pendingFees());
    }
}

/* ==================================================================== *
 *  Reserve security
 * ==================================================================== */

contract ReserveTest is ShapesBase {
    function test_DirectEthTransfersRevert() public {
        vm.deal(alice, DENOMS[4] * 2);

        vm.prank(alice);
        (bool ok, bytes memory ret) = address(shapes).call{value: DENOMS[4]}("");
        assertFalse(ok, "plain transfer must revert");
        assertEq(bytes4(ret), IShapes.DirectDepositRejected.selector);

        vm.prank(alice);
        (ok, ret) = address(shapes).call{value: DENOMS[4]}(hex"12345678");
        assertFalse(ok, "unknown selector with value must revert");
        assertEq(bytes4(ret), IShapes.DirectDepositRejected.selector);

        assertEq(address(shapes).balance, 0);
    }

    function test_UnknownSelectorsRevertEvenWithoutValue() public {
        // The only administrative power is the cosmetic renderer (owned, lockable). No function
        // reaches the reserve, the fee terms, or a holder's token. This is a sample of the
        // economic administrative surface Shapes deliberately lacks.
        string[7] memory absent = [
            "withdraw()",
            "withdrawAll()",
            "emergencyWithdraw()",
            "pause()",
            "setFeeBps(uint256)",
            "rescueETH(address,uint256)",
            "seize(uint256)"
        ];
        for (uint256 i = 0; i < absent.length; ++i) {
            (bool ok,) = address(shapes).call(abi.encodeWithSignature(absent[i]));
            assertFalse(ok, absent[i]);
        }
    }

    /// @dev Forced ETH (selfdestruct, block rewards, pre-deployment transfer) can raise the
    ///      balance without any code running. The surplus must be inert, not withdrawable.
    function test_ForcedEtherIsInertAndKeepsInvariant() public {
        uint256 id = _mint(alice, DENOMS[4]);

        vm.deal(address(shapes), address(shapes).balance + DENOMS[4] * 3);
        assertEq(address(shapes).balance, DENOMS[4] * 4 + shapes.pendingFees());
        assertEq(shapes.redeemableBacking(), DENOMS[4], "forced ETH does not become backing");
        _assertSolvent();

        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);

        assertEq(alice.balance - before, DENOMS[4], "redeemer gets backing, not the surplus");
        assertEq(address(shapes).balance, DENOMS[4] * 3 + shapes.pendingFees(), "surplus stays stranded");
        assertEq(shapes.redeemableBacking(), 0);
        _assertSolvent();
    }

    function test_BackingCannotLeaveWithoutBurning() public {
        for (uint256 i = 0; i < 9; ++i) {
            _mint(alice, DENOMS[i]);
        }
        uint256 lockedBefore = address(shapes).balance;
        uint256 supplyBefore = shapes.totalSupply();

        // transfers, approvals and metadata reads move nothing
        vm.startPrank(alice);
        shapes.transferFrom(alice, bob, 1);
        shapes.setApprovalForAll(bob, true);
        vm.stopPrank();
        shapes.tokenURI(2);

        assertEq(address(shapes).balance, lockedBefore);
        assertEq(shapes.totalSupply(), supplyBefore);
        _assertSolvent();
    }

    function test_ReentrantRedeemIsBlocked() public {
        ReentrantRedeemer r = new ReentrantRedeemer(IShapes(address(shapes)));
        vm.startPrank(alice);
        uint256 a = shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(r));
        uint256 b = shapes.mintTo{value: DENOMS[5] + feeOf(DENOMS[5])}(DENOMS[5], address(r));
        vm.stopPrank();

        r.arm(b, false);
        r.redeem(a);

        assertTrue(r.attempted(), "the callback ran");
        assertTrue(r.reentryReverted(), "re-entry into redeem must revert");
        assertEq(address(r).balance, DENOMS[4], "only the first token settled");
        assertEq(shapes.ownerOf(b), address(r), "the second token is untouched");
        assertEq(shapes.redeemableBacking(), DENOMS[5]);
        assertEq(address(shapes).balance, DENOMS[5] + shapes.pendingFees());
        _assertSolvent();
    }

    function test_ReentrantRedeemBatchIsBlocked() public {
        ReentrantRedeemer r = new ReentrantRedeemer(IShapes(address(shapes)));
        vm.startPrank(alice);
        uint256 a = shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(r));
        uint256 b = shapes.mintTo{value: DENOMS[5] + feeOf(DENOMS[5])}(DENOMS[5], address(r));
        vm.stopPrank();

        r.arm(b, true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = a;
        r.redeemBatch(ids);

        assertTrue(r.reentryReverted(), "re-entry into redeemBatch must revert");
        assertEq(shapes.redeemableBacking(), DENOMS[5]);
        _assertSolvent();
    }

    function test_ReentrantMintFromReceiverCallbackIsBlocked() public {
        ReentrantMinter m = new ReentrantMinter(IShapes(address(shapes)), DENOMS[4]);
        vm.deal(address(m), 10 ether);

        m.mint{value: DENOMS[4] + feeOf(DENOMS[4])}();

        assertTrue(m.attempted(), "the receiver callback ran");
        assertTrue(m.reentryReverted(), "re-entry into mint must revert");
        assertEq(shapes.totalSupply(), 1, "exactly one token exists");
        assertEq(shapes.totalMinted(), 2);
        assertEq(shapes.redeemableBacking(), DENOMS[4]);
        assertEq(address(shapes).balance, DENOMS[4] + shapes.pendingFees());
        _assertSolvent();
    }

    function test_ReentrantMintFromFeeRecipientIsBlocked() public {
        ReentrantFeeRecipient fr = new ReentrantFeeRecipient();
        Shapes s = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(fr), address(renderer), address(collection), 0
        );
        s.redeemTo(0, payable(address(0xD15CA4D)));
        fr.configure(IShapes(address(s)), DENOMS[4]);
        vm.deal(address(fr), 10 ether);

        vm.prank(alice);
        s.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], alice);

        // The mint path makes no call to the fee recipient: the callback never fires.
        assertFalse(fr.attempted(), "the fee recipient receives no callback during mint");
        assertEq(s.totalSupply(), 1);
        assertEq(s.redeemableBacking(), DENOMS[4]);
        assertEq(s.pendingFees(), MINT_FEE);
        assertEq(address(s).balance, DENOMS[4] + MINT_FEE);

        // Withdrawing hands `fr` control from its `receive`. The reentrant mint attempt is blocked
        // by the shared reentrancy guard, but the withdrawal itself still completes.
        uint256 frBefore = address(fr).balance;
        s.withdrawFees();

        assertTrue(fr.attempted(), "the fee callback ran on withdrawal");
        assertTrue(fr.reentryReverted(), "re-entry into mint from the fee callback must revert");
        assertEq(s.pendingFees(), 0, "the withdrawal completed");
        assertEq(address(fr).balance - frBefore, MINT_FEE, "the recipient received the withdrawal");
        assertEq(s.totalSupply(), 1, "the reentrant mint never landed");
        assertGe(address(s).balance, s.redeemableBacking() + s.pendingFees());
    }
}

/* ==================================================================== *
 *  Views and ERC721 surface
 * ==================================================================== */

contract ViewTest is ShapesBase {
    function test_DenominationToGridMapping() public view {
        uint256[9] memory expectedCols = [uint256(5), 4, 4, 3, 3, 2, 2, 1, 1];
        uint256[9] memory expectedRows = [uint256(5), 5, 4, 4, 3, 3, 2, 2, 1];
        for (uint256 i = 0; i < 9; ++i) {
            (uint256 c, uint256 r) = lens.gridForAmount(DENOMS[i]);
            assertEq(c, expectedCols[i]);
            assertEq(r, expectedRows[i]);
            assertEq(lens.modulesForAmount(DENOMS[i]), c * r);
        }
    }

    /// @dev The whole point of the ladder: value up, complexity down, strictly.
    function test_ModuleCountStrictlyDecreasesWithValue() public view {
        uint256 previous = type(uint256).max;
        for (uint256 i = 0; i < 9; ++i) {
            uint256 m = lens.modulesForAmount(DENOMS[i]);
            assertLt(m, previous, "modules must fall as value rises");
            previous = m;
        }
        assertEq(lens.modulesForAmount(DENOMS[0]), 25);
        assertEq(lens.modulesForAmount(DENOMS[8]), 1);
    }

    function test_GridForUnsupportedAmountReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Denominations.UnsupportedDenomination.selector, DENOMS[4] * 2));
        lens.gridForAmount(DENOMS[4] * 2);
    }

    function test_IsSupportedDenomination() public view {
        for (uint256 i = 0; i < 9; ++i) {
            assertTrue(lens.isSupportedDenomination(DENOMS[i]));
        }
        assertFalse(lens.isSupportedDenomination(0));
        assertFalse(lens.isSupportedDenomination(DENOMS[4] * 2));
        assertFalse(lens.isSupportedDenomination(DENOMS[4] + 1));
        assertFalse(lens.isSupportedDenomination(type(uint256).max));
    }

    function test_NameSymbolAndInterfaces() public view {
        assertEq(shapes.name(), "Shapes");
        assertEq(shapes.symbol(), "SHAPE");
        assertTrue(shapes.supportsInterface(type(IERC165).interfaceId));
        assertTrue(shapes.supportsInterface(type(IERC721).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapes).interfaceId));
        assertFalse(shapes.supportsInterface(0xffffffff));
    }

    function test_BackingOfNonexistentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        shapes.backingOf(1);
    }
}

/* ==================================================================== *
 *  Core state discovery
 * ==================================================================== */

contract CoreStateDiscoveryTest is ShapesBase {
    function test_ExistsTracksEveryTokenLifecycle() public {
        assertFalse(lens.exists(999), "never-issued id is not live");

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 5);
        assertTrue(lens.exists(first), "minted id is live");

        vm.prank(alice);
        shapes.transferFrom(alice, bob, first);
        assertTrue(lens.exists(first), "transfer does not change liveness");
        vm.prank(bob);
        shapes.transferFrom(bob, alice, first);

        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < burnIds.length; ++i) {
            burnIds[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burnIds);
        assertTrue(lens.exists(first), "compose survivor remains live");
        assertEq(shapes.denomIndexOf(first), 1, "compose updates stored denomination");
        for (uint256 i = 0; i < burnIds.length; ++i) {
            assertFalse(lens.exists(burnIds[i]), "compose input is consumed");
        }
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, burnIds[0]));
        shapes.denomIndexOf(burnIds[0]);

        vm.prank(alice);
        shapes.decompose(first);
        assertEq(shapes.denomIndexOf(first), 0, "decompose restores survivor denomination");
        for (uint256 i = 0; i < burnIds.length; ++i) {
            assertTrue(lens.exists(burnIds[i]), "decompose revives input identity");
            assertEq(shapes.denomIndexOf(burnIds[i]), 0, "decompose restores input denomination");
        }

        vm.prank(alice);
        shapes.compose(first, burnIds);
        uint8[] memory outDenoms = new uint8[](5);
        vm.prank(alice);
        uint256[] memory children = shapes.split(first, outDenoms);
        assertFalse(lens.exists(first), "split retires parent");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, first));
        shapes.denomIndexOf(first);
        for (uint256 i = 0; i < children.length; ++i) {
            assertTrue(lens.exists(children[i]), "split child is live");
            assertEq(shapes.denomIndexOf(children[i]), 0, "split child exposes output denomination");
        }

        vm.prank(alice);
        shapes.redeem(children[0]);
        assertFalse(lens.exists(children[0]), "redeem retires id");

        vm.prank(alice);
        shapes.burn(children[1]);
        assertFalse(lens.exists(children[1]), "burn retires id");
    }

    function test_DenomIndexOfNonexistentRevertsWhileExistsDoesNot() public {
        uint256 tokenId = 777;
        assertFalse(lens.exists(tokenId));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        shapes.denomIndexOf(tokenId);
    }
}

/* ==================================================================== *
 *  Formation classification
 * ==================================================================== */

contract FormationTest is ShapesBase {
    /// @notice Every live formation, reached by the operation that produces it. The
    ///         classification is a pure function of (denomination, origin count), so each case
    ///         pins the origin count it depends on.
    function test_FormationOfClassifiesEveryLiveFormation() public {
        // Direct: one mint, one origin, capacity unfilled.
        uint256 direct = _mint(alice, DENOMS[1]);
        assertEq(shapes.originCountOf(direct), 1);
        assertEq(uint8(shapes.formationOf(direct)), uint8(ShapeFormation.Direct), "fresh mint");

        // Complete: five 0.01 mints composed into a 0.05, whose capacity is five units.
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 5);
        uint256[] memory four = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            four[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, four);
        assertEq(shapes.originCountOf(first), 5, "five origins fill a 0.05");
        assertEq(uint8(shapes.formationOf(first)), uint8(ShapeFormation.Complete), "capacity filled");

        // Composed: two 0.05 direct mints merged into a 0.1, two origins against ten units.
        uint256 a = _mint(alice, DENOMS[1]);
        uint256 b = _mint(alice, DENOMS[1]);
        uint256[] memory one = new uint256[](1);
        one[0] = b;
        vm.prank(alice);
        shapes.compose(a, one);
        assertEq(shapes.originCountOf(a), 2, "origins are conserved, not capacity");
        assertEq(uint8(shapes.formationOf(a)), uint8(ShapeFormation.Composed), "merged but unfilled");

        // Fragment: splitting a one-origin 0.1 gives its single origin to the first child and
        // nothing to the second.
        uint256 parent = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1; // 0.05
        outs[1] = 1; // 0.05
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        assertEq(shapes.originCountOf(kids[0]), 1);
        assertEq(shapes.originCountOf(kids[1]), 0, "the parent's origin went to the first child");
        assertEq(uint8(shapes.formationOf(kids[0])), uint8(ShapeFormation.Direct), "kept the origin");
        assertEq(uint8(shapes.formationOf(kids[1])), uint8(ShapeFormation.Fragment), "no origin");

        // `ShapeLens` recomputes the same classification from the core's getters.
        uint256[5] memory all = [direct, first, a, kids[0], kids[1]];
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(
                uint8(lens.shapeState(all[i]).formation),
                uint8(shapes.formationOf(all[i])),
                "lens disagreed with the core"
            );
        }
    }

    function test_FormationOfNonexistentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        shapes.formationOf(1);
    }
}

/* ==================================================================== *
 *  Value discovery and draft ERC-8060
 * ==================================================================== */

contract ValueDiscoveryTest is ShapesBase {
    function _expectBothNonexistent(uint256 tokenId) private {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        shapes.backingOf(tokenId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        shapes.valueOf(tokenId);
    }

    function test_ValueOfMatchesEveryDirectDenomination() public {
        for (uint256 i = 0; i < DENOMS.length; ++i) {
            uint256 id = _mint(alice, DENOMS[i]);
            assertEq(shapes.valueOf(id), DENOMS[i]);
            assertEq(shapes.valueOf(id), shapes.backingOf(id));
        }
    }

    function test_ValueOfTracksComposeAndConsumedInputs() public {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + 1 + i;
        }

        vm.prank(alice);
        shapes.compose(first, burnIds);

        assertEq(shapes.valueOf(first), DENOMS[1]);
        assertEq(shapes.valueOf(first), shapes.backingOf(first));
        for (uint256 i = 0; i < burnIds.length; ++i) {
            _expectBothNonexistent(burnIds[i]);
        }
    }

    function test_ValueOfTracksSplit() public {
        uint256 parent = _mint(alice, DENOMS[4]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 3;
        outs[1] = 3;

        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        _expectBothNonexistent(parent);
        assertEq(shapes.valueOf(kids[0]), DENOMS[3]);
        assertEq(shapes.valueOf(kids[1]), DENOMS[3]);
    }

    function test_ValueOfRedeemedTokenMatchesBackingRevert() public {
        uint256 id = _mint(alice, DENOMS[5]);
        vm.prank(alice);
        shapes.redeem(id);
        _expectBothNonexistent(id);
    }

    function test_ValueOfChangesNoStateOrEthAccounting() public {
        uint256 id = _mint(alice, DENOMS[6]);
        uint256 balanceBefore = address(shapes).balance;
        uint256 backingBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();
        uint256 mintedBefore = shapes.totalMinted();
        address ownerBefore = shapes.ownerOf(id);
        bytes32 seedBefore = shapes.seedOf(id);
        uint256 originsBefore = shapes.originCountOf(id);
        uint8 geneBefore = shapes.inkGeneOf(id);

        assertEq(shapes.valueOf(id), DENOMS[6]);

        assertEq(address(shapes).balance, balanceBefore);
        assertEq(shapes.redeemableBacking(), backingBefore);
        assertEq(shapes.totalSupply(), supplyBefore);
        assertEq(shapes.totalMinted(), mintedBefore);
        assertEq(shapes.ownerOf(id), ownerBefore);
        assertEq(shapes.seedOf(id), seedBefore);
        assertEq(shapes.originCountOf(id), originsBefore);
        assertEq(shapes.inkGeneOf(id), geneBefore);
    }

    function test_DraftErc8060InterfaceAndBurn() public {
        assertEq(type(IERC721Value).interfaceId, bytes4(0x88495fe7));
        assertTrue(shapes.supportsInterface(type(IERC721Value).interfaceId));

        uint256 id = _mint(alice, DENOMS[5]);
        uint256 before = alice.balance;
        vm.expectEmit(true, true, true, true, address(shapes));
        emit IERC721.Transfer(alice, address(0), id);
        vm.prank(alice);
        shapes.burn(id);

        assertEq(alice.balance - before, DENOMS[5]);
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        _expectBothNonexistent(id);
    }

    function test_BurnIsOwnerOnlyEvenWhenOperatorIsApproved() public {
        uint256 id = _mint(alice, DENOMS[4]);
        vm.prank(alice);
        shapes.approve(bob, id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.burn(id);

        vm.prank(alice);
        shapes.burn(id);
        _assertSolvent();
    }

    function test_BurnNonexistentAndDoubleBurnRevert() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 77));
        shapes.burn(77);

        uint256 id = _mint(alice, DENOMS[0]);
        vm.prank(alice);
        shapes.burn(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.burn(id);
    }

    function test_TerminalIdsStayRetiredWhileDecomposeRevivesComposeInputs() public {
        uint256 redeemed = _mint(alice, DENOMS[0]);
        assertEq(redeemed, 1);
        vm.prank(alice);
        shapes.redeem(redeemed);

        uint256 parent = _mint(alice, DENOMS[1]);
        assertEq(parent, 2);
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        assertEq(kids[0], 3);
        assertEq(kids[4], 7);

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 5);
        assertEq(first, 8);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burnIds);

        // Reversible compose is the one deliberate exception: decompose revives the exact
        // consumed identities without issuing new ids or moving the high-water counter.
        vm.prank(alice);
        uint256[] memory revived = shapes.decompose(first);
        for (uint256 i = 0; i < revived.length; ++i) {
            assertEq(revived[i], burnIds[i]);
        }
        assertEq(shapes.totalMinted(), 13);

        uint256 next = _mint(alice, DENOMS[0]);
        assertEq(next, 13, "redeem and split never recycle a retired id");
        assertEq(shapes.totalMinted(), 14);
    }
}

/* ==================================================================== *
 *  Positions and market pointers
 * ==================================================================== */

contract PointersTest is ShapesBase {
    function test_PointersStartEmptyUnlockedAndPositionQueriesReturnZero() public view {
        assertEq(_positionsAddress(), address(0));
        assertFalse(_positionsIsLocked());
        assertEq(_marketAddress(), address(0));
        assertFalse(_marketIsLocked());
        assertEq(lens.positionOf(1), address(0));
        assertEq(lens.positionOf(type(uint256).max), address(0));
    }

    function test_AdminSetsExactPositionsResultsAndEvent() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setPosition(1, alice);
        resolver.setPosition(99, address(renderer));

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.PositionsSet(address(resolver));
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));

        assertEq(_positionsAddress(), address(resolver));
        assertEq(lens.positionOf(1), alice);
        assertEq(lens.positionOf(2), address(0));
        assertEq(lens.positionOf(99), address(renderer));
    }

    function test_PositionsCanBeReplacedAndClearedUntilLocked() public {
        MockPositionResolver first = new MockPositionResolver();
        MockPositionResolver second = new MockPositionResolver();
        first.setPosition(1, alice);
        second.setPosition(1, bob);

        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(first));
        assertEq(lens.positionOf(1), alice);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(second));
        assertEq(lens.positionOf(1), bob);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(0));
        assertEq(_positionsAddress(), address(0));
        assertEq(lens.positionOf(1), address(0));
    }

    function test_PositionsRejectsCodelessNonzeroAddress() public {
        vm.expectRevert(IShapes.InvalidPointerTarget.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), alice);
    }

    function test_MarketCanBeSetReplacedAndClearedWithEvents() public {
        MockPositionResolver first = new MockPositionResolver();
        MockPositionResolver second = new MockPositionResolver();

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.MarketSet(address(first));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(first));
        assertEq(_marketAddress(), address(first));

        shapes.setPointer(uint8(IShapes.Pointer.Market), address(second));
        assertEq(_marketAddress(), address(second));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(0));
        assertEq(_marketAddress(), address(0));
    }

    function test_MarketRejectsCodelessNonzeroAddress() public {
        vm.expectRevert(IShapes.InvalidPointerTarget.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Market), alice);
    }

    function test_InvalidPointerIdsRevertWithoutChangingEitherPointer() public {
        MockPositionResolver target = new MockPositionResolver();
        vm.expectRevert(IShapes.InvalidPointer.selector);
        shapes.setPointer(2, address(target));
        vm.expectRevert(IShapes.InvalidPointer.selector);
        shapes.lockPointer(type(uint8).max);

        assertEq(_positionsAddress(), address(0));
        assertFalse(_positionsIsLocked());
        assertEq(_marketAddress(), address(0));
        assertFalse(_marketIsLocked());
    }

    function test_PointerAdministrationIsAdminOnly() public {
        MockPositionResolver resolver = new MockPositionResolver();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(resolver));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.lockPointer(uint8(IShapes.Pointer.Market));
    }

    function test_AdminMayPermanentlyLockZero() public {
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.PositionsLocked(address(0));
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));
        assertTrue(_positionsIsLocked());
        assertEq(lens.positionOf(123), address(0));

        MockPositionResolver resolver = new MockPositionResolver();
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));
    }

    function test_ConfiguredPositionsBecomesPermanentWhenLocked() public {
        MockPositionResolver resolver = new MockPositionResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.PositionsLocked(address(resolver));
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));

        MockPositionResolver replacement = new MockPositionResolver();
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(replacement));
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(0));
        assertEq(_positionsAddress(), address(resolver));
    }

    function test_ConfiguredMarketBecomesPermanentWhenLocked() public {
        MockPositionResolver market_ = new MockPositionResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(market_));
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.MarketLocked(address(market_));
        shapes.lockPointer(uint8(IShapes.Pointer.Market));

        MockPositionResolver replacement = new MockPositionResolver();
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(replacement));
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(0));
        assertEq(_marketAddress(), address(market_));
        assertTrue(_marketIsLocked());
    }

    function test_AdminMayPermanentlyLockMarketAtZeroWithoutLockingPositions() public {
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.MarketLocked(address(0));
        shapes.lockPointer(uint8(IShapes.Pointer.Market));
        assertTrue(_marketIsLocked());

        MockPositionResolver target = new MockPositionResolver();
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(target));
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.lockPointer(uint8(IShapes.Pointer.Market));

        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(target));
        assertEq(_positionsAddress(), address(target));
        assertFalse(_positionsIsLocked());
    }

    function test_RendererPositionsAndMarketLocksAreIndependent() public {
        shapes.lockRenderer();
        MockPositionResolver resolver = new MockPositionResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));

        MockPositionResolver market_ = new MockPositionResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(market_));
        assertTrue(shapes.rendererLocked());
        assertTrue(_positionsIsLocked());
        assertEq(_marketAddress(), address(market_));
        assertFalse(_marketIsLocked());

        shapes.lockPointer(uint8(IShapes.Pointer.Market));
        assertTrue(_marketIsLocked());
    }

    function test_AdminTransferMovesAllRemainingAdminAuthority() public {
        MockPositionResolver resolver = new MockPositionResolver();
        MockPositionResolver market_ = new MockPositionResolver();
        shapes.transferAdmin(alice);
        assertEq(shapes.admin(), alice);

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));

        vm.startPrank(alice);
        shapes.setRenderer(address(new ShapeRenderer()));
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(market_));
        shapes.transferAdmin(bob);
        vm.stopPrank();

        assertEq(shapes.admin(), bob);
        assertEq(_positionsAddress(), address(resolver));
        assertTrue(_positionsIsLocked());
        assertEq(_marketAddress(), address(market_));
        assertFalse(_marketIsLocked());
    }

    function test_RenouncingBeforeInstallLeavesBothPointersUnsetForever() public {
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0));
        MockPositionResolver resolver = new MockPositionResolver();
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(resolver));
        assertEq(_positionsAddress(), address(0));
        assertEq(_marketAddress(), address(0));
    }

    function test_RenouncingAfterInstallLeavesPointersUsableAndUnchanged() public {
        MockPositionResolver resolver = new MockPositionResolver();
        MockPositionResolver market_ = new MockPositionResolver();
        resolver.setPosition(7, alice);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(market_));
        shapes.renounceAdmin();
        assertEq(_positionsAddress(), address(resolver));
        assertEq(_marketAddress(), address(market_));
        assertEq(lens.positionOf(7), alice);
    }

    /// @notice A reverting positions target does not make `positionOf` revert; the failure is
    ///         swallowed to `address(0)`, the same value an unset target returns.
    function test_PositionsRevertIsSwallowedToZero() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setShouldRevert(true);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        uint256 id = _mint(alice, DENOMS[4]);

        assertEq(lens.positionOf(id), address(0), "existing id");
        assertEq(lens.positionOf(999), address(0), "nonexistent id");
    }

    /// @notice A positions target that burns unbounded gas cannot drain the caller: `positionOf`
    ///         forwards a fixed cap and swallows the resulting out-of-gas to `address(0)`.
    function test_HostilePositionsGasIsBounded() public {
        HostileGasResolver resolver = new HostileGasResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));

        uint256 gasBefore = gasleft();
        address position = lens.positionOf(1);
        uint256 used = gasBefore - gasleft();

        assertEq(position, address(0), "hostile positions result swallowed to zero");
        // The target alone would burn tens of millions; the capped call is a tiny fraction.
        assertLt(used, 200_000, "forwarded gas is bounded");
    }

    function test_MalformedPositionResultsAreSwallowedToZero() public {
        ShortReturnResolver shortResult = new ShortReturnResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(shortResult));
        assertEq(lens.positionOf(1), address(0), "short result");

        DirtyAddressResolver dirtyResult = new DirtyAddressResolver();
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(dirtyResult));
        assertEq(lens.positionOf(1), address(0), "dirty address result");
    }

    function test_SettingAndQueryingPositionsCannotChangeTokenOrReserveState() public {
        uint256 id = _mint(alice, DENOMS[5]);
        uint256 balanceBefore = address(shapes).balance;
        uint256 backingBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();
        address ownerBefore = shapes.ownerOf(id);
        bytes32 seedBefore = shapes.seedOf(id);
        string memory uriBefore = shapes.tokenURI(id);
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setPosition(id, bob);

        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        assertEq(lens.positionOf(id), bob);

        assertEq(address(shapes).balance, balanceBefore);
        assertEq(shapes.redeemableBacking(), backingBefore);
        assertEq(shapes.totalSupply(), supplyBefore);
        assertEq(shapes.ownerOf(id), ownerBefore);
        assertEq(shapes.seedOf(id), seedBefore);
        assertEq(shapes.tokenURI(id), uriBefore);
    }

    function test_RevertingPositionsAndMarketCannotAffectCoreLifecycle() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setShouldRevert(true);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(resolver));

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 5);
        assertGt(bytes(shapes.tokenURI(first)).length, 0);
        vm.prank(alice);
        shapes.transferFrom(alice, bob, first + 4);
        vm.prank(bob);
        shapes.transferFrom(bob, alice, first + 4);

        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burnIds);

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(first, outs);
        vm.prank(alice);
        shapes.redeemBatch(kids);

        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        _assertSolvent();
    }
}

/* ==================================================================== *
 *  Renderer replacement and lock
 * ==================================================================== */

contract RendererAdminTest is ShapesBase {
    // ShapesBase deploys `shapes` from this test contract, so it is the admin.
    function test_DeployerIsAdminAndRendererStartsUnlocked() public view {
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.renderer(), address(renderer));
        assertFalse(shapes.rendererLocked());
    }

    function test_AdminCanReplaceTheRenderer() public {
        uint256 id = _mint(alice, DENOMS[4]);
        string memory before = shapes.tokenURI(id);

        ShapeRenderer next = new ShapeRenderer();
        vm.expectEmit(true, false, false, false, address(shapes));
        emit IShapes.RendererUpdated(address(next));
        shapes.setRenderer(address(next));

        assertEq(shapes.renderer(), address(next));
        // A fresh identical renderer produces identical output, so assert the wiring rather than
        // a difference: tokenURI now routes through `next` and still renders.
        assertEq(shapes.tokenURI(id), before, "same code, same bytes");
        assertGt(bytes(shapes.tokenURI(id)).length, 0);
    }

    function test_SetRendererIsAdminOnly() public {
        ShapeRenderer next = new ShapeRenderer();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setRenderer(address(next));
    }

    /// @notice Replacing the renderer changes every token's metadata, so it must emit ERC-4906
    ///         `BatchMetadataUpdate` over the minted range so marketplaces refresh.
    function test_SetRendererEmitsBatchMetadataUpdate() public {
        _mint(alice, DENOMS[4]);
        _mint(bob, DENOMS[5]);
        ShapeRenderer next = new ShapeRenderer();

        vm.expectEmit(false, false, false, true, address(shapes));
        emit IERC4906.BatchMetadataUpdate(0, shapes.totalMinted() - 1);
        shapes.setRenderer(address(next));
    }

    function test_SetRendererRejectsCodelessAddress() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, alice));
        shapes.setRenderer(alice); // an EOA

        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(0)));
        shapes.setRenderer(address(0));
    }

    function test_LockFreezesTheRendererForever() public {
        ShapeRenderer next = new ShapeRenderer();

        vm.expectEmit(false, false, false, false, address(shapes));
        emit IShapes.RendererLocked();
        shapes.lockRenderer();
        assertTrue(shapes.rendererLocked());

        vm.expectRevert(IShapes.RendererIsLocked.selector);
        shapes.setRenderer(address(next));

        vm.expectRevert(IShapes.RendererIsLocked.selector);
        shapes.lockRenderer();
    }

    function test_LockIsAdminOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.lockRenderer();
    }

    /// @notice The renderer is cosmetic: replacing it never touches backing or redemption.
    function test_ReplacingRendererDoesNotAffectFunds() public {
        uint256 id = _mint(alice, DENOMS[5]);
        assertEq(shapes.backingOf(id), DENOMS[5]);

        // Point the renderer at an EOA-free contract with no metadata path would be refused, so
        // swap to another valid renderer, then prove redemption still pays exactly the backing.
        shapes.setRenderer(address(new ShapeRenderer()));

        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance - before, DENOMS[5], "renderer swap changed the payout");
        _assertSolvent();
    }

    function test_AdminCanRenounce() public {
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0));

        // With no admin, the renderer can no longer be changed, same as locking via a
        // different route.
        ShapeRenderer next = new ShapeRenderer();
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setRenderer(address(next));
    }
}

/* ==================================================================== *
 *  Recomposition (compose / split)
 * ==================================================================== */

contract RecompositionTest is ShapesBase {
    /// @dev Mint `qty` tokens of `amount` to alice; ids are `first .. first+qty-1`.
    function _mintMany(uint256 amount, uint256 qty) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: qty * (amount + feeOf(amount))}(amount, qty);
    }

    /// @dev A genuine Complete 0.05: five 0.01 direct mints composed into one.
    function _buildComplete005() internal returns (uint256 survivor) {
        uint256 first = _mintMany(DENOMS[0], 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    function test_ComposeCombinesBackingAndOrigins() public {
        uint256 first = _mintMany(DENOMS[0], 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }

        vm.prank(alice);
        uint256 outId = shapes.compose(first, burn);

        assertEq(outId, first, "survivor keeps its id");
        assertEq(shapes.backingOf(first), DENOMS[1], "backing summed to 0.05");
        assertEq(shapes.originCountOf(first), 5, "origins summed");
        assertTrue(shapes.isComplete(first), "5 origins on 0.05 is Complete");
        assertEq(shapes.totalSupply(), 1, "four inputs burned");
        assertEq(shapes.redeemableBacking(), DENOMS[1], "reserve conserved");
        _assertSolvent();
        vm.expectRevert();
        shapes.ownerOf(first + 1);
    }

    function test_ComposeKeepsSurvivorSeed() public {
        uint256 first = _mintMany(DENOMS[0], 5);
        bytes32 seed = shapes.seedOf(first);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(shapes.seedOf(first), seed, "seed unchanged through compose");
    }

    function test_ComposeRejectsInvalidSum() public {
        uint256 first = _mintMany(DENOMS[0], 3); // 0.03 is not a denomination
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 2;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, DENOMS[0] * 3));
        shapes.compose(first, burn);
    }

    function test_ComposeRejectsNonOwnerInput() public {
        uint256 a = _mint(alice, DENOMS[0]);
        vm.prank(bob);
        uint256 b = shapes.mint{value: DENOMS[0] + feeOf(DENOMS[0])}(DENOMS[0]);
        uint256[] memory burn = new uint256[](1);
        burn[0] = b;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, b, alice));
        shapes.compose(a, burn);
    }

    function test_ComposeRejectsSelf() public {
        uint256 first = _mintMany(DENOMS[0], 2);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first; // survivor cannot be in its own burn set
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, first));
        shapes.compose(first, burn);
    }

    function test_ComposeRejectsDuplicate() public {
        uint256 first = _mintMany(DENOMS[0], 5);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 1; // duplicate: second _burn hits a nonexistent token
        vm.prank(alice);
        vm.expectRevert();
        shapes.compose(first, burn);
    }

    function test_ComposeRejectsEmpty() public {
        uint256 a = _mint(alice, DENOMS[0]);
        uint256[] memory burn = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(IShapes.EmptyRecomposition.selector);
        shapes.compose(a, burn);
    }

    function test_SplitBurnsInputAndMintsChildren() public {
        uint256 id = _mint(alice, DENOMS[1]); // direct, originCount 1
        uint8[] memory outs = new uint8[](5); // 5 x 0.01 (index 0)
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);

        assertEq(kids.length, 5);
        vm.expectRevert();
        shapes.ownerOf(id); // input burned

        assertEq(shapes.originCountOf(kids[0]), 1, "survivor-first fill");
        assertEq(shapes.originCountOf(kids[1]), 0);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(shapes.backingOf(kids[i]), DENOMS[0]);
            assertEq(shapes.ownerOf(kids[i]), alice);
        }
        assertEq(shapes.redeemableBacking(), DENOMS[1], "reserve conserved");
        assertEq(shapes.totalSupply(), 5);
        _assertSolvent();
    }

    function test_SplitChildSeedsAreDeterministic() public {
        uint256 id = _mint(alice, DENOMS[1]);
        bytes32 parentSeed = shapes.seedOf(id);
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(
                shapes.seedOf(kids[i]),
                keccak256(abi.encodePacked(parentSeed, i)),
                "child seed derived from parent"
            );
        }
    }

    function test_SplitRejectsBadSum() public {
        uint256 id = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 0;
        outs[1] = 0; // 0.02 != 0.1
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitMismatch.selector, DENOMS[2], DENOMS[0] * 2));
        shapes.split(id, outs);
    }

    function test_SplitRejectsSingleOutput() public {
        uint256 id = _mint(alice, DENOMS[1]);
        uint8[] memory outs = new uint8[](1);
        outs[0] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitTooFewOutputs.selector));
        shapes.split(id, outs);
    }

    function test_ForgeryBlocked_SplitRecombinePreservesCount() public {
        uint256 id = _mint(alice, DENOMS[2]); // direct, originCount 1
        uint8[] memory outs = new uint8[](10); // 10 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);

        uint256[] memory burn = new uint256[](9);
        for (uint256 i = 0; i < 9; i++) {
            burn[i] = kids[i + 1];
        }
        vm.prank(alice);
        uint256 outId = shapes.compose(kids[0], burn);

        assertEq(shapes.backingOf(outId), DENOMS[2]);
        assertEq(shapes.originCountOf(outId), 1, "count preserved, not inflated to 10");
        assertFalse(shapes.isComplete(outId), "split-recombine cannot forge Complete");
    }

    function test_CompletePropagatesUpward() public {
        uint256 a = _buildComplete005();
        uint256 b = _buildComplete005();
        assertTrue(shapes.isComplete(a));
        assertTrue(shapes.isComplete(b));

        uint256[] memory burn = new uint256[](1);
        burn[0] = b;
        vm.prank(alice);
        shapes.compose(a, burn);

        assertEq(shapes.backingOf(a), DENOMS[2]);
        assertEq(shapes.originCountOf(a), 10);
        assertTrue(shapes.isComplete(a), "composing Completes yields a Complete");
    }

    function test_LoneMinTierIsNotComplete() public {
        uint256 id = _mint(alice, DENOMS[0]); // units == 1
        assertFalse(shapes.isComplete(id), "tier 0 is Direct, never Complete");
    }

    function test_NoFeeChargedOnRecompose() public {
        uint256 first = _mintMany(DENOMS[0], 5);
        uint256 afterMint = shapes.pendingFees();
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(shapes.pendingFees(), afterMint, "compose charged no fee");

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        shapes.split(first, outs);
        assertEq(shapes.pendingFees(), afterMint, "split charged no fee");
    }

    function test_SupportsErc4906() public view {
        assertTrue(shapes.supportsInterface(0x49064906));
    }

    /// @notice ShapeRedeemed carries the redeemed token's originCount, so an event-only indexer can
    ///         track global origin conservation without a pre-burn state read.
    function test_RedeemEmitsOriginCount() public {
        uint256 id = _buildComplete005(); // five 0.01 direct mints composed → 0.05, originCount 5
        vm.expectEmit(true, true, false, true, address(shapes));
        emit IShapes.ShapeRedeemed(id, alice, DENOMS[1], 5);
        vm.prank(alice);
        shapes.redeem(id);
    }

    /// @notice The child seeds derive from the parent seed and index alone — no block data. Mutating
    ///         the block environment before the split cannot change them, so a split cannot be
    ///         re-rolled by waiting for a friendlier block.
    function test_SplitChildSeedsIgnoreBlockEnv() public {
        uint256 parent = _mint(alice, DENOMS[1]);
        bytes32 parentSeed = shapes.seedOf(parent);

        vm.roll(block.number + 123_456);
        vm.warp(block.timestamp + 999 days);
        vm.prevrandao(bytes32(uint256(0xC0FFEE)));
        vm.fee(777 gwei);
        vm.chainId(4242);

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);

        for (uint256 i = 0; i < kids.length; ++i) {
            assertEq(
                shapes.seedOf(kids[i]),
                keccak256(abi.encodePacked(parentSeed, i)),
                "block environment leaked into a child seed"
            );
        }
    }
}

/* ==================================================================== *
 *  Black Shape sacrifice and zero-value burn
 * ==================================================================== */

contract BlackShapeTest is ShapesBase {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev A genuine apex Complete: 10,000 direct 0.01 mints composed into one 100 ETH token
    ///      carrying 10,000 origins. The only sacrificable state; nothing cheaper reaches it,
    ///      because origins are conserved and only a direct mint creates one.
    function _buildApexComplete() internal returns (uint256 id) {
        vm.prank(alice);
        uint256 first =
            shapes.mintBatchTo{value: 10_000 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 10_000, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        id = shapes.compose(first, burn);
        assertEq(shapes.backingOf(id), DENOMS[8], "apex backing");
        assertEq(shapes.originCountOf(id), 10_000, "apex origins");
        assertTrue(shapes.isComplete(id), "apex is Complete");
    }

    /// @dev A Complete 0.05 (five 0.01 direct mints composed): Complete but below apex.
    function _buildComplete005() internal returns (uint256 survivor) {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    function test_SacrificeCreatesBlackWithoutBurningAndIgnoresPositionsTarget() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setShouldRevert(true);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(resolver));
        uint256 id = _buildApexComplete();
        uint256 deadBefore = DEAD.balance;
        uint256 balBefore = address(shapes).balance;
        assertEq(shapes.redeemableBacking(), DENOMS[8], "reserve is the apex backing");

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.Blackened(id, DENOMS[8]);
        vm.prank(alice);
        shapes.sacrifice(id);

        assertTrue(shapes.isBlack(id), "now Black");
        assertTrue(lens.exists(id), "Black remains a live ERC721");
        assertEq(shapes.denomIndexOf(id), 8, "Black retains its apex denomination index");
        assertEq(shapes.blackShapeCount(), 1);
        assertEq(shapes.burnedBacking(), DENOMS[8]);
        assertEq(shapes.redeemableBacking(), 0, "backing left the reserve");
        assertEq(DEAD.balance, deadBefore + DENOMS[8], "sacrificed to the burn address");
        assertEq(address(shapes).balance, balBefore - DENOMS[8], "contract paid it out");
        assertEq(shapes.backingOf(id), 0, "black backing reads zero");
        assertEq(shapes.valueOf(id), 0, "black draft ERC-8060 value reads zero");
        assertEq(shapes.ownerOf(id), alice, "still owned");
        _assertSolvent();

        // Still an ERC721: transferable.
        vm.prank(alice);
        shapes.transferFrom(alice, bob, id);
        assertEq(shapes.ownerOf(id), bob);
    }

    function test_BlackRejectsRedeemAndRecompositionButCanBurnForZero() public {
        uint256 id = _buildApexComplete();
        vm.prank(alice);
        shapes.sacrifice(id);

        // Non-redeemable.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.redeem(id);

        // Non-recomposable, as survivor...
        uint256 extra = _mint(alice, DENOMS[0]);
        uint256[] memory burn = new uint256[](1);
        burn[0] = extra;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.compose(id, burn);

        // ...and as a split input.
        uint8[] memory outs = new uint8[](2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.split(id, outs);

        // One way: cannot sacrifice twice.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.sacrifice(id);

        uint256 balanceBefore = alice.balance;
        uint256 mintedBefore = shapes.totalMinted();
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.ShapeRedeemed(id, alice, 0, 10_000);
        vm.prank(alice);
        shapes.burn(id);

        assertEq(alice.balance, balanceBefore, "zero-value burn transfers no ETH");
        assertEq(shapes.burnedBacking(), DENOMS[8], "historical sacrifice remains counted");
        assertEq(shapes.blackShapeCount(), 1, "blackShapeCount is cumulative");
        assertFalse(lens.exists(id), "burn retires the Black id");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.ownerOf(id);

        uint256 next = _mint(alice, DENOMS[0]);
        assertEq(next, mintedBefore, "burned Black id is never reused");
    }

    function test_SacrificeRejectsDirectApex() public {
        uint256 id = _mint(alice, DENOMS[8]); // 100 ETH, originCount 1, not Complete
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotApexComplete.selector, id));
        shapes.sacrifice(id);
    }

    function test_SacrificeRejectsCompleteBelowApex() public {
        uint256 id = _buildComplete005();
        assertTrue(shapes.isComplete(id));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotApexComplete.selector, id));
        shapes.sacrifice(id);
    }

    function test_SacrificeRejectsNonOwner() public {
        uint256 id = _mint(alice, DENOMS[4]);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.sacrifice(id);
    }

    /// @notice `split` and `compose` reject a Black Shape, and the previews report the same
    ///         rejection from the same id, on either side of a compose.
    function test_PreviewsRejectBlackToMatchExecution() public {
        uint256 id = _buildApexComplete();
        vm.prank(alice);
        shapes.sacrifice(id);

        uint8[] memory outs = new uint8[](2);
        outs[0] = 7; // 50 ETH
        outs[1] = 7;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.split(id, outs);

        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        lens.previewSplit(id, outs);

        // As a compose survivor.
        uint256 live = _mint(alice, DENOMS[0]);
        uint256[] memory one = new uint256[](1);
        one[0] = live;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.compose(id, one);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        lens.previewCompose(id, one);

        // As a compose input.
        one[0] = id;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        shapes.compose(live, one);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, id));
        lens.previewCompose(live, one);
    }

    /// @notice A Black Shape backs nothing, so `ShapeLens` cannot recover its denomination from
    ///         `backingOf` and falls back on the apex invariant `sacrifice` enforces. The face
    ///         value and the artwork survive the sacrifice; only the redeemable value goes.
    function test_BlackShapeReadsAsApexWithNothingRedeemable() public {
        uint256 id = _buildApexComplete();
        string memory cardBefore = lens.unicodeCard(id);
        uint8 geneBefore = shapes.inkGeneOf(id);

        vm.prank(alice);
        shapes.sacrifice(id);

        assertEq(shapes.backingOf(id), 0, "a Black Shape backs nothing");
        assertEq(uint8(shapes.formationOf(id)), uint8(ShapeFormation.Black), "sacrifice sets Black");
        assertFalse(shapes.isComplete(id), "Black is terminal, not Complete");

        ShapeState memory st = lens.shapeState(id);
        assertTrue(st.isBlack);
        assertEq(uint8(st.formation), uint8(ShapeFormation.Black), "lens agrees with the core");
        assertEq(st.denominationIndex, 8, "the apex index survives the sacrifice");
        assertEq(st.faceValueWei, DENOMS[8], "face value is the apex amount");
        assertEq(st.redeemableValueWei, 0, "nothing is redeemable");
        assertEq(st.originCount, 10_000, "origins are unchanged");
        assertEq(st.inkGene, geneBefore, "the gene is unchanged");

        // The card is a function of geometry, denomination and gene, none of which moved.
        assertEq(lens.unicodeCard(id), cardBefore, "sacrifice must not change the artwork");
    }
}

/* ==================================================================== *
 *  Ink Genes
 * ==================================================================== */

/// @notice Mint-time gene assignment: stored value matches the pure `InkGenes.geneAtMint`
///         function of the on-chain-derived seed, the `InkGene` event fires with that value,
///         and non-dust mints stay inside the narrow {Sparse, Murk, Dense} band.
contract InkGeneMintTest is ShapesBase {
    function test_MintGeneMatchesInkGenesLibrary() public {
        uint256 id = _mint(alice, DENOMS[0]);
        bytes32 seed = shapes.seedOf(id);
        assertEq(
            shapes.inkGeneOf(id),
            InkGenes.geneAtMint(seed, 0),
            "stored gene does not match InkGenes.geneAtMint"
        );
    }

    /// @dev Recomputes the batch-root/seed derivation `_mintBatch` uses, independently, so this
    ///      does not just trust `seedOf` after the fact.
    function test_MintEmitsInkGeneEvent() public {
        uint256 firstTokenId = shapes.totalMinted();
        bytes32 batchRoot = keccak256(
            abi.encodePacked(
                block.prevrandao,
                blockhash(block.number - 1),
                block.number,
                block.timestamp,
                block.chainid,
                address(shapes),
                firstTokenId
            )
        );
        bytes32 seed = keccak256(abi.encodePacked(batchRoot, firstTokenId));
        uint8 expectedGene = InkGenes.geneAtMint(seed, 4); // 1 ETH -> denomIndex 4

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.InkGene(firstTokenId, expectedGene);
        vm.prank(alice);
        shapes.mint{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4]);

        assertEq(shapes.inkGeneOf(firstTokenId), expectedGene);
        assertEq(shapes.seedOf(firstTokenId), seed);
    }

    /// @notice Every non-dust denomination draws only from {Sparse, Murk, Dense}; the four
    ///         extremes are reachable only through a dust (0.01 ETH) mint.
    function testFuzz_NonDustMintsStoreOnlyTheNarrowBand(uint8 which) public {
        uint256 amount = DENOMS[1 + (which % 8)];
        uint256 id = _mint(alice, amount);
        uint8 gene = shapes.inkGeneOf(id);
        assertTrue(
            gene == InkGenes.SPARSE || gene == InkGenes.MURK || gene == InkGenes.DENSE,
            "non-dust mint stored a gene outside the narrow band"
        );
    }

    /// @notice `mintBatch` assigns each token in the batch its own seed and therefore its own
    ///         independently-drawn gene, not one gene shared by the whole batch.
    function test_MintBatchAssignsIndependentGenes() public {
        vm.prank(alice);
        uint256 first = shapes.mintBatchTo{value: 200 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 200, alice);
        bool sawDifferentGene = false;
        uint8 firstGene = shapes.inkGeneOf(first);
        for (uint256 i = 1; i < 200; ++i) {
            if (shapes.inkGeneOf(first + i) != firstGene) {
                sawDifferentGene = true;
                break;
            }
        }
        assertTrue(sawDifferentGene, "200 independent dust mints all landed on the same gene");
    }
}

/// @notice The compose gene walk, at the real `Shapes.sol` level: order-invariance across the
///         same on-chain token set, homogeneous-pool fixed points at a single tier and at the
///         maximum eight-tier jump, and a gas observation for the 10,000-dust mega-compose.
contract InkGeneComposeTest is ShapesBase {
    /// @dev Mint `qty` dust (0.01 ETH) tokens to alice; ids are `first .. first+qty-1`.
    function _mintDust(uint256 qty) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: qty * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], qty);
    }

    /// @notice The same five tokens (one survivor, four burns), composed in three different
    ///         `burnIds` orders replayed against the identical starting state via
    ///         `vm.snapshotState`/`vm.revertToState`, yield the identical gene. `burnSeedFold` is
    ///         an XOR fold (commutative, associative), so calldata order cannot leak into
    ///         `geneAtCompose`'s output — this is that guarantee proven against real storage and
    ///         real `_burn`s, not just the pure library function.
    function test_ComposeIsOrderInvariantOnChain() public {
        uint256 first = _mintDust(5);
        uint256 survivor = first;

        uint256 snapshot = vm.snapshotState();

        uint256[] memory forward = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            forward[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, forward);
        uint8 geneForward = shapes.inkGeneOf(survivor);

        vm.revertToState(snapshot);

        uint256[] memory reversed = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            reversed[i] = first + 1 + (3 - i);
        }
        vm.prank(alice);
        shapes.compose(survivor, reversed);
        uint8 geneReversed = shapes.inkGeneOf(survivor);

        vm.revertToState(snapshot);

        uint256[] memory shuffled = new uint256[](4);
        shuffled[0] = first + 3;
        shuffled[1] = first + 1;
        shuffled[2] = first + 4;
        shuffled[3] = first + 2;
        vm.prank(alice);
        shapes.compose(survivor, shuffled);
        uint8 geneShuffled = shapes.inkGeneOf(survivor);

        assertEq(geneForward, geneReversed, "reordering burnIds changed the on-chain gene");
        assertEq(geneForward, geneShuffled, "reordering burnIds changed the on-chain gene");
    }

    /// @notice A genuinely homogeneous pool at a single-tier compose (T=1) is a fixed point:
    ///         built by decomposing one dust-gened Shape into children (which `split` copies
    ///         the parent's gene to verbatim) and recomposing four of them — `best == worst ==
    ///         center == survivorGene` by construction, so the walk cannot move the gene.
    function test_ComposeHomogeneousPoolIsFixedPointAtOneTier() public {
        uint256 parent = _mint(alice, DENOMS[1]); // denomIndex 1, 5 units
        uint8 parentGene = shapes.inkGeneOf(parent);

        uint8[] memory outs = new uint8[](5); // 5 x 0.01 (denomIndex 0)
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(shapes.inkGeneOf(kids[i]), parentGene, "split did not copy the gene verbatim");
        }

        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = kids[1 + i];
        }
        vm.prank(alice);
        shapes.compose(kids[0], burn); // 5 x 0.01 -> 0.05: T = 1 - 0 = 1 tier

        assertEq(shapes.inkGeneOf(kids[0]), parentGene, "a uniform pool's gene drifted at T=1");
    }

    /// @notice The maximum possible tier jump (dust to apex, T=8), still with a genuinely
    ///         homogeneous pool: one 100 ETH Shape decomposed into 10,000 x 0.01 dust (all
    ///         inheriting the same gene by construction) and recomposed back into one 100 ETH
    ///         Shape. `best == worst == center == survivorGene` throughout, so eight tiers of
    ///         rolls each target the survivor's own gene and none of them can move it.
    function test_ComposeHomogeneousPoolIsFixedPointAtMaxJump() public {
        uint256 parent = _mint(alice, DENOMS[8]); // denomIndex 8, apex backing
        uint8 parentGene = shapes.inkGeneOf(parent);

        uint8[] memory outs = new uint8[](10_000); // all index 0 (0.01 ETH), defaults to 0
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        assertEq(kids.length, 10_000);
        assertEq(shapes.inkGeneOf(kids[0]), parentGene, "split did not copy the gene verbatim");

        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = kids[1 + i];
        }

        vm.prank(alice);
        shapes.compose(kids[0], burn); // 10,000 x 0.01 -> 100 ETH: T = 8 - 0 = 8 tiers

        assertEq(
            shapes.inkGeneOf(kids[0]),
            parentGene,
            "a uniform pool's gene drifted at the maximum eight-tier jump"
        );
        // Backing round-trips exactly; origins do not re-inflate to 10,000 (the parent's real
        // origin count, 1, is conserved through the split and the recombine, the same
        // non-forgery guarantee `test_ForgeryBlocked_SplitRecombinePreservesCount` covers).
        assertEq(shapes.backingOf(kids[0]), DENOMS[8]);
        assertEq(shapes.originCountOf(kids[0]), 1, "origin count must not re-inflate");
    }

    /// @notice Gas for the 10,000-dust mega-compose, under the same construction the coordinator
    ///         asked about: 10,000 independent direct mints (each drawing its own gene, not a
    ///         forced-homogeneous pool) composed into one apex Complete. Not an assertion on the
    ///         resulting gene — with 10,000 independently-drawn genes the pool is essentially
    ///         never homogeneous — only that the ink-gene bookkeeping added to `compose` does not
    ///         blow past a sane gas ceiling, and a `console.log` of the true number for the
    ///         record.
    function test_ComposeMegaGasProfile_10000Dust() public {
        uint256 first = _mintDust(10_000);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }

        vm.prank(alice);
        uint256 g0 = gasleft();
        uint256 survivor = shapes.compose(first, burn);
        uint256 composeGas = g0 - gasleft();

        console.log("compose(10,000 dust -> 100 ETH) gas", composeGas);

        assertEq(shapes.backingOf(survivor), DENOMS[8]);
        assertEq(shapes.originCountOf(survivor), 10_000);
        assertTrue(shapes.isComplete(survivor));
        // Loose ceiling: this test exists to catch a regression and record the true number, not
        // to micro-optimise. 9,999 burns each touching the ink-gene fields is inherently large, and
        // reversible compose adds a ~52k-gas record per input (~3 storage slots: seed, packed
        // fields, and the input's materialized-modules snapshot, SAMPLING_SPEC.md). Module
        // sampling itself adds a donor array built and sorted over all 10,000 donors (memory, not
        // storage, but memory expansion is quadratic at this size) so the ceiling is raised from
        // the pre-sampling baseline to keep headroom. This 10,000-in-one compose is far past any
        // block gas limit and exists only as a gas-profile datapoint; real merges of this size are
        // built incrementally, each step independently reversible.
        assertLt(composeGas, 1_500_000_000, "10,000-dust mega-compose gas regressed");
    }
}

/// @notice Split: the gene is copied verbatim to every child.
///         recovers the exact pre-split gene alongside the seed and denomination.
contract InkGeneSplitTest is ShapesBase {
    function test_SplitCopiesGeneToEveryChild() public {
        uint256 id = _mint(alice, DENOMS[1]);
        uint8 parentGene = shapes.inkGeneOf(id);

        uint8[] memory outs = new uint8[](5); // 5 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);

        for (uint256 i = 0; i < kids.length; ++i) {
            assertEq(shapes.inkGeneOf(kids[i]), parentGene, "child gene diverged from parent");
        }
    }

    function test_SplitEmitsInkGenePerChild() public {
        uint256 id = _mint(alice, DENOMS[1]);
        uint8 parentGene = shapes.inkGeneOf(id);
        uint256 firstChild = shapes.totalMinted();

        uint8[] memory outs = new uint8[](5);
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.InkGene(firstChild, parentGene);
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.InkGene(firstChild + 1, parentGene);
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.InkGene(firstChild + 2, parentGene);
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.InkGene(firstChild + 3, parentGene);
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.InkGene(firstChild + 4, parentGene);
        vm.prank(alice);
        shapes.split(id, outs);
    }
}

/// @notice `previewCompose` guards that `Composability.t.sol` does not already cover: duplicate
///         burn ids, and the absence of any state change.
contract InkGenePreviewTest is ShapesBase {
    function _mintDust(uint256 qty) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: qty * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], qty);
    }

    function test_PreviewComposeTouchesNoState() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        uint256 snapshot = vm.snapshotState();
        lens.previewCompose(first, burn);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(burn[i]), alice, "previewCompose burned an input");
        }
        assertEq(shapes.totalSupply(), 5, "previewCompose changed totalSupply");
        vm.revertToState(snapshot);
    }

    /// @notice `compose` reaches this through `_burn`; `previewCompose` checks it explicitly.
    function test_PreviewComposeRejectsDuplicateBurnId() public {
        uint256 first = _mintDust(3);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 1;
        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, first + 1));
        lens.previewCompose(first, burn);
    }
}

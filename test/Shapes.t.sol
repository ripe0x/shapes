// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

import {
    BadReceiver,
    EthRejectingReceiver,
    GoodReceiver,
    ReentrantFeeRecipient,
    ReentrantMinter,
    ReentrantRedeemer,
    RevertingFeeRecipient
} from "./mocks/Mocks.sol";

abstract contract ShapesBase is Test {
    uint256 internal constant FEE_BPS = 100; // 1%

    /// @dev The mint fee for a given backing: 1% of it. Exact in wei at every denomination.
    function feeOf(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }

    ShapeRenderer internal renderer;
    Shapes internal shapes;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256[9] internal DENOMS = [
        uint256(0.01 ether),
        0.05 ether,
        0.1 ether,
        0.5 ether,
        1 ether,
        5 ether,
        10 ether,
        50 ether,
        100 ether
    ];

    function setUp() public virtual {
        renderer = new ShapeRenderer();
        shapes = new Shapes(FEE_BPS, feeRecipient, address(renderer));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _mint(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = shapes.mint{value: amount + feeOf(amount)}(amount, who);
    }

    /// @dev The reserve invariant, asserted after anything interesting happens.
    function _assertSolvent() internal view {
        assertGe(
            address(shapes).balance,
            shapes.totalBacking(),
            "contract balance fell below totalBacking"
        );
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

            assertEq(id, i + 1, "token ids are sequential from 1");
            assertEq(shapes.ownerOf(id), alice);
            assertEq(shapes.backingOf(id), DENOMS[i]);
            assertEq(shapes.totalBacking(), expectedBacking);
            assertEq(shapes.totalSupply(), i + 1);
            assertEq(shapes.totalMinted(), i + 1);
        }
        assertEq(address(shapes).balance, expectedBacking, "balance equals backing exactly");
        _assertSolvent();
    }

    function test_TokenIdsStartAtOne() public {
        assertEq(shapes.totalMinted(), 0);
        assertEq(_mint(alice, 1 ether), 1);
    }

    function test_MintToAnotherAddress() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, bob);
        assertEq(shapes.ownerOf(id), bob);
    }

    function test_RevertsOnUnsupportedDenomination() public {
        uint256[6] memory bad =
            [uint256(1), 0.011 ether, 25 ether, 2 ether, 99 ether, 101 ether];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(
                abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, bad[i])
            );
            shapes.mint{value: bad[i] + feeOf(bad[i])}(bad[i], alice);
        }
    }

    function test_RevertsOnZeroBacking() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, 0));
        shapes.mint{value: 0}(0, alice);
    }

    function testFuzz_OnlyLadderAmountsAreAccepted(uint256 amount) public {
        amount = bound(amount, 0, 200 ether);
        bool supported = shapes.isSupportedDenomination(amount);

        vm.deal(alice, amount + feeOf(amount));
        vm.prank(alice);
        if (supported) {
            shapes.mint{value: amount + feeOf(amount)}(amount, alice);
            assertEq(shapes.totalBacking(), amount);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, amount)
            );
            shapes.mint{value: amount + feeOf(amount)}(amount, alice);
            assertEq(shapes.totalBacking(), 0);
        }
        _assertSolvent();
    }

    function test_RequiresExactBackingPlusFee() public {
        vm.startPrank(alice);

        vm.expectRevert(
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether)
        );
        shapes.mint{value: 1 ether}(1 ether, alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether + feeOf(1 ether) - 1
            )
        );
        shapes.mint{value: 1 ether + feeOf(1 ether) - 1}(1 ether, alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether + feeOf(1 ether) + 1
            )
        );
        shapes.mint{value: 1 ether + feeOf(1 ether) + 1}(1 ether, alice);

        vm.stopPrank();
        assertEq(shapes.totalBacking(), 0);
    }

    function testFuzz_AnyIncorrectValueReverts(uint256 sent) public {
        uint256 required = 1 ether + feeOf(1 ether);
        vm.assume(sent != required);
        sent = bound(sent, 0, 500 ether);
        vm.assume(sent != required);

        vm.deal(alice, sent);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, required, sent)
        );
        shapes.mint{value: sent}(1 ether, alice);
    }

    function test_BatchRequiresExactAggregate() public {
        uint256 qty = 10;
        uint256 required = qty * (1 ether + feeOf(1 ether));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, required, required - 1)
        );
        shapes.mintBatch{value: required - 1}(1 ether, qty, alice);

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: required}(1 ether, qty, alice);

        assertEq(first, 1);
        assertEq(shapes.totalMinted(), qty);
        assertEq(shapes.totalSupply(), qty);
        assertEq(shapes.totalBacking(), qty * 1 ether, "fees are not part of backing");
        assertEq(address(shapes).balance, qty * 1 ether);
        assertEq(feeRecipient.balance, qty * feeOf(1 ether), "aggregate fee forwarded once");
    }

    function test_BatchGivesUniqueIdsAndSeeds() public {
        uint256 qty = 25;
        vm.prank(alice);
        uint256 first =
            shapes.mintBatch{value: qty * (0.1 ether + feeOf(0.1 ether))}(0.1 ether, qty, alice);

        bytes32[] memory seen = new bytes32[](qty);
        for (uint256 i = 0; i < qty; ++i) {
            uint256 id = first + i;
            assertEq(shapes.ownerOf(id), alice);
            assertEq(shapes.backingOf(id), 0.1 ether);

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
        shapes.mintBatch{value: 0}(1 ether, 0, alice);
    }

    function test_MintToContractReceiver() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        assertEq(shapes.ownerOf(id), address(r));
    }

    function test_MintToNonReceiverReverts() public {
        BadReceiver r = new BadReceiver();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(r))
        );
        shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        assertEq(shapes.totalBacking(), 0, "failed mint leaves no accounting behind");
    }

    function test_MintToZeroAddressReverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0))
        );
        shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(0));
    }
}

/* ==================================================================== *
 *  Fees
 * ==================================================================== */

contract FeeTest is ShapesBase {
    function test_FeesReachRecipientAndNeverJoinBacking() public {
        _mint(alice, 100 ether);
        assertEq(feeRecipient.balance, feeOf(100 ether), "1% of 100 ETH");
        assertEq(feeRecipient.balance, 1 ether);
        assertEq(shapes.totalBacking(), 100 ether);
        assertEq(address(shapes).balance, 100 ether);

        _mint(alice, 0.01 ether);
        assertEq(
            feeRecipient.balance,
            feeOf(100 ether) + feeOf(0.01 ether),
            "fee is 1% of each backing, not flat"
        );
        assertEq(shapes.totalBacking(), 100.01 ether);
        assertEq(address(shapes).balance, 100.01 ether);
    }

    function test_FeeIsOnePercentAtEveryDenomination() public {
        for (uint256 i = 0; i < 9; ++i) {
            uint256 before = feeRecipient.balance;
            _mint(alice, DENOMS[i]);
            assertEq(
                feeRecipient.balance - before,
                DENOMS[i] / 100,
                "fee is exactly 1% of backing at every denomination"
            );
        }
    }

    function test_ZeroFeeIsSupported() public {
        Shapes free = new Shapes(0, feeRecipient, address(renderer));
        vm.prank(alice);
        uint256 id = free.mint{value: 1 ether}(1 ether, alice);
        assertEq(free.backingOf(id), 1 ether);
        assertEq(feeRecipient.balance, 0);
    }

    function test_RevertingFeeRecipientBlocksMintingButNotRedemption() public {
        RevertingFeeRecipient bad = new RevertingFeeRecipient();
        Shapes s = new Shapes(FEE_BPS, address(bad), address(renderer));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.MintFeeTransferFailed.selector, address(bad), feeOf(1 ether)
            )
        );
        s.mint{value: 1 ether + feeOf(1 ether)}(1 ether, alice);

        // With a zero fee there is no transfer at all, so the same recipient is harmless and
        // redemption is provably independent of the fee path.
        Shapes s0 = new Shapes(0, address(bad), address(renderer));
        vm.startPrank(alice);
        uint256 id = s0.mint{value: 1 ether}(1 ether, alice);
        uint256 before = alice.balance;
        s0.redeem(id);
        vm.stopPrank();
        assertEq(alice.balance - before, 1 ether);
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(bytes("fee recipient is zero"));
        new Shapes(FEE_BPS, address(0), address(renderer));

        vm.expectRevert(bytes("renderer is zero"));
        new Shapes(FEE_BPS, feeRecipient, address(0));
    }

    function test_ImmutablesAreExposedAndFixed() public view {
        assertEq(shapes.feeBps(), FEE_BPS);
        assertEq(shapes.mintFeeFor(1 ether), 0.01 ether);
        assertEq(shapes.feeRecipient(), feeRecipient);
        assertEq(shapes.renderer(), address(renderer));
    }
}

/* ==================================================================== *
 *  Transfer and redemption
 * ==================================================================== */

contract RedeemTest is ShapesBase {
    function test_OwnerRedeemsExactBacking() public {
        uint256 id = _mint(alice, 5 ether);
        uint256 before = alice.balance;

        vm.prank(alice);
        shapes.redeem(id);

        assertEq(alice.balance - before, 5 ether, "exactly the wrapped amount, no fee taken");
        assertEq(shapes.totalBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        assertEq(shapes.totalMinted(), 1, "totalMinted is monotonic");
        assertEq(address(shapes).balance, 0);
    }

    function test_RedeemedTokenNoLongerExists() public {
        uint256 id = _mint(alice, 1 ether);
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
        uint256 id = _mint(alice, 10 ether);

        vm.prank(alice);
        shapes.transferFrom(alice, bob, id);
        assertEq(shapes.ownerOf(id), bob);
        assertEq(shapes.backingOf(id), 10 ether, "backing follows the token");

        // the previous owner has lost the right
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, alice));
        shapes.redeem(id);

        uint256 before = bob.balance;
        vm.prank(bob);
        shapes.redeem(id);
        assertEq(bob.balance - before, 10 ether);
    }

    function test_NonOwnerCannotRedeem() public {
        uint256 id = _mint(alice, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.redeem(id);
        assertEq(shapes.totalBacking(), 1 ether);
    }

    /// @dev Approval grants the right to move a Shape, never the right to unwrap it.
    function test_ApprovedSpenderCannotRedeem() public {
        uint256 id = _mint(alice, 1 ether);

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
        uint256[4] memory amounts =
            [uint256(0.01 ether), 0.5 ether, 5 ether, 50 ether];
        for (uint256 i = 0; i < 4; ++i) {
            ids[i] = _mint(alice, amounts[i]);
            total += amounts[i];
        }
        assertEq(shapes.totalBacking(), total);

        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 paid = shapes.redeemBatch(ids);

        assertEq(paid, total);
        assertEq(alice.balance - before, total, "one aggregate transfer of the exact total");
        assertEq(shapes.totalBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        assertEq(address(shapes).balance, 0);
    }

    function test_RedeemBatchRejectsForeignToken() public {
        uint256 a = _mint(alice, 1 ether);
        uint256 b = _mint(bob, 1 ether);

        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, b, alice));
        shapes.redeemBatch(ids);

        assertEq(shapes.totalBacking(), 2 ether, "nothing settled on a reverted batch");
        assertEq(shapes.ownerOf(a), alice);
    }

    function test_RedeemBatchRejectsDuplicates() public {
        uint256 id = _mint(alice, 1 ether);
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.redeemBatch(ids);

        assertEq(shapes.totalBacking(), 1 ether, "no double spend");
        assertEq(address(shapes).balance, 1 ether);
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
        uint256 id = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));

        vm.expectRevert(
            abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(r), 1 ether)
        );
        r.redeem(shapes, id);

        assertEq(shapes.ownerOf(id), address(r), "token survives a failed payout");
        assertEq(shapes.backingOf(id), 1 ether);
        assertEq(shapes.totalBacking(), 1 ether);
        _assertSolvent();
    }

    function test_ContractOwnerCanRedeem() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        uint256 id = shapes.mint{value: 50 ether + feeOf(50 ether)}(50 ether, address(r));

        r.redeem(shapes, id);
        assertEq(address(r).balance, 50 ether);
        assertEq(shapes.totalBacking(), 0);
    }

    function testFuzz_RedemptionReturnsExactlyBacking(uint8 which, address to) public {
        vm.assume(to != address(0) && to.code.length == 0 && to != address(shapes));
        assumeNotPrecompile(to);
        uint256 amount = DENOMS[which % 9];

        vm.deal(alice, amount + feeOf(amount));
        vm.prank(alice);
        uint256 id = shapes.mint{value: amount + feeOf(amount)}(amount, to);

        uint256 before = to.balance;
        vm.prank(to);
        shapes.redeem(id);

        assertEq(to.balance - before, amount);
        assertEq(shapes.totalBacking(), 0);
        assertEq(address(shapes).balance, 0);
    }
}

/* ==================================================================== *
 *  Reserve security
 * ==================================================================== */

contract ReserveTest is ShapesBase {
    function test_DirectEthTransfersRevert() public {
        vm.deal(alice, 1 ether);

        vm.prank(alice);
        (bool ok, bytes memory ret) = address(shapes).call{value: 1 ether}("");
        assertFalse(ok, "plain transfer must revert");
        assertEq(bytes4(ret), IShapes.DirectDepositRejected.selector);

        vm.prank(alice);
        (ok, ret) = address(shapes).call{value: 1 ether}(hex"12345678");
        assertFalse(ok, "unknown selector with value must revert");
        assertEq(bytes4(ret), IShapes.DirectDepositRejected.selector);

        assertEq(address(shapes).balance, 0);
    }

    function test_UnknownSelectorsRevertEvenWithoutValue() public {
        // The only administrative power is the cosmetic renderer (owned, lockable). No function
        // reaches the reserve, the fee terms, or a holder's token. This is a sample of the
        // economic administrative surface Shapes deliberately lacks.
        string[8] memory absent = [
            "withdraw()",
            "withdrawAll()",
            "emergencyWithdraw()",
            "pause()",
            "setFeeBps(uint256)",
            "setFeeRecipient(address)",
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
        uint256 id = _mint(alice, 1 ether);

        vm.deal(address(shapes), address(shapes).balance + 3 ether);
        assertEq(address(shapes).balance, 4 ether);
        assertEq(shapes.totalBacking(), 1 ether, "forced ETH does not become backing");
        _assertSolvent();

        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);

        assertEq(alice.balance - before, 1 ether, "redeemer gets backing, not the surplus");
        assertEq(address(shapes).balance, 3 ether, "surplus stays stranded");
        assertEq(shapes.totalBacking(), 0);
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
        uint256 a = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        uint256 b = shapes.mint{value: 5 ether + feeOf(5 ether)}(5 ether, address(r));
        vm.stopPrank();

        r.arm(b, false);
        r.redeem(a);

        assertTrue(r.attempted(), "the callback ran");
        assertTrue(r.reentryReverted(), "re-entry into redeem must revert");
        assertEq(address(r).balance, 1 ether, "only the first token settled");
        assertEq(shapes.ownerOf(b), address(r), "the second token is untouched");
        assertEq(shapes.totalBacking(), 5 ether);
        assertEq(address(shapes).balance, 5 ether);
        _assertSolvent();
    }

    function test_ReentrantRedeemBatchIsBlocked() public {
        ReentrantRedeemer r = new ReentrantRedeemer(IShapes(address(shapes)));
        vm.startPrank(alice);
        uint256 a = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        uint256 b = shapes.mint{value: 5 ether + feeOf(5 ether)}(5 ether, address(r));
        vm.stopPrank();

        r.arm(b, true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = a;
        r.redeemBatch(ids);

        assertTrue(r.reentryReverted(), "re-entry into redeemBatch must revert");
        assertEq(shapes.totalBacking(), 5 ether);
        _assertSolvent();
    }

    function test_ReentrantMintFromReceiverCallbackIsBlocked() public {
        ReentrantMinter m = new ReentrantMinter(IShapes(address(shapes)), 1 ether);
        vm.deal(address(m), 10 ether);

        m.mint{value: 1 ether + feeOf(1 ether)}();

        assertTrue(m.attempted(), "the receiver callback ran");
        assertTrue(m.reentryReverted(), "re-entry into mint must revert");
        assertEq(shapes.totalSupply(), 1, "exactly one token exists");
        assertEq(shapes.totalMinted(), 1);
        assertEq(shapes.totalBacking(), 1 ether);
        assertEq(address(shapes).balance, 1 ether);
        _assertSolvent();
    }

    function test_ReentrantMintFromFeeRecipientIsBlocked() public {
        ReentrantFeeRecipient fr = new ReentrantFeeRecipient();
        Shapes s = new Shapes(FEE_BPS, address(fr), address(renderer));
        fr.configure(IShapes(address(s)), 1 ether);
        vm.deal(address(fr), 10 ether);

        vm.prank(alice);
        s.mint{value: 1 ether + feeOf(1 ether)}(1 ether, alice);

        assertTrue(fr.attempted(), "the fee callback ran");
        assertTrue(fr.reentryReverted(), "re-entry from the fee recipient must revert");
        assertEq(s.totalSupply(), 1);
        assertEq(s.totalBacking(), 1 ether);
        assertEq(address(s).balance, 1 ether);
        assertGe(address(s).balance, s.totalBacking());
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
            (uint256 c, uint256 r) = shapes.gridForAmount(DENOMS[i]);
            assertEq(c, expectedCols[i]);
            assertEq(r, expectedRows[i]);
            assertEq(shapes.modulesForAmount(DENOMS[i]), c * r);
        }
    }

    /// @dev The whole point of the ladder: value up, complexity down, strictly.
    function test_ModuleCountStrictlyDecreasesWithValue() public view {
        uint256 previous = type(uint256).max;
        for (uint256 i = 0; i < 9; ++i) {
            uint256 m = shapes.modulesForAmount(DENOMS[i]);
            assertLt(m, previous, "modules must fall as value rises");
            previous = m;
        }
        assertEq(shapes.modulesForAmount(DENOMS[0]), 25);
        assertEq(shapes.modulesForAmount(DENOMS[8]), 1);
    }

    function test_GridForUnsupportedAmountReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(Denominations.UnsupportedDenomination.selector, 2 ether)
        );
        shapes.gridForAmount(2 ether);
    }

    function test_IsSupportedDenomination() public view {
        for (uint256 i = 0; i < 9; ++i) {
            assertTrue(shapes.isSupportedDenomination(DENOMS[i]));
        }
        assertFalse(shapes.isSupportedDenomination(0));
        assertFalse(shapes.isSupportedDenomination(2 ether));
        assertFalse(shapes.isSupportedDenomination(1 ether + 1));
        assertFalse(shapes.isSupportedDenomination(type(uint256).max));
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
 *  Renderer replacement and lock
 * ==================================================================== */

contract RendererAdminTest is ShapesBase {
    // ShapesBase deploys `shapes` from this test contract, so it is the owner.
    function test_DeployerIsOwnerAndRendererStartsUnlocked() public view {
        assertEq(shapes.owner(), address(this));
        assertEq(shapes.renderer(), address(renderer));
        assertFalse(shapes.rendererLocked());
    }

    function test_OwnerCanReplaceTheRenderer() public {
        uint256 id = _mint(alice, 1 ether);
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

    function test_SetRendererIsOwnerOnly() public {
        ShapeRenderer next = new ShapeRenderer();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setRenderer(address(next));
    }

    function test_SetRendererRejectsCodelessAddress() public {
        vm.expectRevert(bytes("renderer has no code"));
        shapes.setRenderer(alice); // an EOA

        vm.expectRevert(bytes("renderer is zero"));
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

    function test_LockIsOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.lockRenderer();
    }

    /// @notice The renderer is cosmetic: replacing it never touches backing or redemption.
    function test_ReplacingRendererDoesNotAffectFunds() public {
        uint256 id = _mint(alice, 5 ether);
        assertEq(shapes.backingOf(id), 5 ether);

        // Point the renderer at an EOA-free contract with no metadata path would be refused, so
        // swap to another valid renderer, then prove redemption still pays exactly the backing.
        shapes.setRenderer(address(new ShapeRenderer()));

        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance - before, 5 ether, "renderer swap changed the payout");
        _assertSolvent();
    }

    function test_OwnerCanRenounce() public {
        shapes.renounceOwnership();
        assertEq(shapes.owner(), address(0));

        // With no owner, the renderer can no longer be changed — same as locking, via a
        // different route.
        ShapeRenderer next = new ShapeRenderer();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        shapes.setRenderer(address(next));
    }
}

/* ==================================================================== *
 *  Recomposition (compose / decompose)
 * ==================================================================== */

contract RecompositionTest is ShapesBase {
    /// @dev Mint `qty` tokens of `amount` to alice; ids are `first .. first+qty-1`.
    function _mintMany(uint256 amount, uint256 qty) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: qty * (amount + feeOf(amount))}(amount, qty, alice);
    }

    /// @dev A genuine Complete 0.05: five 0.01 direct mints composed into one.
    function _buildComplete005() internal returns (uint256 survivor) {
        uint256 first = _mintMany(0.01 ether, 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) burn[i] = first + 1 + i;
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    function test_ComposeCombinesBackingAndOrigins() public {
        uint256 first = _mintMany(0.01 ether, 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) burn[i] = first + 1 + i;

        vm.prank(alice);
        uint256 outId = shapes.compose(first, burn);

        assertEq(outId, first, "survivor keeps its id");
        assertEq(shapes.backingOf(first), 0.05 ether, "backing summed to 0.05");
        assertEq(shapes.originCountOf(first), 5, "origins summed");
        assertTrue(shapes.isComplete(first), "5 origins on 0.05 is Complete");
        assertEq(shapes.totalSupply(), 1, "four inputs burned");
        assertEq(shapes.totalBacking(), 0.05 ether, "reserve conserved");
        _assertSolvent();
        vm.expectRevert();
        shapes.ownerOf(first + 1);
    }

    function test_ComposeKeepsSurvivorSeed() public {
        uint256 first = _mintMany(0.01 ether, 5);
        bytes32 seed = shapes.seedOf(first);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) burn[i] = first + 1 + i;
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(shapes.seedOf(first), seed, "seed unchanged through compose");
    }

    function test_ComposeRejectsInvalidSum() public {
        uint256 first = _mintMany(0.01 ether, 3); // 0.03 is not a denomination
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 2;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedDenomination.selector, 0.03 ether));
        shapes.compose(first, burn);
    }

    function test_ComposeRejectsNonOwnerInput() public {
        uint256 a = _mint(alice, 0.01 ether);
        vm.prank(bob);
        uint256 b = shapes.mint{value: 0.01 ether + feeOf(0.01 ether)}(0.01 ether, bob);
        uint256[] memory burn = new uint256[](1);
        burn[0] = b;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, b, alice));
        shapes.compose(a, burn);
    }

    function test_ComposeRejectsSelf() public {
        uint256 first = _mintMany(0.01 ether, 2);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first; // survivor cannot be in its own burn set
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, first));
        shapes.compose(first, burn);
    }

    function test_ComposeRejectsDuplicate() public {
        uint256 first = _mintMany(0.01 ether, 5);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 1; // duplicate: second _burn hits a nonexistent token
        vm.prank(alice);
        vm.expectRevert();
        shapes.compose(first, burn);
    }

    function test_ComposeRejectsEmpty() public {
        uint256 a = _mint(alice, 0.01 ether);
        uint256[] memory burn = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(IShapes.EmptyRecomposition.selector);
        shapes.compose(a, burn);
    }

    function test_DecomposeSplitsAndBurnsInput() public {
        uint256 id = _mint(alice, 0.05 ether); // direct, originCount 1
        uint8[] memory outs = new uint8[](5); // 5 x 0.01 (index 0)
        vm.prank(alice);
        uint256[] memory kids = shapes.decompose(id, outs);

        assertEq(kids.length, 5);
        vm.expectRevert();
        shapes.ownerOf(id); // input burned

        assertEq(shapes.originCountOf(kids[0]), 1, "survivor-first fill");
        assertEq(shapes.originCountOf(kids[1]), 0);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(shapes.backingOf(kids[i]), 0.01 ether);
            assertEq(shapes.ownerOf(kids[i]), alice);
        }
        assertEq(shapes.totalBacking(), 0.05 ether, "reserve conserved");
        assertEq(shapes.totalSupply(), 5);
        _assertSolvent();
    }

    function test_DecomposeChildSeedsAreDeterministic() public {
        uint256 id = _mint(alice, 0.05 ether);
        bytes32 parentSeed = shapes.seedOf(id);
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.decompose(id, outs);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(
                shapes.seedOf(kids[i]),
                keccak256(abi.encodePacked(parentSeed, i)),
                "child seed derived from parent"
            );
        }
    }

    function test_DecomposeRejectsBadSum() public {
        uint256 id = _mint(alice, 0.1 ether);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 0;
        outs[1] = 0; // 0.02 != 0.1
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.DecompositionMismatch.selector, 0.1 ether, 0.02 ether)
        );
        shapes.decompose(id, outs);
    }

    function test_DecomposeRejectsSingleOutput() public {
        uint256 id = _mint(alice, 0.05 ether);
        uint8[] memory outs = new uint8[](1);
        outs[0] = 1;
        vm.prank(alice);
        vm.expectRevert(IShapes.EmptyRecomposition.selector);
        shapes.decompose(id, outs);
    }

    function test_ForgeryBlocked_SplitRecombinePreservesCount() public {
        uint256 id = _mint(alice, 0.1 ether); // direct, originCount 1
        uint8[] memory outs = new uint8[](10); // 10 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.decompose(id, outs);

        uint256[] memory burn = new uint256[](9);
        for (uint256 i = 0; i < 9; i++) burn[i] = kids[i + 1];
        vm.prank(alice);
        uint256 outId = shapes.compose(kids[0], burn);

        assertEq(shapes.backingOf(outId), 0.1 ether);
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

        assertEq(shapes.backingOf(a), 0.1 ether);
        assertEq(shapes.originCountOf(a), 10);
        assertTrue(shapes.isComplete(a), "composing Completes yields a Complete");
    }

    function test_LoneMinTierIsNotComplete() public {
        uint256 id = _mint(alice, 0.01 ether); // units == 1
        assertFalse(shapes.isComplete(id), "tier 0 is Direct, never Complete");
    }

    function test_NoFeeChargedOnRecompose() public {
        uint256 first = _mintMany(0.01 ether, 5);
        uint256 afterMint = feeRecipient.balance;
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) burn[i] = first + 1 + i;
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(feeRecipient.balance, afterMint, "compose charged no fee");

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        shapes.decompose(first, outs);
        assertEq(feeRecipient.balance, afterMint, "decompose charged no fee");
    }

    function test_SupportsErc4906() public view {
        assertTrue(shapes.supportsInterface(0x49064906));
    }
}

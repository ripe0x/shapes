// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
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
    HostileGasResolver
} from "./mocks/Mocks.sol";

abstract contract ShapesBase is Test {
    uint256 internal constant FEE_BPS = 100; // 1%

    /// @dev The mint fee for a given backing: 1% of it. Exact in wei at every denomination.
    function feeOf(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }

    ShapeRenderer internal renderer;

    ShapeCollection internal collection;
    Shapes internal shapes;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256[9] internal DENOMS = [
        uint256(0.01 ether), 0.05 ether, 0.1 ether, 0.5 ether, 1 ether, 5 ether, 10 ether, 50 ether, 100 ether
    ];

    address internal titleHolder = makeAddr("titleHolder");


    function setUp() public virtual {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(FEE_BPS, feeRecipient, address(renderer), address(collection), titleHolder);
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

            assertEq(id, i, "token ids are sequential from 0");
            assertEq(shapes.ownerOf(id), alice);
            assertEq(shapes.backingOf(id), DENOMS[i]);
            assertEq(shapes.redeemableBacking(), expectedBacking);
            assertEq(shapes.totalSupply(), i + 1);
            assertEq(shapes.totalMinted(), i + 1);
        }
        assertEq(address(shapes).balance, expectedBacking, "balance equals backing exactly");
        _assertSolvent();
    }

    function test_TokenIdsStartAtZero() public {
        assertEq(shapes.totalMinted(), 0);
        assertEq(_mint(alice, 1 ether), 0, "the first Shape is #0");
        assertEq(shapes.totalMinted(), 1, "totalMinted counts ids issued, not the highest one");
        assertEq(_mint(alice, 1 ether), 1);
    }

    function test_MintToAnotherAddress() public {
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, bob);
        assertEq(shapes.ownerOf(id), bob);
    }

    function test_RevertsOnUnsupportedDenomination() public {
        uint256[6] memory bad = [uint256(1), 0.011 ether, 25 ether, 2 ether, 99 ether, 101 ether];
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
        bool supported = shapes.isSupportedDenomination(amount);

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
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether)
        );
        shapes.mintTo{value: 1 ether}(1 ether, alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether + feeOf(1 ether) - 1
            )
        );
        shapes.mintTo{value: 1 ether + feeOf(1 ether) - 1}(1 ether, alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether + feeOf(1 ether) + 1
            )
        );
        shapes.mintTo{value: 1 ether + feeOf(1 ether) + 1}(1 ether, alice);

        vm.stopPrank();
        assertEq(shapes.redeemableBacking(), 0);
    }

    function testFuzz_AnyIncorrectValueReverts(uint256 sent) public {
        uint256 required = 1 ether + feeOf(1 ether);
        vm.assume(sent != required);
        sent = bound(sent, 0, 500 ether);
        vm.assume(sent != required);

        vm.deal(alice, sent);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.IncorrectPayment.selector, required, sent));
        shapes.mintTo{value: sent}(1 ether, alice);
    }

    function test_BatchRequiresExactAggregate() public {
        uint256 qty = 10;
        uint256 required = qty * (1 ether + feeOf(1 ether));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.IncorrectPayment.selector, required, required - 1));
        shapes.mintBatchTo{value: required - 1}(1 ether, qty, alice);

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: required}(1 ether, qty);

        assertEq(first, 0);
        assertEq(shapes.totalMinted(), qty);
        assertEq(shapes.totalSupply(), qty);
        assertEq(shapes.redeemableBacking(), qty * 1 ether, "fees are not part of backing");
        assertEq(address(shapes).balance, qty * 1 ether);
        assertEq(feeRecipient.balance, qty * feeOf(1 ether), "aggregate fee forwarded once");
    }

    function test_BatchGivesUniqueIdsAndSeeds() public {
        uint256 qty = 25;
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: qty * (0.1 ether + feeOf(0.1 ether))}(0.1 ether, qty);

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
        shapes.mintBatchTo{value: 0}(1 ether, 0, alice);
    }

    function test_MintToContractReceiver() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        assertEq(shapes.ownerOf(id), address(r));
    }

    function test_MintToNonReceiverReverts() public {
        BadReceiver r = new BadReceiver();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(r)));
        shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        assertEq(shapes.redeemableBacking(), 0, "failed mint leaves no accounting behind");
    }

    function test_MintToZeroAddressReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0)));
        shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, address(0));
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
        assertEq(shapes.redeemableBacking(), 100 ether);
        assertEq(address(shapes).balance, 100 ether);

        _mint(alice, 0.01 ether);
        assertEq(
            feeRecipient.balance, feeOf(100 ether) + feeOf(0.01 ether), "fee is 1% of each backing, not flat"
        );
        assertEq(shapes.redeemableBacking(), 100.01 ether);
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
        Shapes free = new Shapes(0, feeRecipient, address(renderer), address(collection), titleHolder);
        vm.prank(alice);
        uint256 id = free.mintTo{value: 1 ether}(1 ether, alice);
        assertEq(free.backingOf(id), 1 ether);
        assertEq(feeRecipient.balance, 0);
    }

    function test_RevertingFeeRecipientBlocksMintingButNotRedemption() public {
        RevertingFeeRecipient bad = new RevertingFeeRecipient();
        Shapes s = new Shapes(FEE_BPS, address(bad), address(renderer), address(collection), titleHolder);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.MintFeeTransferFailed.selector, address(bad), feeOf(1 ether))
        );
        s.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, alice);

        // With a zero fee there is no transfer at all, so the same recipient is harmless and
        // redemption is provably independent of the fee path.
        Shapes s0 = new Shapes(0, address(bad), address(renderer), address(collection), titleHolder);
        vm.startPrank(alice);
        uint256 id = s0.mintTo{value: 1 ether}(1 ether, alice);
        uint256 before = alice.balance;
        s0.redeem(id);
        vm.stopPrank();
        assertEq(alice.balance - before, 1 ether);
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(bytes("fee recipient is zero"));
        new Shapes(FEE_BPS, address(0), address(renderer), address(collection), titleHolder);

        vm.expectRevert(bytes("renderer is zero"));
        new Shapes(FEE_BPS, feeRecipient, address(0), address(collection), titleHolder);
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
        assertEq(shapes.redeemableBacking(), 0);
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
        assertEq(shapes.redeemableBacking(), 1 ether);
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
        uint256[4] memory amounts = [uint256(0.01 ether), 0.5 ether, 5 ether, 50 ether];
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

        assertEq(shapes.redeemableBacking(), 2 ether, "nothing settled on a reverted batch");
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

        assertEq(shapes.redeemableBacking(), 1 ether, "no double spend");
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
        uint256 id = shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));

        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(r), 1 ether));
        r.redeem(shapes, id);

        assertEq(shapes.ownerOf(id), address(r), "token survives a failed payout");
        assertEq(shapes.backingOf(id), 1 ether);
        assertEq(shapes.redeemableBacking(), 1 ether);
        _assertSolvent();
    }

    function test_ContractOwnerCanRedeem() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        uint256 id = shapes.mintTo{value: 50 ether + feeOf(50 ether)}(50 ether, address(r));

        r.redeem(shapes, id);
        assertEq(address(r).balance, 50 ether);
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
        assertEq(shapes.redeemableBacking(), 1 ether, "forced ETH does not become backing");
        _assertSolvent();

        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);

        assertEq(alice.balance - before, 1 ether, "redeemer gets backing, not the surplus");
        assertEq(address(shapes).balance, 3 ether, "surplus stays stranded");
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
        uint256 a = shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        uint256 b = shapes.mintTo{value: 5 ether + feeOf(5 ether)}(5 ether, address(r));
        vm.stopPrank();

        r.arm(b, false);
        r.redeem(a);

        assertTrue(r.attempted(), "the callback ran");
        assertTrue(r.reentryReverted(), "re-entry into redeem must revert");
        assertEq(address(r).balance, 1 ether, "only the first token settled");
        assertEq(shapes.ownerOf(b), address(r), "the second token is untouched");
        assertEq(shapes.redeemableBacking(), 5 ether);
        assertEq(address(shapes).balance, 5 ether);
        _assertSolvent();
    }

    function test_ReentrantRedeemBatchIsBlocked() public {
        ReentrantRedeemer r = new ReentrantRedeemer(IShapes(address(shapes)));
        vm.startPrank(alice);
        uint256 a = shapes.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, address(r));
        uint256 b = shapes.mintTo{value: 5 ether + feeOf(5 ether)}(5 ether, address(r));
        vm.stopPrank();

        r.arm(b, true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = a;
        r.redeemBatch(ids);

        assertTrue(r.reentryReverted(), "re-entry into redeemBatch must revert");
        assertEq(shapes.redeemableBacking(), 5 ether);
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
        assertEq(shapes.redeemableBacking(), 1 ether);
        assertEq(address(shapes).balance, 1 ether);
        _assertSolvent();
    }

    function test_ReentrantMintFromFeeRecipientIsBlocked() public {
        ReentrantFeeRecipient fr = new ReentrantFeeRecipient();
        Shapes s = new Shapes(FEE_BPS, address(fr), address(renderer), address(collection), titleHolder);
        fr.configure(IShapes(address(s)), 1 ether);
        vm.deal(address(fr), 10 ether);

        vm.prank(alice);
        s.mintTo{value: 1 ether + feeOf(1 ether)}(1 ether, alice);

        assertTrue(fr.attempted(), "the fee callback ran");
        assertTrue(fr.reentryReverted(), "re-entry from the fee recipient must revert");
        assertEq(s.totalSupply(), 1);
        assertEq(s.redeemableBacking(), 1 ether);
        assertEq(address(s).balance, 1 ether);
        assertGe(address(s).balance, s.redeemableBacking());
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
        vm.expectRevert(abi.encodeWithSelector(Denominations.UnsupportedDenomination.selector, 2 ether));
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
        uint256 first = shapes.mintBatch{value: 5 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + 1 + i;
        }

        vm.prank(alice);
        shapes.compose(first, burnIds);

        assertEq(shapes.valueOf(first), 0.05 ether);
        assertEq(shapes.valueOf(first), shapes.backingOf(first));
        for (uint256 i = 0; i < burnIds.length; ++i) {
            _expectBothNonexistent(burnIds[i]);
        }
    }

    function test_ValueOfTracksSplit() public {
        uint256 parent = _mint(alice, 1 ether);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 3;
        outs[1] = 3;

        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        _expectBothNonexistent(parent);
        assertEq(shapes.valueOf(kids[0]), 0.5 ether);
        assertEq(shapes.valueOf(kids[1]), 0.5 ether);
    }

    function test_ValueOfRedeemedTokenMatchesBackingRevert() public {
        uint256 id = _mint(alice, 5 ether);
        vm.prank(alice);
        shapes.redeem(id);
        _expectBothNonexistent(id);
    }

    function test_ValueOfChangesNoStateOrEthAccounting() public {
        uint256 id = _mint(alice, 10 ether);
        uint256 balanceBefore = address(shapes).balance;
        uint256 backingBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();
        uint256 mintedBefore = shapes.totalMinted();
        address ownerBefore = shapes.ownerOf(id);
        bytes32 seedBefore = shapes.seedOf(id);
        uint256 originsBefore = shapes.originCountOf(id);
        uint8 geneBefore = shapes.inkGeneOf(id);

        assertEq(shapes.valueOf(id), 10 ether);

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

        uint256 id = _mint(alice, 5 ether);
        uint256 before = alice.balance;
        vm.expectEmit(true, true, true, true, address(shapes));
        emit IERC721.Transfer(alice, address(0), id);
        vm.prank(alice);
        shapes.burn(id);

        assertEq(alice.balance - before, 5 ether);
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        _expectBothNonexistent(id);
    }

    function test_BurnIsOwnerOnlyEvenWhenOperatorIsApproved() public {
        uint256 id = _mint(alice, 1 ether);
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

        uint256 id = _mint(alice, 0.01 ether);
        vm.prank(alice);
        shapes.burn(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.burn(id);
    }

    function test_TerminalIdsStayRetiredWhileDecomposeRevivesComposeInputs() public {
        uint256 redeemed = _mint(alice, 0.01 ether);
        assertEq(redeemed, 0);
        vm.prank(alice);
        shapes.redeem(redeemed);

        uint256 parent = _mint(alice, 0.05 ether);
        assertEq(parent, 1);
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        assertEq(kids[0], 2);
        assertEq(kids[4], 6);

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 5);
        assertEq(first, 7);
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
        assertEq(shapes.totalMinted(), 12);

        uint256 next = _mint(alice, 0.01 ether);
        assertEq(next, 12, "redeem and split never recycle a retired id");
        assertEq(shapes.totalMinted(), 13);
    }
}

/* ==================================================================== *
 *  Optional position resolver
 * ==================================================================== */

contract PositionResolverTest is ShapesBase {
    function test_ResolverStartsEmptyAndQueriesReturnZeroForAnyId() public view {
        assertEq(shapes.positionResolver(), address(0));
        assertFalse(shapes.positionResolverLocked());
        assertEq(shapes.positionOf(1), address(0));
        assertEq(shapes.positionOf(type(uint256).max), address(0));
    }

    function test_OwnerSetsExactResolverResultsAndEvent() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setPosition(1, alice);
        resolver.setPosition(99, address(renderer));

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.PositionResolverSet(address(resolver));
        shapes.setPositionResolver(address(resolver));

        assertEq(shapes.positionResolver(), address(resolver));
        assertEq(shapes.positionOf(1), alice);
        assertEq(shapes.positionOf(2), address(0));
        assertEq(shapes.positionOf(99), address(renderer));
    }

    function test_ResolverCanBeReplacedAndClearedUntilLocked() public {
        MockPositionResolver first = new MockPositionResolver();
        MockPositionResolver second = new MockPositionResolver();
        first.setPosition(1, alice);
        second.setPosition(1, bob);

        shapes.setPositionResolver(address(first));
        assertEq(shapes.positionOf(1), alice);
        shapes.setPositionResolver(address(second));
        assertEq(shapes.positionOf(1), bob);
        shapes.setPositionResolver(address(0));
        assertEq(shapes.positionResolver(), address(0));
        assertEq(shapes.positionOf(1), address(0));
    }

    function test_ResolverRejectsCodelessNonzeroAddress() public {
        vm.expectRevert(IShapes.InvalidPositionResolver.selector);
        shapes.setPositionResolver(alice);
    }

    function test_ResolverAdminIsOwnerOnly() public {
        MockPositionResolver resolver = new MockPositionResolver();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setPositionResolver(address(resolver));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.lockPositionResolver();
    }

    function test_OwnerMayPermanentlyLockZero() public {
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.PositionResolverLocked(address(0));
        shapes.lockPositionResolver();
        assertTrue(shapes.positionResolverLocked());
        assertEq(shapes.positionOf(123), address(0));

        MockPositionResolver resolver = new MockPositionResolver();
        vm.expectRevert(IShapes.PositionResolverIsLocked.selector);
        shapes.setPositionResolver(address(resolver));
        vm.expectRevert(IShapes.PositionResolverIsLocked.selector);
        shapes.lockPositionResolver();
    }

    function test_ConfiguredResolverBecomesPermanentWhenLocked() public {
        MockPositionResolver resolver = new MockPositionResolver();
        shapes.setPositionResolver(address(resolver));
        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.PositionResolverLocked(address(resolver));
        shapes.lockPositionResolver();

        MockPositionResolver replacement = new MockPositionResolver();
        vm.expectRevert(IShapes.PositionResolverIsLocked.selector);
        shapes.setPositionResolver(address(replacement));
        vm.expectRevert(IShapes.PositionResolverIsLocked.selector);
        shapes.setPositionResolver(address(0));
        assertEq(shapes.positionResolver(), address(resolver));
    }

    function test_RendererAndResolverLocksAreIndependent() public {
        shapes.lockRenderer();
        MockPositionResolver resolver = new MockPositionResolver();
        shapes.setPositionResolver(address(resolver));
        shapes.lockPositionResolver();
        assertTrue(shapes.rendererLocked());
        assertTrue(shapes.positionResolverLocked());
    }

    function test_OwnershipTransferMovesAllRemainingAdminAuthority() public {
        MockPositionResolver resolver = new MockPositionResolver();
        shapes.transferOwnership(alice);
        assertEq(shapes.owner(), alice);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        shapes.setPositionResolver(address(resolver));

        vm.startPrank(alice);
        shapes.setRenderer(address(new ShapeRenderer()));
        shapes.setPositionResolver(address(resolver));
        shapes.lockPositionResolver();
        shapes.transferOwnership(bob);
        vm.stopPrank();

        assertEq(shapes.owner(), bob);
        assertEq(shapes.positionResolver(), address(resolver));
        assertTrue(shapes.positionResolverLocked());
    }

    function test_RenouncingBeforeInstallLeavesResolverUnset() public {
        shapes.renounceOwnership();
        assertEq(shapes.owner(), address(0));
        MockPositionResolver resolver = new MockPositionResolver();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        shapes.setPositionResolver(address(resolver));
        assertEq(shapes.positionResolver(), address(0));
    }

    function test_RenouncingAfterInstallLeavesResolverUsableAndUnchanged() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setPosition(7, alice);
        shapes.setPositionResolver(address(resolver));
        shapes.renounceOwnership();
        assertEq(shapes.positionResolver(), address(resolver));
        assertEq(shapes.positionOf(7), alice);
    }

    /// @notice A reverting resolver does not make `positionOf` revert; the failure is swallowed to
    ///         `address(0)`, the same value an unset resolver returns.
    function test_ResolverRevertIsSwallowedToZero() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setShouldRevert(true);
        shapes.setPositionResolver(address(resolver));
        uint256 id = _mint(alice, 1 ether);

        assertEq(shapes.positionOf(id), address(0), "existing id");
        assertEq(shapes.positionOf(999), address(0), "nonexistent id");
    }

    /// @notice A resolver that burns unbounded gas cannot drain the caller: `positionOf` forwards a
    ///         fixed cap and swallows the resulting out-of-gas to `address(0)`.
    function test_HostileResolverGasIsBounded() public {
        HostileGasResolver resolver = new HostileGasResolver();
        shapes.setPositionResolver(address(resolver));

        uint256 gasBefore = gasleft();
        address position = shapes.positionOf(1);
        uint256 used = gasBefore - gasleft();

        assertEq(position, address(0), "hostile resolver swallowed to zero");
        // The resolver alone would burn tens of millions; the capped call is a tiny fraction.
        assertLt(used, 200_000, "forwarded gas is bounded");
    }

    function test_SettingAndQueryingResolverCannotChangeTokenOrReserveState() public {
        uint256 id = _mint(alice, 5 ether);
        uint256 balanceBefore = address(shapes).balance;
        uint256 backingBefore = shapes.redeemableBacking();
        uint256 supplyBefore = shapes.totalSupply();
        address ownerBefore = shapes.ownerOf(id);
        bytes32 seedBefore = shapes.seedOf(id);
        string memory uriBefore = shapes.tokenURI(id);
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setPosition(id, bob);

        shapes.setPositionResolver(address(resolver));
        assertEq(shapes.positionOf(id), bob);

        assertEq(address(shapes).balance, balanceBefore);
        assertEq(shapes.redeemableBacking(), backingBefore);
        assertEq(shapes.totalSupply(), supplyBefore);
        assertEq(shapes.ownerOf(id), ownerBefore);
        assertEq(shapes.seedOf(id), seedBefore);
        assertEq(shapes.tokenURI(id), uriBefore);
    }

    function test_RevertingResolverCannotAffectCoreLifecycle() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setShouldRevert(true);
        shapes.setPositionResolver(address(resolver));

        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 5);
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

    /// @notice Replacing the renderer changes every token's metadata, so it must emit ERC-4906
    ///         `BatchMetadataUpdate` over the minted range so marketplaces refresh.
    function test_SetRendererEmitsBatchMetadataUpdate() public {
        _mint(alice, 1 ether);
        _mint(bob, 5 ether);
        ShapeRenderer next = new ShapeRenderer();

        vm.expectEmit(false, false, false, true, address(shapes));
        emit IERC4906.BatchMetadataUpdate(0, shapes.totalMinted() - 1);
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
        uint256 first = _mintMany(0.01 ether, 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    function test_ComposeCombinesBackingAndOrigins() public {
        uint256 first = _mintMany(0.01 ether, 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }

        vm.prank(alice);
        uint256 outId = shapes.compose(first, burn);

        assertEq(outId, first, "survivor keeps its id");
        assertEq(shapes.backingOf(first), 0.05 ether, "backing summed to 0.05");
        assertEq(shapes.originCountOf(first), 5, "origins summed");
        assertTrue(shapes.isComplete(first), "5 origins on 0.05 is Complete");
        assertEq(shapes.totalSupply(), 1, "four inputs burned");
        assertEq(shapes.redeemableBacking(), 0.05 ether, "reserve conserved");
        _assertSolvent();
        vm.expectRevert();
        shapes.ownerOf(first + 1);
    }

    function test_ComposeKeepsSurvivorSeed() public {
        uint256 first = _mintMany(0.01 ether, 5);
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
        uint256 b = shapes.mint{value: 0.01 ether + feeOf(0.01 ether)}(0.01 ether);
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

    function test_SplitBurnsInputAndMintsChildren() public {
        uint256 id = _mint(alice, 0.05 ether); // direct, originCount 1
        uint8[] memory outs = new uint8[](5); // 5 x 0.01 (index 0)
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);

        assertEq(kids.length, 5);
        vm.expectRevert();
        shapes.ownerOf(id); // input burned

        assertEq(shapes.originCountOf(kids[0]), 1, "survivor-first fill");
        assertEq(shapes.originCountOf(kids[1]), 0);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(shapes.backingOf(kids[i]), 0.01 ether);
            assertEq(shapes.ownerOf(kids[i]), alice);
        }
        assertEq(shapes.redeemableBacking(), 0.05 ether, "reserve conserved");
        assertEq(shapes.totalSupply(), 5);
        _assertSolvent();
    }

    function test_SplitChildSeedsAreDeterministic() public {
        uint256 id = _mint(alice, 0.05 ether);
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
        uint256 id = _mint(alice, 0.1 ether);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 0;
        outs[1] = 0; // 0.02 != 0.1
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitMismatch.selector, 0.1 ether, 0.02 ether));
        shapes.split(id, outs);
    }

    function test_SplitRejectsSingleOutput() public {
        uint256 id = _mint(alice, 0.05 ether);
        uint8[] memory outs = new uint8[](1);
        outs[0] = 1;
        vm.prank(alice);
        vm.expectRevert(IShapes.EmptyRecomposition.selector);
        shapes.split(id, outs);
    }

    function test_ForgeryBlocked_SplitRecombinePreservesCount() public {
        uint256 id = _mint(alice, 0.1 ether); // direct, originCount 1
        uint8[] memory outs = new uint8[](10); // 10 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);

        uint256[] memory burn = new uint256[](9);
        for (uint256 i = 0; i < 9; i++) {
            burn[i] = kids[i + 1];
        }
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
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(feeRecipient.balance, afterMint, "compose charged no fee");

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        shapes.split(first, outs);
        assertEq(feeRecipient.balance, afterMint, "split charged no fee");
    }

    function test_SupportsErc4906() public view {
        assertTrue(shapes.supportsInterface(0x49064906));
    }

    /// @notice ShapeRedeemed carries the redeemed token's originCount, so an event-only indexer can
    ///         track global origin conservation without a pre-burn state read.
    function test_RedeemEmitsOriginCount() public {
        uint256 id = _buildComplete005(); // five 0.01 direct mints composed → 0.05, originCount 5
        vm.expectEmit(true, true, false, true, address(shapes));
        emit IShapes.ShapeRedeemed(id, alice, 0.05 ether, 5);
        vm.prank(alice);
        shapes.redeem(id);
    }

    /// @notice The child seeds derive from the parent seed and index alone — no block data. Mutating
    ///         the block environment before the split cannot change them, so a split cannot be
    ///         re-rolled by waiting for a friendlier block.
    function test_SplitChildSeedsIgnoreBlockEnv() public {
        uint256 parent = _mint(alice, 0.05 ether);
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
            shapes.mintBatchTo{value: 10_000 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 10_000, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        id = shapes.compose(first, burn);
        assertEq(shapes.backingOf(id), 100 ether, "apex backing");
        assertEq(shapes.originCountOf(id), 10_000, "apex origins");
        assertTrue(shapes.isComplete(id), "apex is Complete");
    }

    /// @dev A Complete 0.05 (five 0.01 direct mints composed): Complete but below apex.
    function _buildComplete005() internal returns (uint256 survivor) {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 5 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    function test_SacrificeCreatesBlackWithoutBurningAndIgnoresResolver() public {
        MockPositionResolver resolver = new MockPositionResolver();
        resolver.setShouldRevert(true);
        shapes.setPositionResolver(address(resolver));
        uint256 id = _buildApexComplete();
        uint256 deadBefore = DEAD.balance;
        uint256 balBefore = address(shapes).balance;
        assertEq(shapes.redeemableBacking(), 100 ether, "reserve is the apex backing");

        vm.expectEmit(true, false, false, true, address(shapes));
        emit IShapes.Blackened(id, 100 ether);
        vm.prank(alice);
        shapes.sacrifice(id);

        assertTrue(shapes.isBlack(id), "now Black");
        assertEq(shapes.blackCount(), 1);
        assertEq(shapes.sacrificedBacking(), 100 ether);
        assertEq(shapes.redeemableBacking(), 0, "backing left the reserve");
        assertEq(DEAD.balance, deadBefore + 100 ether, "sacrificed to the burn address");
        assertEq(address(shapes).balance, balBefore - 100 ether, "contract paid it out");
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
        uint256 extra = _mint(alice, 0.01 ether);
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
        assertEq(shapes.sacrificedBacking(), 100 ether, "historical sacrifice remains counted");
        assertEq(shapes.blackCount(), 1, "blackCount is cumulative");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        shapes.ownerOf(id);

        uint256 next = _mint(alice, 0.01 ether);
        assertEq(next, mintedBefore, "burned Black id is never reused");
    }

    function test_SacrificeRejectsDirectApex() public {
        uint256 id = _mint(alice, 100 ether); // 100 ETH, originCount 1, not Complete
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
        uint256 id = _mint(alice, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, id, bob));
        shapes.sacrifice(id);
    }

    /// @notice `split` rejects a Black Shape, and `previewSplit` reports the same rejection.
    function test_PreviewSplitRejectsBlackToMatchSplit() public {
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
        shapes.previewSplit(id, outs);
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
        uint256 id = _mint(alice, 0.01 ether);
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
        shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether);

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
        uint256 first =
            shapes.mintBatchTo{value: 200 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 200, alice);
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
        first = shapes.mintBatch{value: qty * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, qty);
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
        uint256 parent = _mint(alice, 0.05 ether); // denomIndex 1, 5 units
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
        uint256 parent = _mint(alice, 100 ether); // denomIndex 8, apex backing
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
        assertEq(shapes.backingOf(kids[0]), 100 ether);
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

        assertEq(shapes.backingOf(survivor), 100 ether);
        assertEq(shapes.originCountOf(survivor), 10_000);
        assertTrue(shapes.isComplete(survivor));
        // Loose ceiling: this test exists to catch a regression and record the true number, not
        // to micro-optimise. 9,999 burns each touching the ink-gene fields is inherently large, and
        // reversible compose adds a ~52k-gas record per input (~2 storage slots). This 10,000-in-one
        // compose is far past any block gas limit and exists only as a gas-profile datapoint; real
        // merges of this size are built incrementally, each step independently reversible.
        assertLt(composeGas, 650_000_000, "10,000-dust mega-compose gas regressed");
    }
}

/// @notice Split: the gene is copied verbatim to every child.
///         recovers the exact pre-split gene alongside the seed and denomination.
contract InkGeneSplitTest is ShapesBase {
    function test_SplitCopiesGeneToEveryChild() public {
        uint256 id = _mint(alice, 0.05 ether);
        uint8 parentGene = shapes.inkGeneOf(id);

        uint8[] memory outs = new uint8[](5); // 5 x 0.01
        vm.prank(alice);
        uint256[] memory kids = shapes.split(id, outs);

        for (uint256 i = 0; i < kids.length; ++i) {
            assertEq(shapes.inkGeneOf(kids[i]), parentGene, "child gene diverged from parent");
        }
    }

    function test_SplitEmitsInkGenePerChild() public {
        uint256 id = _mint(alice, 0.05 ether);
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
        first = shapes.mintBatch{value: qty * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, qty);
    }

    function test_PreviewComposeTouchesNoState() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        uint256 snapshot = vm.snapshotState();
        shapes.previewCompose(first, burn);
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
        shapes.previewCompose(first, burn);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Regression tests for the findings raised in the adversarial review.
/// @dev Each test here exists because something was once wrong, or could plausibly be made
///      wrong by a later edit. See SECURITY.md.
contract HardeningTest is Test {
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
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    function feeOf(uint256) internal pure returns (uint256) {
        return MINT_FEE;
    }

    ShapeRenderer internal renderer;

    ShapeCollection internal collection;
    Shapes internal shapes;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection)
        );
        shapes.redeemTo(0, payable(address(0xD15CA4D)));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    /* ---------------- seed grinding resistance ---------------- */

    /// @notice The seed must not depend on who mints or who receives.
    /// @dev This is the regression test for the free-enumeration attack: previously an
    ///      attacker could vary `to` off chain, at zero cost, until the artwork suited them.
    ///      Both mints below occur at the same block and the same token id, so if the seed
    ///      depended on the minter or the recipient at all, these would differ.
    function test_SeedIsIndependentOfMinterAndRecipient() public {
        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[8] + feeOf(DENOMS[8])}(DENOMS[8]);
        bytes32 seedA = shapes.seedOf(id);

        vm.revertToState(snap);

        vm.prank(bob);
        uint256 id2 = shapes.mintTo{value: DENOMS[8] + feeOf(DENOMS[8])}(DENOMS[8], address(0xC0FFEE));
        bytes32 seedB = shapes.seedOf(id2);

        assertEq(id, id2, "same token id");
        assertEq(seedB, seedA, "seed moved with the minter or recipient");
    }

    /// @notice Enumerating recipients, the attack the review demonstrated, now yields nothing.
    function test_EnumeratingRecipientsCannotChangeTheArtwork() public {
        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[8] + feeOf(DENOMS[8])}(DENOMS[8]);
        string memory target = shapes.tokenURI(id);
        vm.revertToState(snap);

        for (uint256 i = 1; i <= 64; ++i) {
            uint256 s = vm.snapshotState();
            address candidate = address(uint160(0x1000 + i));
            vm.prank(alice);
            uint256 got = shapes.mintTo{value: DENOMS[8] + feeOf(DENOMS[8])}(DENOMS[8], candidate);
            assertEq(shapes.tokenURI(got), target, "recipient choice changed the artwork");
            vm.revertToState(s);
        }
    }

    /// @notice Batch size must not shift the seed of the tokens it shares a batch with.
    function test_SeedIsIndependentOfQuantity() public {
        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        shapes.mintBatch{value: 1 * (DENOMS[4] + feeOf(DENOMS[4]))}(DENOMS[4], 1);
        bytes32 solo = shapes.seedOf(1);

        vm.revertToState(snap);

        vm.prank(alice);
        shapes.mintBatch{value: 7 * (DENOMS[4] + feeOf(DENOMS[4]))}(DENOMS[4], 7);
        assertEq(shapes.seedOf(1), solo, "seed moved with batch size");
    }

    /// @notice Distinct token ids still give distinct seeds, including across batches mined in
    ///         the same block.
    function test_SeedsRemainDistinctWithinAndAcrossBatches() public {
        vm.startPrank(alice);
        shapes.mintBatchTo{value: 6 * (DENOMS[4] + feeOf(DENOMS[4]))}(DENOMS[4], 6, alice);
        shapes.mintBatchTo{value: 6 * (DENOMS[5] + feeOf(DENOMS[5]))}(DENOMS[5], 6, alice);
        vm.stopPrank();

        bytes32[] memory seen = new bytes32[](12);
        for (uint256 i = 0; i < 12; ++i) {
            seen[i] = shapes.seedOf(i + 1);
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(seen[i] != seen[j], "seed collision");
            }
        }
    }

    /* ---------------- immutable-deployment footguns ---------------- */

    function test_RendererWithoutCodeIsRejected() public {
        vm.expectRevert(bytes("renderer has no code"));
        new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(0xDEAD), address(collection)
        );

        // an EOA is equally unacceptable
        vm.expectRevert(bytes("renderer has no code"));
        new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, alice, address(collection));
    }

    /* ---------------- self-custody ---------------- */

    function test_CannotTransferAShapeToTheContractItself() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4]);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, id));
        shapes.transferFrom(alice, address(shapes), id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, id));
        shapes.safeTransferFrom(alice, address(shapes), id);

        assertEq(shapes.ownerOf(id), alice, "token stayed put");
        assertEq(shapes.backingOf(id), DENOMS[4], "backing still redeemable");
    }

    function test_ShapeZeroSafeTransferAndSelfCustodyGuard() public {
        ShapeRenderer ownershipRenderer = new ShapeRenderer();
        ShapeCollection ownershipCollection = new ShapeCollection(address(ownershipRenderer));
        Shapes ownershipShapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(ownershipRenderer), address(ownershipCollection)
        );

        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, 0));
        ownershipShapes.transferFrom(address(this), address(ownershipShapes), 0);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, 0));
        ownershipShapes.safeTransferFrom(address(this), address(ownershipShapes), 0);
        assertEq(ownershipShapes.ownerOf(0), address(this), "rejected transfer moved Shape #0");
        assertEq(ownershipShapes.owner(), address(this), "rejected transfer moved contract ownership");

        BalanceProbe receiver = new BalanceProbe(ownershipShapes);
        ownershipShapes.safeTransferFrom(address(this), address(receiver), 0);
        assertEq(ownershipShapes.ownerOf(0), address(receiver), "safe transfer did not move Shape #0");
        assertEq(ownershipShapes.owner(), address(receiver), "ownership did not follow Shape #0");
    }

    function test_CannotMintDirectlyIntoTheContract() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, 1));
        shapes.mintTo{value: DENOMS[4] + feeOf(DENOMS[4])}(DENOMS[4], address(shapes));

        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
    }

    /* ---------------- reserve consistency during callbacks ---------------- */

    /// @notice Fees are forwarded before the mint loop, so a receiver callback observes a
    ///         reserve figure that matches the contract's balance rather than one inflated by
    ///         fees still sitting in the contract.
    function test_ReserveIsConsistentInsideReceiverCallback() public {
        BalanceProbe probe = new BalanceProbe(shapes);

        vm.prank(alice);
        shapes.mintBatchTo{value: 4 * (DENOMS[4] + feeOf(DENOMS[4]))}(DENOMS[4], 4, address(probe));

        assertGt(probe.observations(), 0, "callback never ran");
        assertEq(
            probe.observedBalance(),
            probe.observedBacking(),
            "balance and redeemableBacking disagreed inside the callback"
        );
    }
}

/// @dev Records the reserve as seen from inside the first `onERC721Received` of a batch.
contract BalanceProbe is IERC721Receiver {
    Shapes public immutable shapes;
    uint256 public observations;
    uint256 public observedBalance;
    uint256 public observedBacking;

    constructor(Shapes shapes_) {
        shapes = shapes_;
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (observations == 0) {
            observedBalance = address(shapes).balance;
            observedBacking = shapes.redeemableBacking();
        }
        observations++;
        return IERC721Receiver.onERC721Received.selector;
    }
}

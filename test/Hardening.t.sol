// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";

/// @notice Regression tests for the findings raised in the adversarial review.
/// @dev Each test here exists because something was once wrong, or could plausibly be made
///      wrong by a later edit. See SECURITY.md.
contract HardeningTest is Test {
    uint256 internal constant FEE_BPS = 100; // 1%

    function feeOf(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
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
        shapes = new Shapes(FEE_BPS, feeRecipient, address(renderer), address(collection));
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
        uint256 id = shapes.mint{value: 100 ether + feeOf(100 ether)}(100 ether, alice);
        bytes32 seedA = shapes.seedOf(id);

        vm.revertToState(snap);

        vm.prank(bob);
        uint256 id2 = shapes.mint{value: 100 ether + feeOf(100 ether)}(100 ether, address(0xC0FFEE));
        bytes32 seedB = shapes.seedOf(id2);

        assertEq(id, id2, "same token id");
        assertEq(seedB, seedA, "seed moved with the minter or recipient");
    }

    /// @notice Enumerating recipients, the attack the review demonstrated, now yields nothing.
    function test_EnumeratingRecipientsCannotChangeTheArtwork() public {
        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        uint256 id = shapes.mint{value: 100 ether + feeOf(100 ether)}(100 ether, alice);
        string memory target = shapes.tokenURI(id);
        vm.revertToState(snap);

        for (uint256 i = 1; i <= 64; ++i) {
            uint256 s = vm.snapshotState();
            address candidate = address(uint160(0x1000 + i));
            vm.prank(alice);
            uint256 got = shapes.mint{value: 100 ether + feeOf(100 ether)}(100 ether, candidate);
            assertEq(shapes.tokenURI(got), target, "recipient choice changed the artwork");
            vm.revertToState(s);
        }
    }

    /// @notice Batch size must not shift the seed of the tokens it shares a batch with.
    function test_SeedIsIndependentOfQuantity() public {
        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        shapes.mintBatch{value: 1 * (1 ether + feeOf(1 ether))}(1 ether, 1, alice);
        bytes32 solo = shapes.seedOf(0);

        vm.revertToState(snap);

        vm.prank(alice);
        shapes.mintBatch{value: 7 * (1 ether + feeOf(1 ether))}(1 ether, 7, alice);
        assertEq(shapes.seedOf(0), solo, "seed moved with batch size");
    }

    /// @notice Distinct token ids still give distinct seeds, including across batches mined in
    ///         the same block.
    function test_SeedsRemainDistinctWithinAndAcrossBatches() public {
        vm.startPrank(alice);
        shapes.mintBatch{value: 6 * (1 ether + feeOf(1 ether))}(1 ether, 6, alice);
        shapes.mintBatch{value: 6 * (5 ether + feeOf(5 ether))}(5 ether, 6, alice);
        vm.stopPrank();

        bytes32[] memory seen = new bytes32[](12);
        for (uint256 i = 0; i < 12; ++i) {
            seen[i] = shapes.seedOf(i);
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(seen[i] != seen[j], "seed collision");
            }
        }
    }

    /* ---------------- immutable-deployment footguns ---------------- */

    function test_RendererWithoutCodeIsRejected() public {
        vm.expectRevert(bytes("renderer has no code"));
        new Shapes(FEE_BPS, feeRecipient, address(0xDEAD), address(collection));

        // an EOA is equally unacceptable
        vm.expectRevert(bytes("renderer has no code"));
        new Shapes(FEE_BPS, feeRecipient, alice, address(collection));
    }

    /* ---------------- self-custody ---------------- */

    function test_CannotTransferAShapeToTheContractItself() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, id));
        shapes.transferFrom(alice, address(shapes), id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, id));
        shapes.safeTransferFrom(alice, address(shapes), id);

        assertEq(shapes.ownerOf(id), alice, "token stayed put");
        assertEq(shapes.backingOf(id), 1 ether, "backing still redeemable");
    }

    function test_CannotMintDirectlyIntoTheContract() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, 0));
        shapes.mint{value: 1 ether + feeOf(1 ether)}(1 ether, address(shapes));

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
        shapes.mintBatch{value: 4 * (1 ether + feeOf(1 ether))}(1 ether, 4, address(probe));

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

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        if (observations == 0) {
            observedBalance = address(shapes).balance;
            observedBacking = shapes.redeemableBacking();
        }
        observations++;
        return IERC721Receiver.onERC721Received.selector;
    }
}

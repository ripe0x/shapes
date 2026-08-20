// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";

/// @dev A contract that can hold the title and pass it on: the shape any external sale or auction
///      would take. It has no other relationship to Shapes.
contract TitleEscrow {
    Shapes private immutable shapes;

    constructor(Shapes shapes_) {
        shapes = shapes_;
    }

    function pass(address to) external {
        shapes.transferTitle(to);
    }
}

/// @dev Holds the title and cannot pass it on. Standing proof that the title is a bearer
///      instrument with no recovery.
contract DeadEnd {}

/// @notice Title to Shapes: one holder, recorded by the contract itself, carrying no authority
///         beyond passing itself on, and independent of administrative ownership in both
///         directions.
contract TitleTest is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;

    address internal deployer = address(this); // Ownable(msg.sender)
    address internal holder = makeAddr("holder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    event TitleTransferred(address indexed previousHolder, address indexed newHolder);

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection), holder);
        vm.deal(alice, 100 ether);
    }

    function _deploy(address initialTitleHolder) internal returns (Shapes) {
        return new Shapes(100, feeRecipient, address(renderer), address(collection), initialTitleHolder);
    }

    /* --------------------------- initialization --------------------------- */

    function test_ConstructorRejectsAZeroTitleHolder() public {
        vm.expectRevert(IShapes.InvalidTitleRecipient.selector);
        _deploy(address(0));
    }

    /// @notice Title held by the contract itself would be unreachable from the moment of
    ///         deployment, since the contract can never be `msg.sender`.
    function test_ConstructorRejectsTheContractItselfAsTitleHolder() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(IShapes.InvalidTitleRecipient.selector);
        _deploy(predicted);
    }

    function test_ConstructorRecordsTheHolderAndTheTimestamp() public view {
        assertEq(shapes.titleHolder(), holder, "initial holder not recorded");
        assertEq(shapes.titleSince(), uint64(block.timestamp), "titleSince is not the deployment");
    }

    function test_ConstructorEmitsTheConferral() public {
        vm.expectEmit(true, true, false, false);
        emit TitleTransferred(address(0), alice);
        _deploy(alice);
    }

    function test_TitleHolderMayEqualTheOwner() public {
        Shapes s = _deploy(address(this));
        assertEq(s.titleHolder(), address(this));
        assertEq(s.owner(), address(this), "one address may hold both roles");
    }

    function test_TitleHolderMayDifferFromTheOwner() public view {
        assertEq(shapes.titleHolder(), holder);
        assertEq(shapes.owner(), deployer);
        assertTrue(shapes.titleHolder() != shapes.owner(), "the roles are independent");
    }

    function test_TitleHolderMayBeAContract() public {
        TitleEscrow escrow = new TitleEscrow(shapes);
        Shapes s = _deploy(address(escrow));
        assertEq(s.titleHolder(), address(escrow));
    }

    /* -------------------------- who may transfer -------------------------- */

    function test_HolderTransfers() public {
        vm.prank(holder);
        shapes.transferTitle(alice);
        assertEq(shapes.titleHolder(), alice);
    }

    function test_ANonHolderCannotTransfer() public {
        vm.prank(alice);
        vm.expectRevert(IShapes.NotTitleHolder.selector);
        shapes.transferTitle(bob);
    }

    /// @notice The owner has configuration authority and no claim on the title.
    function test_TheOwnerCannotTransferTheTitle() public {
        assertEq(shapes.owner(), deployer);
        vm.expectRevert(IShapes.NotTitleHolder.selector);
        shapes.transferTitle(alice);
    }

    function test_ThePreviousHolderCannotTransferAfterwards() public {
        vm.prank(holder);
        shapes.transferTitle(alice);

        vm.prank(holder);
        vm.expectRevert(IShapes.NotTitleHolder.selector);
        shapes.transferTitle(bob);
    }

    function test_TheNewHolderCanTransferImmediately() public {
        vm.prank(holder);
        shapes.transferTitle(alice);
        vm.prank(alice);
        shapes.transferTitle(bob);
        assertEq(shapes.titleHolder(), bob);
    }

    /* --------------------------- the recipient ---------------------------- */

    function test_TransferToZeroReverts() public {
        vm.prank(holder);
        vm.expectRevert(IShapes.InvalidTitleRecipient.selector);
        shapes.transferTitle(address(0));
    }

    function test_TransferToTheContractReverts() public {
        vm.prank(holder);
        vm.expectRevert(IShapes.InvalidTitleRecipient.selector);
        shapes.transferTitle(address(shapes));
    }

    function test_TransferToTheCurrentHolderReverts() public {
        vm.prank(holder);
        vm.expectRevert(IShapes.TitleAlreadyHeldByRecipient.selector);
        shapes.transferTitle(holder);
    }

    function test_TransferToAContractSucceeds() public {
        TitleEscrow escrow = new TitleEscrow(shapes);
        vm.prank(holder);
        shapes.transferTitle(address(escrow));
        assertEq(shapes.titleHolder(), address(escrow));
    }

    /// @notice The whole external-sale story, with no support from this contract: the seller
    ///         passes title to an escrow, the escrow settles under its own rules, the escrow
    ///         passes title to the winner. Shapes verifies no payment and needs no hook.
    function test_AnEscrowCanReceiveTheTitleAndPassItOn() public {
        TitleEscrow escrow = new TitleEscrow(shapes);

        vm.prank(holder);
        shapes.transferTitle(address(escrow));
        assertEq(shapes.titleHolder(), address(escrow));

        escrow.pass(bob);
        assertEq(shapes.titleHolder(), bob, "the winner holds title");
        assertEq(address(shapes).balance, 0, "no payment passed through Shapes");
    }

    /// @notice A bearer instrument with no recovery. Documented, not defended against: an owner
    ///         able to recover the title would be an owner able to take it.
    function test_TitleSentToADeadEndIsStrandedWithNoRecovery() public {
        DeadEnd sink = new DeadEnd();
        vm.prank(holder);
        shapes.transferTitle(address(sink));
        assertEq(shapes.titleHolder(), address(sink));

        vm.prank(deployer);
        vm.expectRevert(IShapes.NotTitleHolder.selector);
        shapes.transferTitle(alice); // not even the owner can retrieve it
    }

    /* ------------------------------ effects ------------------------------- */

    function test_TransferUpdatesHolderAndTimestampAndEmitsOnce() public {
        skip(1 days);
        vm.recordLogs();

        vm.expectEmit(true, true, false, false);
        emit TitleTransferred(holder, alice);
        vm.prank(holder);
        shapes.transferTitle(alice);

        assertEq(shapes.titleHolder(), alice);
        assertEq(shapes.titleSince(), uint64(block.timestamp), "titleSince not refreshed");

        // `expectEmit` emits the expected log from this contract, so count only what Shapes
        // itself emitted.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 fromShapes;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(shapes)) fromShapes++;
        }
        assertEq(fromShapes, 1, "a transfer emits exactly one event");
    }

    /// @notice Everything a title transfer must leave alone, checked in one pass over live state.
    function test_TransferTouchesNothingElse() public {
        vm.prank(alice);
        uint256 id = shapes.mint{value: 1.01 ether}(1 ether);

        uint256 balanceBefore = address(shapes).balance;
        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 sacrificedBefore = shapes.sacrificedBacking();
        address rendererBefore = shapes.renderer();
        address collectionBefore = shapes.collection();
        address resolverBefore = shapes.positionResolver();
        address ownerBefore = shapes.owner();
        uint256 backingBefore = shapes.backingOf(id);
        uint256 originsBefore = shapes.originCountOf(id);
        uint8 geneBefore = shapes.inkGeneOf(id);
        uint256 mintedBefore = shapes.totalMinted();

        vm.prank(holder);
        shapes.transferTitle(bob);

        assertEq(address(shapes).balance, balanceBefore, "balance moved");
        assertEq(shapes.redeemableBacking(), reserveBefore, "reserve moved");
        assertEq(shapes.sacrificedBacking(), sacrificedBefore, "sacrificed moved");
        assertEq(shapes.renderer(), rendererBefore, "renderer moved");
        assertEq(shapes.collection(), collectionBefore, "collection moved");
        assertEq(shapes.positionResolver(), resolverBefore, "resolver moved");
        assertEq(shapes.owner(), ownerBefore, "administrative ownership moved");
        assertEq(shapes.feeRecipient(), feeRecipient, "fee recipient moved");
        assertEq(shapes.ownerOf(id), alice, "token owner moved");
        assertEq(shapes.backingOf(id), backingBefore, "token backing moved");
        assertEq(shapes.originCountOf(id), originsBefore, "origin count moved");
        assertEq(shapes.inkGeneOf(id), geneBefore, "ink gene moved");
        assertEq(shapes.totalMinted(), mintedBefore, "the id counter moved");
    }

    /// @notice No ERC721 `Transfer` is emitted: the title is not a token.
    function test_TransferEmitsNoErc721Transfer() public {
        vm.recordLogs();
        vm.prank(holder);
        shapes.transferTitle(alice);

        bytes32 erc721Transfer = keccak256("Transfer(address,address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != erc721Transfer, "a title transfer emitted an ERC721 Transfer");
        }
    }

    /* ------------------- independence from ownership --------------------- */

    function test_TitleSurvivesOwnershipTransfer() public {
        shapes.transferOwnership(alice);
        assertEq(shapes.titleHolder(), holder, "ownership transfer moved the title");

        vm.prank(holder);
        shapes.transferTitle(bob);
        assertEq(shapes.titleHolder(), bob, "title still transferable under a new owner");
    }

    /// @notice The end state the collection is heading for: no owner at all, title still moving.
    function test_TitleSurvivesOwnershipRenunciation() public {
        shapes.renounceOwnership();
        assertEq(shapes.owner(), address(0), "ownership not renounced");
        assertEq(shapes.titleHolder(), holder, "renunciation moved the title");

        vm.prank(holder);
        shapes.transferTitle(alice);
        assertEq(shapes.titleHolder(), alice, "title frozen by renunciation");
    }

    function test_TitleSurvivesLockingPresentation() public {
        shapes.lockRenderer();
        vm.prank(holder);
        shapes.transferTitle(alice);
        assertEq(shapes.titleHolder(), alice, "locking the renderer froze the title");
    }

    function test_TitleSurvivesResolverInstallation() public {
        address resolverBefore = shapes.positionResolver();
        vm.prank(holder);
        shapes.transferTitle(alice);
        assertEq(shapes.positionResolver(), resolverBefore, "title transfer moved the resolver");
        assertEq(shapes.titleHolder(), alice);
    }

    /// @notice Holding the title confers none of the owner's configuration authority.
    function test_TheHolderCannotCallOwnerFunctions() public {
        ShapeRenderer next = new ShapeRenderer();

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, holder));
        shapes.setRenderer(address(next));

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, holder));
        shapes.lockRenderer();
    }

    /* ----------------------------- invariants ----------------------------- */

    function test_TitleIsNeverZeroAfterConstruction() public {
        assertTrue(shapes.titleHolder() != address(0));
        vm.prank(holder);
        shapes.transferTitle(alice);
        assertTrue(shapes.titleHolder() != address(0), "a transfer can never zero the title");
    }

    /// @notice No core operation moves the title as a side effect.
    function test_CoreOperationsLeaveTheTitleUntouched() public {
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 6 * 0.0101 ether}(0.01 ether, 6);
        assertEq(shapes.titleHolder(), holder, "mint moved the title");

        vm.prank(alice);
        shapes.transferFrom(alice, bob, first + 5);
        assertEq(shapes.titleHolder(), holder, "an ERC721 transfer moved the title");

        // five 0.01 into one 0.05, which is a real denomination
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        assertEq(shapes.titleHolder(), holder, "compose moved the title");

        vm.prank(alice);
        shapes.decompose(first);
        assertEq(shapes.titleHolder(), holder, "decompose moved the title");

        vm.prank(alice);
        uint256 splittable = shapes.mint{value: 0.0505 ether}(0.05 ether);
        vm.prank(alice);
        shapes.split(splittable, new uint8[](5));
        assertEq(shapes.titleHolder(), holder, "split moved the title");

        vm.prank(alice);
        shapes.redeem(first + 2);
        assertEq(shapes.titleHolder(), holder, "redeem moved the title");
    }
}

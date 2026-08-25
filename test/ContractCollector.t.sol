// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {IContractCollector} from "../src/interfaces/IContractCollector.sol";
import {IShapeProvenance, IShapeRecomposition, IShapeValue} from "../src/interfaces/IShapeCapabilities.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {Denominations} from "../src/lib/Denominations.sol";

import {
    MockCollectorERC721,
    RevertingOwnerOfERC721,
    NotAnERC721,
    NonConformingOwnerOfContract,
    MalformedOwnerOfERC721
} from "./mocks/Mocks.sol";

/// @notice The mutators and the raw getter live on `Shapes` (core); the friendly reads
///         (`contractCollectorToken`, `contractCollector`, `contractCollectorBindingLocked`) live
///         on `ShapeLens` (periphery), split to keep `Shapes` under the EIP-170 runtime size limit.
///         `contractCollector()`'s live `ownerOf` resolution is validated here through the lens,
///         not through `Shapes` directly.
contract ContractCollectorTest is Test {
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
    Shapes internal shapes;
    ShapeLens internal lens;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    MockCollectorERC721 internal token;

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
        lens = new ShapeLens(address(shapes));
        token = new MockCollectorERC721();
        token.mint(alice, 1);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    /* ------------------------------ initial state ------------------------------ */

    function test_InitialStateIsUnsetAndUnlocked() public view {
        (address tokenContract, uint256 tokenId, bool locked) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(0));
        assertEq(tokenId, 0);
        assertFalse(locked);
        assertEq(lens.contractCollector(), address(0));
        assertFalse(lens.contractCollectorBindingLocked());
        (address lensTokenContract, uint256 lensTokenId) = lens.contractCollectorToken();
        assertEq(lensTokenContract, address(0));
        assertEq(lensTokenId, 0);
    }

    /* ------------------------------ authorization ------------------------------ */

    function test_OwnerCanSet() public {
        shapes.setContractCollectorToken(address(token), 1);
        (address tokenContract, uint256 tokenId,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(token));
        assertEq(tokenId, 1);
    }

    function test_NonOwnerSetReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setContractCollectorToken(address(token), 1);
    }

    function test_OwnerCanLock() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();
        (,, bool locked) = shapes.contractCollectorBinding();
        assertTrue(locked);
    }

    function test_NonOwnerLockReverts() public {
        shapes.setContractCollectorToken(address(token), 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.lockContractCollectorBinding();
    }

    /* ---------------------------- token validation ---------------------------- */

    function test_ZeroAddressRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(IContractCollector.InvalidContractCollectorToken.selector, address(0), 1)
        );
        shapes.setContractCollectorToken(address(0), 1);
    }

    function test_EoaRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(IContractCollector.InvalidContractCollectorToken.selector, alice, 1)
        );
        shapes.setContractCollectorToken(alice, 1);
    }

    /// @notice The candidate check is not an ERC-165/ERC-721 conformance check: it validates only
    ///         that a gas-capped `ownerOf(tokenId)` resolves to a nonzero address. `NotAnERC721`
    ///         implements no `ownerOf` at all (and no fallback), so the staticcall fails outright.
    function test_ContractWithNoOwnerOfIsRejected() public {
        NotAnERC721 notErc721 = new NotAnERC721();
        vm.expectRevert(
            abi.encodeWithSelector(
                IContractCollector.InvalidContractCollectorToken.selector, address(notErc721), 1
            )
        );
        shapes.setContractCollectorToken(address(notErc721), 1);
    }

    /// @notice Documents the tradeoff explicitly: a contract with no ERC-165 claim of ERC-721
    ///         support is accepted as long as `ownerOf(tokenId)` resolves to a nonzero address.
    ///         `setContractCollectorToken`'s NatSpec calls this out; the issuer is responsible for
    ///         vetting the candidate's actual behaviour before locking.
    function test_NonConformingContractWithResolvingOwnerOfIsAccepted() public {
        NonConformingOwnerOfContract nonConforming = new NonConformingOwnerOfContract();
        shapes.setContractCollectorToken(address(nonConforming), 1);
        (address tokenContract, uint256 tokenId,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(nonConforming));
        assertEq(tokenId, 1);
        assertEq(lens.contractCollector(), nonConforming.owner());
    }

    function test_NonexistentTokenIdRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IContractCollector.InvalidContractCollectorToken.selector, address(token), 99
            )
        );
        shapes.setContractCollectorToken(address(token), 99);
    }

    function test_ValidErc721WithExistingIdAccepted() public {
        shapes.setContractCollectorToken(address(token), 1);
        (address tokenContract, uint256 tokenId,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(token));
        assertEq(tokenId, 1);
    }

    /* --------------------------- collector resolution --------------------------- */

    function test_CollectorEqualsOwnerOf() public {
        shapes.setContractCollectorToken(address(token), 1);
        assertEq(lens.contractCollector(), token.ownerOf(1));
        assertEq(lens.contractCollector(), alice);
    }

    function test_TransferringNftChangesCollectorButNotPointer() public {
        shapes.setContractCollectorToken(address(token), 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);

        assertEq(lens.contractCollector(), bob);
        (address tokenContract, uint256 tokenId,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(token));
        assertEq(tokenId, 1);
    }

    function test_TransferringNftWritesNoShapesStorage() public {
        shapes.setContractCollectorToken(address(token), 1);

        vm.record();
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        (, bytes32[] memory writes) = vm.accesses(address(shapes));
        assertEq(writes.length, 0, "the NFT transfer wrote to Shapes storage");
    }

    function test_OwnerUnchangedAfterNftTransfer() public {
        address ownerBefore = shapes.owner();
        shapes.setContractCollectorToken(address(token), 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(shapes.owner(), ownerBefore);
    }

    function test_CollectorCannotCallOwnerFunctions() public {
        shapes.setContractCollectorToken(address(token), 1);
        assertEq(lens.contractCollector(), alice);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setRenderer(address(renderer));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setTokenCopy("x", "y");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.setContractCollectorToken(address(token), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        shapes.lockContractCollectorBinding();
        vm.stopPrank();
    }

    function test_BurnedTokenMakesCollectorZeroButKeepsPointer() public {
        shapes.setContractCollectorToken(address(token), 1);
        token.burn(1);

        assertEq(lens.contractCollector(), address(0));
        (address tokenContract, uint256 tokenId,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(token));
        assertEq(tokenId, 1);
    }

    function test_RevertingOwnerOfMakesCollectorZero() public {
        RevertingOwnerOfERC721 reverting = new RevertingOwnerOfERC721();
        reverting.mint(alice, 1);
        shapes.setContractCollectorToken(address(reverting), 1);

        reverting.setShouldRevert(true);
        assertEq(lens.contractCollector(), address(0));
        (address tokenContract,,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(reverting));
    }

    function test_MalformedOwnerOfMakesCollectorZero() public {
        MalformedOwnerOfERC721 malformed = new MalformedOwnerOfERC721();
        shapes.setContractCollectorToken(address(malformed), 1);

        malformed.setShouldMalform(true);
        assertEq(lens.contractCollector(), address(0));
        (address tokenContract,,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(malformed));
    }

    function test_EmptyCodeTokenContractMakesCollectorZero() public {
        shapes.setContractCollectorToken(address(token), 1);
        vm.etch(address(token), "");
        assertEq(lens.contractCollector(), address(0));
        (address tokenContract,,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(token));
    }

    /* ----------------------------- updating before lock ----------------------------- */

    function test_ReplaceWhileUnlocked() public {
        MockCollectorERC721 second = new MockCollectorERC721();
        second.mint(bob, 2);

        shapes.setContractCollectorToken(address(token), 1);
        shapes.setContractCollectorToken(address(second), 2);

        (address tokenContract, uint256 tokenId,) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(second));
        assertEq(tokenId, 2);
        assertEq(lens.contractCollector(), bob);
    }

    function test_ReplacementEmitsPreviousAndNewPointer() public {
        MockCollectorERC721 second = new MockCollectorERC721();
        second.mint(bob, 2);

        shapes.setContractCollectorToken(address(token), 1);

        vm.expectEmit(true, true, false, true, address(shapes));
        emit IContractCollector.ContractCollectorTokenSet(address(token), 1, address(second), 2);
        shapes.setContractCollectorToken(address(second), 2);
    }

    function test_FirstSetEmitsZeroAsPrevious() public {
        vm.expectEmit(true, true, false, true, address(shapes));
        emit IContractCollector.ContractCollectorTokenSet(address(0), 0, address(token), 1);
        shapes.setContractCollectorToken(address(token), 1);
    }

    function test_SettingDoesNotLock() public {
        shapes.setContractCollectorToken(address(token), 1);
        assertFalse(lens.contractCollectorBindingLocked());
    }

    /* --------------------------------- locking --------------------------------- */

    /// @notice Locking before any token is configured lands on `InvalidContractCollectorToken`,
    ///         not a distinct "not set" error: an unset token contract is the zero address, which
    ///         resolves to no code and so fails the same live-`ownerOf` check as any other
    ///         unresolvable candidate.
    function test_LockWithNothingConfiguredReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IContractCollector.InvalidContractCollectorToken.selector, address(0), 0)
        );
        shapes.lockContractCollectorBinding();
    }

    function test_LockConfiguredSucceeds() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();
        (,, bool locked) = shapes.contractCollectorBinding();
        assertTrue(locked);
    }

    function test_LockEmitsEvent() public {
        shapes.setContractCollectorToken(address(token), 1);
        vm.expectEmit(true, true, false, true, address(shapes));
        emit IContractCollector.ContractCollectorBindingLocked(address(token), 1);
        shapes.lockContractCollectorBinding();
    }

    function test_LockTwiceReverts() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();
        vm.expectRevert(IContractCollector.ContractCollectorBindingIsLocked.selector);
        shapes.lockContractCollectorBinding();
    }

    function test_SetAfterLockReverts() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();
        vm.expectRevert(IContractCollector.ContractCollectorBindingIsLocked.selector);
        shapes.setContractCollectorToken(address(token), 1);
    }

    function test_LockAfterTokenBurnedReverts() public {
        shapes.setContractCollectorToken(address(token), 1);
        token.burn(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IContractCollector.InvalidContractCollectorToken.selector, address(token), 1
            )
        );
        shapes.lockContractCollectorBinding();
    }

    function test_NftStillTransferableAfterLock() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();

        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(token.ownerOf(1), bob);
    }

    function test_TransferringLockedNftChangesCollector() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();

        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(lens.contractCollector(), bob);
    }

    /* ------------------------------- existing behaviour ------------------------------- */

    function test_OwnerIsDeployer() public view {
        assertEq(shapes.owner(), address(this));
    }

    function test_OwnershipTransferAndRenounceDoNotTouchBinding() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();

        shapes.transferOwnership(alice);
        assertEq(shapes.owner(), alice);

        vm.prank(alice);
        shapes.renounceOwnership();
        assertEq(shapes.owner(), address(0));

        (address tokenContract, uint256 tokenId, bool locked) = shapes.contractCollectorBinding();
        assertEq(tokenContract, address(token));
        assertEq(tokenId, 1);
        assertTrue(locked);
    }

    function test_OwnerRestrictedSetRendererStillWorksForOwner() public {
        ShapeRenderer newRenderer = new ShapeRenderer();
        shapes.setRenderer(address(newRenderer));
        assertEq(shapes.renderer(), address(newRenderer));
    }

    function test_MintAndRedeemWorkWithBindingSetAndLocked() public {
        shapes.setContractCollectorToken(address(token), 1);
        shapes.lockContractCollectorBinding();

        uint256 backing = DENOMS[4];
        uint256 balanceBefore = alice.balance;
        uint256 cost = backing + shapes.mintFeeFor(backing);

        vm.prank(alice);
        uint256 id = shapes.mint{value: cost}(backing);
        assertEq(shapes.ownerOf(id), alice);

        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, balanceBefore - shapes.mintFeeFor(backing));
    }

    /* ----------------------------------- ERC-165 ----------------------------------- */

    function test_DoesNotAdvertiseContractCollectorInterface() public view {
        assertFalse(shapes.supportsInterface(type(IContractCollector).interfaceId));
    }

    function test_StillAdvertisesExistingInterfaces() public view {
        assertTrue(shapes.supportsInterface(type(IERC165).interfaceId));
        assertTrue(shapes.supportsInterface(type(IERC721).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapes).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeValue).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeRecomposition).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeProvenance).interfaceId));
        assertTrue(shapes.supportsInterface(type(IERC721Value).interfaceId));
        assertTrue(shapes.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(shapes.supportsInterface(0x49064906)); // ERC-4906
    }

    /* ------------------------------------ lens ------------------------------------ */

    function test_LensPointsAtThisShapes() public view {
        assertEq(address(lens.shapes()), address(shapes));
    }
}

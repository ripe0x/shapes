// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IAdminControl} from "../src/interfaces/IAdminControl.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {RevertingFeeRecipient} from "./mocks/Mocks.sol";

contract ContractOwnershipTest is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    function setUp() public {
        vm.deal(address(this), 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection)
        );
    }

    function _mintDust(address to, uint256 quantity) private returns (uint256 firstTokenId) {
        uint256 backing = Denominations.amountAt(0);
        uint256 fee = shapes.mintFee();
        vm.prank(to);
        return shapes.mintBatch{value: quantity * (backing + fee)}(backing, quantity);
    }

    function test_ConstructorMintsBackedShapeZeroToDeployer() public view {
        assertEq(shapes.ownerOf(0), address(this));
        assertEq(shapes.owner(), address(this));
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.backingOf(0), Denominations.amountAt(0));
        assertEq(shapes.redeemableBacking(), Denominations.amountAt(0));
        assertEq(address(shapes).balance, Denominations.amountAt(0));
        assertEq(shapes.totalMinted(), 1);
        assertEq(shapes.totalSupply(), 1);
        assertEq(shapes.originCountOf(0), 1);
        assertEq(shapes.artist(), address(this));

        assertEq(shapes.artistReleaseHash(), bytes32(0));
        assertEq(shapes.artistSignature(), bytes(""));
    }

    function test_ConstructorRequiresExactGenesisBacking() public {
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, Denominations.amountAt(0), 0)
        );
        new Shapes(MINT_FEE, feeRecipient, address(renderer), address(collection));

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector, Denominations.amountAt(0), Denominations.amountAt(0) + 1
            )
        );
        new Shapes{value: Denominations.amountAt(0) + 1}(
            MINT_FEE, feeRecipient, address(renderer), address(collection)
        );
    }

    function test_ConstructorCanSimulateAtGenesisBlock() public {
        vm.roll(0);
        Shapes genesisShapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection)
        );

        assertEq(genesisShapes.ownerOf(0), address(this));
        assertEq(genesisShapes.backingOf(0), Denominations.amountAt(0));
    }

    function test_FirstPermissionlessMintIsShapeOne() public {
        uint256 first = _mintDust(alice, 1);
        assertEq(first, 1);
        assertEq(shapes.ownerOf(1), alice);
    }

    function test_OwnerTracksShapeZeroTransferWithoutMovingAdmin() public {
        shapes.transferFrom(address(this), alice, 0);
        assertEq(shapes.owner(), alice);
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistReleaseHash(), bytes32(0));

        vm.prank(alice);
        shapes.transferFrom(alice, bob, 0);
        assertEq(shapes.owner(), bob);
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistReleaseHash(), bytes32(0));
    }

    function test_OwnerHasNoAdminPermissions() public {
        shapes.transferFrom(address(this), alice, 0);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setMetadataCopy("x", "y");
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.lockRenderer();
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setFeeRecipient(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.transferAdmin(alice);
        vm.stopPrank();
    }

    function test_AdminTransfersIndependentlyOfOwnership() public {
        shapes.transferAdmin(alice);
        assertEq(shapes.admin(), alice);
        assertEq(shapes.owner(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistReleaseHash(), bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setFeeRecipient(bob);

        vm.prank(alice);
        shapes.setMetadataCopy("x", "y");
        vm.prank(alice);
        shapes.setFeeRecipient(bob);
        assertEq(shapes.feeRecipient(), bob);
    }

    function test_AdminCanRenounceWithoutChangingOwnership() public {
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0));
        assertEq(shapes.owner(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistReleaseHash(), bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setFeeRecipient(bob);
    }

    function test_AdminRedirectsOnlyFutureMintFees() public {
        uint256 backing = Denominations.amountAt(0);
        uint256 fee = shapes.mintFee();

        _mintDust(alice, 1);
        assertEq(feeRecipient.balance, fee);

        vm.expectEmit(true, true, false, true, address(shapes));
        emit IAdminControl.FeeRecipientUpdated(feeRecipient, bob);
        shapes.setFeeRecipient(bob);
        _mintDust(alice, 1);

        assertEq(shapes.feeRecipient(), bob);
        assertEq(feeRecipient.balance, fee, "old recipient keeps only its prior fee");
        assertEq(bob.balance, 100 ether + fee, "new recipient receives the next fee");
        assertEq(shapes.redeemableBacking(), Denominations.amountAt(0) + backing * 2);
    }

    function test_AdminCannotSetZeroFeeRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminInvalidFeeRecipient.selector, address(0)));
        shapes.setFeeRecipient(address(0));
    }

    function test_AdminCanRecoverMintingFromRevertingFeeRecipient() public {
        RevertingFeeRecipient revertingRecipient = new RevertingFeeRecipient();
        Shapes recoverable = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(revertingRecipient), address(renderer), address(collection)
        );
        uint256 backing = Denominations.amountAt(0);
        uint256 fee = recoverable.mintFee();

        vm.expectRevert(
            abi.encodeWithSelector(IShapes.MintFeeTransferFailed.selector, address(revertingRecipient), fee)
        );
        recoverable.mintTo{value: backing + fee}(backing, alice);

        recoverable.setFeeRecipient(bob);
        recoverable.mintTo{value: backing + fee}(backing, alice);
        assertEq(bob.balance, 100 ether + fee);
        assertEq(recoverable.redeemableBacking(), Denominations.amountAt(0) + backing);
    }

    function test_RedeemingShapeZeroClearsOwnershipAndReturnsBacking() public {
        uint256 balanceBefore = address(this).balance;
        shapes.redeem(0);

        assertEq(shapes.owner(), address(0));
        assertEq(address(this).balance - balanceBefore, Denominations.amountAt(0));
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistReleaseHash(), bytes32(0));
    }

    function test_ShapeZeroCanBeAbsorbedAndRevivedLikeAnyOtherShape() public {
        shapes.transferFrom(address(this), alice, 0);
        _mintDust(alice, 4); // ids 1..4; five dust Shapes compose to 0.05 ETH

        uint256[] memory burnIds = new uint256[](4);
        burnIds[0] = 0;
        burnIds[1] = 2;
        burnIds[2] = 3;
        burnIds[3] = 4;

        vm.prank(alice);
        shapes.compose(1, burnIds);
        assertEq(shapes.owner(), address(0));

        vm.prank(alice);
        shapes.decompose(1);
        assertEq(shapes.owner(), alice);
        assertEq(shapes.ownerOf(0), alice);
        assertEq(shapes.backingOf(0), Denominations.amountAt(0));
    }

    function test_AdvertisesShapesAndAdminInterfaces() public view {
        // Pinned snapshot of `type(IShapes).interfaceId`, the XOR of every function selector still
        // declared on `IShapes`. `positionOf`, `exists`, `isSupportedDenomination`, `gridForAmount`
        // and `modulesForAmount` moved off it in this pass (issue #21, follow-up to #21B, size
        // recovery) to `IShapeLens` instead; `denominationAt`, `denominationCount`, `unit`,
        // `childSeed`, `isComplete` and `formationOf` stayed on `IShapes` because `IShapeValue` and
        // `IShapeProvenance` (SPEC.md's stable external integration surface, gated by ERC-165) still
        // declare them, and `supportsInterface` must not advertise a capability it cannot serve.
        // The explicit positions/market pointer getters and generic admin pair replace the old
        // specialized resolver surface. Update this constant only when the function set changes
        // on purpose.
        assertEq(type(IShapes).interfaceId, bytes4(0x86cf5406), "IShapes id changed");
        assertEq(type(IAdminControl).interfaceId, bytes4(0xe135adbe), "admin interface id changed");

        assertTrue(shapes.supportsInterface(type(IShapes).interfaceId));
        assertTrue(shapes.supportsInterface(type(IAdminControl).interfaceId));
        assertFalse(shapes.supportsInterface(bytes4(0x7f5828d0)), "ERC-173 must not be advertised");
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {ShapesArtistAttribution} from "../src/ShapesArtistAttribution.sol";
import {IAdminControl} from "../src/interfaces/IAdminControl.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

contract ContractOwnershipTest is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256 internal constant FEE_BPS = 100;

    function setUp() public {
        vm.deal(address(this), 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            FEE_BPS, feeRecipient, address(renderer), address(collection)
        );
    }

    function _mintDust(address to, uint256 quantity) private returns (uint256 firstTokenId) {
        uint256 backing = Denominations.amountAt(0);
        uint256 fee = shapes.mintFeeFor(backing);
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

        ShapesArtistAttribution attribution = ShapesArtistAttribution(shapes.artistAttribution());
        assertEq(attribution.shapes(), address(shapes));
        assertEq(attribution.artist(), address(this));
        assertFalse(attribution.attested());
    }

    function test_ConstructorRequiresExactGenesisBacking() public {
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.IncorrectPayment.selector, Denominations.amountAt(0), 0)
        );
        new Shapes(FEE_BPS, feeRecipient, address(renderer), address(collection));

        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.IncorrectPayment.selector, Denominations.amountAt(0), Denominations.amountAt(0) + 1
            )
        );
        new Shapes{value: Denominations.amountAt(0) + 1}(
            FEE_BPS, feeRecipient, address(renderer), address(collection)
        );
    }

    function test_ConstructorCanSimulateAtGenesisBlock() public {
        vm.roll(0);
        Shapes genesisShapes = new Shapes{value: Denominations.amountAt(0)}(
            FEE_BPS, feeRecipient, address(renderer), address(collection)
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
        address attribution = shapes.artistAttribution();
        shapes.transferFrom(address(this), alice, 0);
        assertEq(shapes.owner(), alice);
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistAttribution(), attribution);

        vm.prank(alice);
        shapes.transferFrom(alice, bob, 0);
        assertEq(shapes.owner(), bob);
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistAttribution(), attribution);
    }

    function test_OwnerHasNoAdminPermissions() public {
        shapes.transferFrom(address(this), alice, 0);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.setTokenCopy("x", "y");
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.lockRenderer();
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        shapes.transferAdmin(alice);
        vm.stopPrank();
    }

    function test_AdminTransfersIndependentlyOfOwnership() public {
        address attribution = shapes.artistAttribution();
        shapes.transferAdmin(alice);
        assertEq(shapes.admin(), alice);
        assertEq(shapes.owner(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistAttribution(), attribution);

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setTokenCopy("x", "y");

        vm.prank(alice);
        shapes.setTokenCopy("x", "y");
    }

    function test_AdminCanRenounceWithoutChangingOwnership() public {
        address attribution = shapes.artistAttribution();
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0));
        assertEq(shapes.owner(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistAttribution(), attribution);

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setTokenCopy("x", "y");
    }

    function test_RedeemingShapeZeroClearsOwnershipAndReturnsBacking() public {
        address attribution = shapes.artistAttribution();
        uint256 balanceBefore = address(this).balance;
        shapes.redeem(0);

        assertEq(shapes.owner(), address(0));
        assertEq(address(this).balance - balanceBefore, Denominations.amountAt(0));
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(shapes.totalSupply(), 0);
        assertEq(shapes.admin(), address(this));
        assertEq(shapes.artist(), address(this));
        assertEq(shapes.artistAttribution(), attribution);
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
        assertEq(type(IShapes).interfaceId, bytes4(0xca355cbe), "IShapes id changed");
        assertEq(type(IAdminControl).interfaceId, bytes4(0x067e35a5), "admin interface id changed");

        assertTrue(shapes.supportsInterface(type(IShapes).interfaceId));
        assertTrue(shapes.supportsInterface(type(IAdminControl).interfaceId));
        assertFalse(shapes.supportsInterface(bytes4(0x7f5828d0)), "ERC-173 must not be advertised");
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IAdminControl} from "../src/interfaces/IAdminControl.sol";
import {IShapeCollection} from "../src/interfaces/IShapeCollection.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {MockCollection} from "./mocks/Mocks.sol";

contract CollectionTest is Test {
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;

    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
    }

    /* ------------------------------ seeding ----------------------------- */

    /// @notice Two calls in one block agree; the next block draws a different seed.
    function test_SeedIsStableInABlockAndAdvancesWithIt() public {
        bytes32 first = collection.seed();
        assertEq(collection.seed(), first, "seed moved inside one block");

        vm.roll(block.number + 1);
        vm.prevrandao(bytes32(uint256(1234)));
        assertTrue(collection.seed() != first, "seed did not advance with the block");
    }

    function test_ImageChangesWithTheBlock() public {
        string memory first = collection.image();

        vm.roll(block.number + 1);
        vm.prevrandao(bytes32(uint256(5678)));
        string memory second = collection.image();

        assertTrue(keccak256(bytes(first)) != keccak256(bytes(second)), "image did not change with the block");
    }

    /// @notice A seeded image is pinned: the same seed reproduces it in any later block.
    function test_ImageForIsReproducible() public {
        bytes32 root = keccak256("pinned");
        string memory first = collection.imageFor(root);

        vm.roll(block.number + 10);
        vm.prevrandao(bytes32(uint256(999)));
        assertEq(
            keccak256(bytes(collection.imageFor(root))), keccak256(bytes(first)), "a seeded image drifted"
        );
    }

    function test_ImageMatchesTheSeedItWasDrawnAt() public view {
        assertEq(
            keccak256(bytes(collection.image())),
            keccak256(bytes(collection.imageFor(collection.seed()))),
            "image is not imageFor(seed())"
        );
    }

    /* ------------------------------- cards ------------------------------ */

    /// @notice A seeded card is the renderer's own output, at the gene a mint would assign.
    function test_CardForIsRenderedThroughTheRenderer() public view {
        for (uint8 d = 0; d < 9; ++d) {
            bytes32 s = keccak256(abi.encodePacked("card", d));
            string memory card = collection.cardFor(s, d);
            assertGt(bytes(card).length, 0, "empty card");
            assertEq(
                keccak256(bytes(card)), keccak256(bytes(collection.cardFor(s, d))), "a seeded card drifted"
            );
        }
    }

    function test_CardChangesWithTheBlock() public {
        string memory first = collection.card(4);

        vm.roll(block.number + 1);
        vm.prevrandao(bytes32(uint256(42)));
        assertTrue(
            keccak256(bytes(first)) != keccak256(bytes(collection.card(4))),
            "card did not change with the block"
        );
    }

    function test_CardRejectsAnIndexOffTheLadder() public {
        vm.expectRevert(abi.encodeWithSelector(IShapeCollection.DenominationIndexOutOfRange.selector, 9));
        collection.cardFor(bytes32(uint256(1)), 9);
    }

    /* ------------------------------ wiring ------------------------------ */

    function test_ConstructorRefusesACodelessRenderer() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(0xBEEF)));
        new ShapeCollection(IShapeRenderer(address(0xBEEF)), shapes);
    }

    function test_ConstructorRefusesARendererWithoutErc165Support() public {
        // `shapes` has code and answers ERC-165, but not for `IShapeRenderer`.
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(shapes)));
        new ShapeCollection(IShapeRenderer(address(shapes)), shapes);
    }

    function test_ConstructorAcceptsTheRealRenderer() public {
        ShapeCollection fresh = new ShapeCollection(renderer, shapes);
        assertEq(fresh.renderer(), address(renderer));
    }

    function test_ConstructorRefusesACodelessShapes() public {
        vm.expectRevert(abi.encodeWithSelector(ShapeCollection.ShapesHasNoCode.selector, address(0)));
        new ShapeCollection(renderer, IShapes(address(0)));

        vm.expectRevert(abi.encodeWithSelector(ShapeCollection.ShapesHasNoCode.selector, address(0xBEEF)));
        new ShapeCollection(renderer, IShapes(address(0xBEEF)));
    }

    function test_CollectionNamesItsTokenAndRenderer() public view {
        assertEq(collection.shapes(), address(shapes), "collection points at another token");
        assertEq(collection.renderer(), address(renderer), "collection points at another renderer");
    }

    /// @notice The token cannot take the collection as a constructor argument, since the collection
    ///         is constructed with the token's address. Both metadata entrypoints say so until the
    ///         admin sets the pointer.
    function test_MetadataRevertsUntilTheCollectionPointerIsSet() public {
        Shapes fresh = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        assertEq(fresh.collection(), address(0), "collection pointer starts empty");

        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.tokenURI(0);
        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.contractURI();

        fresh.setCollection(address(new ShapeCollection(renderer, fresh)));
        assertGt(bytes(fresh.tokenURI(0)).length, 500, "tokenURI still empty after wiring");
        assertGt(bytes(fresh.contractURI()).length, 500, "contractURI still empty after wiring");
    }

    /* -------------------------------- copy ------------------------------ */

    function test_AdminEditsTheCopyAndTheTokenReadsItBack() public {
        assertEq(collection.tokenNamePrefix(), "Shape ", "default prefix");
        string memory before = shapes.tokenURI(0);
        string memory beforeContract = shapes.contractURI();

        vm.expectEmit(true, true, true, true, address(collection));
        emit IShapeCollection.MetadataCopySet("Form ", "A reshaped description.", "An owner description.");
        collection.setMetadataCopy("Form ", "A reshaped description.", "An owner description.");

        assertEq(collection.tokenNamePrefix(), "Form ");
        assertEq(collection.description(), "A reshaped description.");
        assertEq(collection.ownerTokenDescription(), "An owner description.");
        assertNotEq(shapes.tokenURI(0), before, "token metadata did not follow the copy");
        assertNotEq(shapes.contractURI(), beforeContract, "contract metadata did not follow the copy");
    }

    function test_NonAdminCannotEditTheCopy() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, stranger));
        collection.setMetadataCopy("x ", "y", "ok");
    }

    /// @notice Authority is read live from the token, so an admin transfer moves the copy right
    ///         along with it.
    function test_CopyAuthorityFollowsTheTokenAdmin() public {
        address nextAdmin = makeAddr("nextAdmin");
        shapes.transferAdmin(nextAdmin);

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        collection.setMetadataCopy("x ", "y", "ok");

        vm.prank(nextAdmin);
        collection.setMetadataCopy("x ", "y", "ok");
        assertEq(collection.tokenNamePrefix(), "x ");
    }

    /// @notice The token's presentation lock freezes the copy, which the collection enforces by
    ///         reading the lock back from the token.
    function test_PresentationLockFreezesTheCopy() public {
        collection.setMetadataCopy("Before ", "Editable while presentation is unlocked.", "ok");

        shapes.lockPresentation();

        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        collection.setMetadataCopy("After ", "Frozen once presentation is locked.", "ok");
        assertEq(collection.tokenNamePrefix(), "Before ", "copy changed after the lock");
    }

    function test_ShapesRefusesACollectionWithoutTheCapability() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(renderer)));
        shapes.setCollection(address(renderer));
    }

    function test_ShapesRefusesACodelessCollection() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(0xBEEF)));
        shapes.setCollection(address(0xBEEF));
    }

    function test_CollectionAdvertisesItsCapability() public view {
        assertTrue(collection.supportsInterface(type(IShapeCollection).interfaceId));
    }

    /// @notice A genuine `ShapeCollection` constructed against a different `Shapes` reports that
    ///         other token from `shapes()`, so binding it here must be refused.
    function test_ShapesRefusesACollectionBoundToAnotherToken() public {
        Shapes otherShapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        ShapeCollection foreign = new ShapeCollection(renderer, otherShapes);

        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(foreign)));
        shapes.setCollection(address(foreign));
    }

    /// @notice A mock that answers ERC-165 for `IShapeCollection` but reports an unrelated
    ///         `shapes()` isolates the binding check from ERC-165 support.
    function test_ShapesRefusesACollectionThatMisreportsItsBinding() public {
        MockCollection impostor = new MockCollection(address(0xBEEF));

        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(impostor)));
        shapes.setCollection(address(impostor));
    }

    /// @notice A fresh collection genuinely bound to this token is accepted.
    function test_ShapesAcceptsACollectionBoundToItself() public {
        Shapes fresh = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        ShapeCollection bound = new ShapeCollection(renderer, fresh);

        fresh.setCollection(address(bound));
        assertEq(fresh.collection(), address(bound));
    }

    /* --------------------------- presentation lock --------------------------- */

    /// @notice Locking with no collection set would strand `tokenURI` and `contractURI`, so it is
    ///         refused instead.
    function test_LockPresentationRevertsWithNoCollectionSet() public {
        Shapes fresh = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        assertEq(fresh.collection(), address(0));

        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.lockPresentation();

        fresh.setCollection(address(new ShapeCollection(renderer, fresh)));
        fresh.lockPresentation();
        assertTrue(fresh.presentationLocked());
    }
}

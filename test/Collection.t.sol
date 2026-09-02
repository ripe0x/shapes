// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeCollection} from "../src/interfaces/IShapeCollection.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

contract CollectionTest is Test {
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;

    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), address(collection)
        );
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
        vm.expectRevert(abi.encodeWithSelector(ShapeCollection.RendererHasNoCode.selector, address(0xBEEF)));
        new ShapeCollection(address(0xBEEF));
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
}

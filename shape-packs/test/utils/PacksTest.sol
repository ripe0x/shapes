// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "shapes/Shapes.sol";
import {ShapeRenderer} from "shapes/ShapeRenderer.sol";
import {ShapeCollection} from "shapes/ShapeCollection.sol";
import {Denominations} from "shapes/lib/Denominations.sol";

import {ShapePacks} from "../../src/ShapePacks.sol";
import {ShapePackRenderer} from "../../src/ShapePackRenderer.sol";

/// @notice Shared fixture: a freshly deployed Shapes (renderer, token, collection, wired) and a
///         ShapePacks on top of it. Every test contract in this suite derives from here.
/// @dev Shapes is compiled from the submodule with the ladder the active profile selects, so the
///      same tests run against the mainnet and testnet ladders. Nothing here is mocked.
abstract contract PacksTest is Test, IERC721Receiver {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    address internal feeRecipient = address(0xFEE);
    address internal admin = address(0xAD);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    ShapeRenderer internal shapeRenderer;
    Shapes internal shapes;
    ShapeCollection internal collection;
    ShapePackRenderer internal packRenderer;
    ShapePacks internal packs;

    function setUp() public virtual {
        shapeRenderer = new ShapeRenderer();
        shapes =
            new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(shapeRenderer), 0);
        collection = new ShapeCollection(shapeRenderer, shapes);
        shapes.setCollection(address(collection));

        packRenderer = new ShapePackRenderer(address(shapes));
        packs = new ShapePacks(address(shapes), address(packRenderer), admin);

        vm.deal(alice, 100_000 ether);
        vm.deal(bob, 100_000 ether);
    }

    /// @dev The Shapes constructor safe-mints Shape #0 to its deployer, which is this contract.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /* ------------------------------ helpers ------------------------------ */

    function unit() internal pure returns (uint256) {
        return Denominations.UNIT;
    }

    function amountAt(uint256 index) internal pure returns (uint256) {
        return Denominations.amountAt(index);
    }

    /// @dev Mints one Shape of ladder index `index` to `who`, fee included.
    function mintShape(address who, uint256 index) internal returns (uint256 id) {
        uint256 amount = Denominations.amountAt(index);
        vm.prank(who);
        id = shapes.mintTo{value: amount + MINT_FEE}(amount, who);
    }

    /// @dev Mints `n` Shapes of ladder index `index` to `who`.
    function mintShapes(address who, uint256 index, uint256 n) internal returns (uint256[] memory ids) {
        uint256 amount = Denominations.amountAt(index);
        vm.prank(who);
        uint256 first = shapes.mintBatchTo{value: n * (amount + MINT_FEE)}(amount, n, who);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = first + i;
        }
    }

    function approveAll(address who) internal {
        vm.prank(who);
        shapes.setApprovalForAll(address(packs), true);
    }

    /// @dev A zeroed makeup of the right length.
    function noMints() internal view returns (uint32[] memory counts) {
        counts = new uint32[](shapes.denominationCount());
    }

    /// @dev A makeup with `count` Shapes at ladder index `index`.
    function mintsOf(uint256 index, uint32 count) internal view returns (uint32[] memory counts) {
        counts = noMints();
        counts[index] = count;
    }

    /// @dev Exact payment for a makeup, read the way the contract reads it.
    function costOf(uint32[] memory counts) internal view returns (uint256 total) {
        for (uint256 d = 0; d < counts.length; ++d) {
            total += uint256(counts[d]) * (Denominations.amountAt(d) + shapes.mintFee());
        }
    }

    function ids1(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function ids2(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    function ids3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory out) {
        out = new uint256[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }

    function noIds() internal pure returns (uint256[] memory out) {
        out = new uint256[](0);
    }
}

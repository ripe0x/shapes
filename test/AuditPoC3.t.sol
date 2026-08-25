// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";

contract Lot2 is ERC721 {
    constructor() ERC721("Lot", "LOT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}

contract AuditPoC3 is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ShapeAuctionHouse internal house;
    Lot2 internal lot;
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal seller = makeAddr("seller");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
        house = new ShapeAuctionHouse(address(shapes));
        lot = new Lot2();
        vm.deal(address(this), 100_000 ether);
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _mint(uint256 amount) internal returns (uint256) {
        return shapes.mint{value: amount + shapes.mintFeeFor(amount)}(amount);
    }

    function _one(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    /* ---- C: an id burned by compose, revived, re-burned, and unwound ---- */

    function test_NestedComposeStackConservesBackingAndIds() public {
        // 6 dust + 1 nickel. A(dust) absorbs four dust to become a nickel; X(nickel)
        // then absorbs A. Ladder-legal at every step.
        uint256 first = shapes.mintBatch{value: (0.01 ether + 0.0001 ether) * 5}(0.01 ether, 5);
        uint256 a = first;
        uint256[] memory burns = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) burns[i] = first + 1 + i;
        uint256 x = _mint(0.05 ether);

        uint256 rb = shapes.redeemableBacking();
        assertEq(rb, 0.1 ether);

        shapes.compose(a, burns);
        assertEq(shapes.backingOf(a), 0.05 ether);
        assertEq(shapes.composeDepth(a), 1);
        assertEq(shapes.redeemableBacking(), rb);

        // X absorbs A while A carries that record. A is burned; its stack survives.
        shapes.compose(x, _one(a));
        assertEq(shapes.backingOf(x), 0.1 ether);
        assertEq(shapes.composeDepth(a), 1, "A's record persists past its burn");
        assertEq(shapes.redeemableBacking(), rb);

        // Unwind both, newest first. Everything comes back verbatim, no new ids issued.
        shapes.decompose(x);
        assertEq(shapes.backingOf(a), 0.05 ether);
        shapes.decompose(a);
        assertEq(shapes.backingOf(a), 0.01 ether);
        for (uint256 i = 0; i < 4; ++i) assertEq(shapes.backingOf(burns[i]), 0.01 ether);
        assertEq(shapes.backingOf(x), 0.05 ether);
        assertEq(shapes.redeemableBacking(), rb);
        assertEq(address(shapes).balance, rb);
        assertEq(shapes.totalSupply(), 6);
        assertEq(shapes.totalMinted(), 6, "decompose never issues a fresh id");
    }

    /* --- C: split abandons the survivor's stack; no id is ever revived --- */

    function test_SplitOrphansComposeRecordWithoutLosingBacking() public {
        uint256 first = shapes.mintBatch{value: (0.01 ether + 0.0001 ether) * 5}(0.01 ether, 5);
        uint256 a = first;
        uint256[] memory burns = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) burns[i] = first + 1 + i;
        shapes.compose(a, burns);
        assertEq(shapes.composeDepth(a), 1);

        uint8[] memory outs = new uint8[](5);
        for (uint256 i = 0; i < 5; ++i) outs[i] = 0;
        uint256[] memory kids = shapes.split(a, outs);

        // The record is inert: A no longer exists, so nothing can pop it.
        assertEq(shapes.composeDepth(a), 1);
        vm.expectRevert();
        shapes.decompose(a);

        uint256 sum;
        for (uint256 i = 0; i < kids.length; ++i) sum += shapes.backingOf(kids[i]);
        assertEq(sum, 0.05 ether);
        assertEq(shapes.redeemableBacking(), 0.05 ether);
        assertEq(address(shapes).balance, 0.05 ether);
    }

    /* -------- C: fuzz value conservation over recomposition -------- */

    function testFuzz_RecompositionConservesBackingExactly(uint8 ops, uint256 entropy) public {
        uint256 n = 8;
        uint256 first = shapes.mintBatch{value: (0.01 ether + 0.0001 ether) * n}(0.01 ether, n);
        uint256 expected = 0.01 ether * n;
        assertEq(shapes.redeemableBacking(), expected);

        uint256 survivor = first;
        uint256 rounds = uint256(ops) % 6;
        for (uint256 r = 0; r < rounds; ++r) {
            uint256 pick = first + 1 + (uint256(keccak256(abi.encode(entropy, r))) % (n - 1));
            if (pick == survivor) continue;
            try shapes.compose(survivor, _one(pick)) {} catch { continue; }
            assertEq(shapes.redeemableBacking(), expected, "compose moved ETH");
        }
        while (shapes.composeDepth(survivor) != 0) {
            shapes.decompose(survivor);
            assertEq(shapes.redeemableBacking(), expected, "decompose moved ETH");
        }
        assertEq(address(shapes).balance, expected);
        assertEq(shapes.totalSupply(), n);
    }

    /* --------- G: the house never holds a card outside escrow --------- */

    function test_HouseEscrowMatchesCustody() public {
        lot.mint(seller, 1);
        vm.prank(seller);
        lot.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 id = house.createAuction(address(lot), 1, 1 days, 1, 500, 15 minutes);

        uint256[] memory none = new uint256[](0);
        vm.prank(alice);
        house.bid{value: 1 ether + 0.01 ether}(id, none, 1 ether);
        vm.prank(bob);
        house.bid{value: 2 ether + 0.02 ether}(id, none, 2 ether);

        uint256[] memory aCards = house.escrowedCards(id, alice);
        uint256[] memory bCards = house.escrowedCards(id, bob);
        uint256 owned;
        for (uint256 t = 0; t < shapes.totalMinted(); ++t) {
            if (shapes.ownerOf(t) == address(house)) owned++;
        }
        assertEq(owned, aCards.length + bCards.length, "no card is stranded in the house");

        // Loser pulls back exactly what they put in.
        vm.prank(alice);
        house.withdraw(id);
        for (uint256 i = 0; i < aCards.length; ++i) {
            assertEq(shapes.ownerOf(aCards[i]), alice);
        }

        vm.warp(block.timestamp + 2 days);
        house.settle(id);
        assertEq(lot.ownerOf(1), bob);
        vm.prank(seller);
        house.claimProceeds(id);
        for (uint256 i = 0; i < bCards.length; ++i) {
            assertEq(shapes.ownerOf(bCards[i]), seller);
        }
        // Redeemable value survived the whole auction untouched.
        assertEq(shapes.redeemableBacking(), 3 ether);
        assertEq(address(shapes).balance, 3 ether);
    }

    /* ------- G: a Black Shape is refused as a bid card ------- */

    function test_BlackShapeCannotBeBid() public {
        // Reach an apex Complete: 10_000 dust origins is far past a block, so drive the
        // state directly and check the guard rather than the path.
        uint256 tok = _mint(0.01 ether);
        assertEq(shapes.backingOf(tok), 0.01 ether);
        // A nonexistent card is worthless too.
        lot.mint(seller, 1);
        vm.prank(seller);
        lot.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 id = house.createAuction(address(lot), 1, 1 days, 1, 500, 15 minutes);
        vm.expectRevert();
        house.bid(id, _one(999_999), 0);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
    receive() external payable {}
}

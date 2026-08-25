// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";

contract Lot3 is ERC721 {
    constructor() ERC721("Lot", "LOT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}

/// @dev A fee recipient that pushes one of its own Shapes into the house the moment it is
///      handed the mint fee. That is exactly the window in which `_minting` is true.
contract PushingFeeRecipient is IERC721Receiver {
    Shapes public shapes;
    address public house;
    uint256 public payload;
    bool public armed;

    function arm(Shapes s, address h, uint256 tokenId) external {
        shapes = s;
        house = h;
        payload = tokenId;
        armed = true;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        shapes.safeTransferFrom(address(this), house, payload);
    }
}

contract RevertingFee {
    receive() external payable { revert("no"); }
}

contract AuditPoC4 is Test {
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        vm.deal(address(this), 100_000 ether);
    }

    /* --- L: a card can be stranded in the house during the mint window --- */

    function test_PoC_FeeRecipientCanStrandACardInTheHouse() public {
        PushingFeeRecipient fee = new PushingFeeRecipient();
        Shapes shapes = new Shapes(100, address(fee), address(renderer), address(collection));
        ShapeAuctionHouse house = new ShapeAuctionHouse(address(shapes));
        Lot3 lot = new Lot3();

        address alice = makeAddr("alice");
        address seller = makeAddr("seller");
        vm.deal(alice, 100 ether);
        vm.deal(address(fee), 10 ether);

        // The fee recipient owns a card of its own.
        vm.prank(address(fee));
        uint256 payload = shapes.mint{value: 0.01 ether + 0.0001 ether}(0.01 ether);
        assertEq(shapes.ownerOf(payload), address(fee));

        lot.mint(seller, 1);
        vm.prank(seller);
        lot.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 id = house.createAuction(address(lot), 1, 1 days, 1, 500, 15 minutes);

        // Sending a card to the house normally is refused.
        vm.prank(address(fee));
        vm.expectRevert(
            abi.encodeWithSelector(IShapeAuctionHouse.UnsolicitedToken.selector, address(fee))
        );
        shapes.safeTransferFrom(address(fee), address(house), payload);

        // Inside the ETH bid path it is not: the fee call reenters while `_minting` is true.
        fee.arm(shapes, address(house), payload);
        uint256[] memory none = new uint256[](0);
        vm.prank(alice);
        house.bid{value: 1 ether + 0.01 ether}(id, none, 1 ether);

        assertEq(shapes.ownerOf(payload), address(house), "card pushed in");

        // It is in nobody's escrow, so no house function can ever move it out again.
        uint256[] memory esc = house.escrowedCards(id, alice);
        for (uint256 i = 0; i < esc.length; ++i) {
            assertTrue(esc[i] != payload);
        }
        assertEq(house.escrowedCards(id, address(fee)).length, 0);

        vm.prank(address(fee));
        vm.expectRevert(
            abi.encodeWithSelector(IShapeAuctionHouse.NothingToWithdraw.selector, id, address(fee))
        );
        house.withdraw(id);
    }

    /* ------- A: a reverting fee recipient bricks minting, not redeeming ------- */

    function test_RevertingFeeRecipientIsRedeemOnly() public {
        RevertingFee fee = new RevertingFee();
        Shapes shapes = new Shapes(100, address(fee), address(renderer), address(collection));

        vm.expectRevert();
        shapes.mint{value: 0.01 ether + 0.0001 ether}(0.01 ether);

        // With a zero fee the same recipient is harmless, which is the documented escape.
        Shapes free = new Shapes(0, address(fee), address(renderer), address(collection));
        uint256 id = free.mint{value: 0.01 ether}(0.01 ether);
        uint256 before = address(this).balance;
        free.redeem(id);
        assertEq(address(this).balance - before, 0.01 ether);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
    receive() external payable {}
}

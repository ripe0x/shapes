// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";

contract Token0Test is Test {
    Shapes shapes;
    ShapeRenderer renderer;
    ShapeCollection collection;
    ShapeAuctionHouse house;
    address artist = makeAddr("artist");
    address stranger = makeAddr("stranger");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, makeAddr("fee"), address(renderer), address(collection));
        house = new ShapeAuctionHouse(address(shapes));
        vm.deal(artist, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    /// Is minting permissionless, and is #0 first-come?
    function test_AnyoneCanTakeTokenZero() public {
        vm.prank(stranger);
        uint256 id = shapes.mint{value: 0.0101 ether}(0.01 ether, stranger);
        assertEq(id, 0, "the first minter takes #0");
        assertEq(shapes.ownerOf(0), stranger);
    }

    /// Can a Shape be minted straight into the auction house?
    function test_CannotMintDirectlyToTheHouse() public {
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.UnsolicitedToken.selector, address(0)));
        shapes.mint{value: 0.0101 ether}(0.01 ether, address(house));
    }

    /// The intended flow: artist owns it, then escrows it.
    function test_ArtistMintsThenEscrows() public {
        vm.prank(artist);
        uint256 id = shapes.mint{value: 0.0101 ether}(0.01 ether, artist);
        assertEq(shapes.ownerOf(id), artist, "artist owns it first");

        vm.prank(artist);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 a = house.createAuction(address(shapes), id, 24 hours, 1, 500, 15 minutes);

        assertEq(shapes.ownerOf(id), address(house), "house escrows it");
        assertEq(house.auctions(a).seller, artist, "artist is the seller");
    }

    /// `mint` and `mintBatch` both take a recipient, so a Shape can be minted straight to
    /// someone else. The payer and the owner need not be the same address.
    function test_MintsToAnyRecipient() public {
        vm.prank(artist);
        uint256 id = shapes.mint{value: 0.0101 ether}(0.01 ether, stranger);
        assertEq(shapes.ownerOf(id), stranger, "minted to the named recipient, not the payer");

        vm.prank(artist);
        uint256 first = shapes.mintBatch{value: 3 * 0.0101 ether}(0.01 ether, 3, stranger);
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(shapes.ownerOf(first + i), stranger, "batch honours the recipient too");
        }
        assertEq(shapes.balanceOf(artist), 0, "the payer holds none of them");
    }

    /// The recipient does not feed the seed, so naming a different one cannot be used to fish
    /// for a particular artwork.
    function test_RecipientDoesNotMoveTheSeed() public {
        uint256 snap = vm.snapshotState();
        vm.prank(artist);
        shapes.mint{value: 0.0101 ether}(0.01 ether, artist);
        bytes32 toSelf = shapes.seedOf(0);

        vm.revertToState(snap);
        vm.prank(artist);
        shapes.mint{value: 0.0101 ether}(0.01 ether, stranger);
        assertEq(shapes.seedOf(0), toSelf, "the recipient changed the seed");
    }

    /// Could someone open an auction on a token they do not own?
    function test_StrangerCannotAuctionTheArtistsToken() public {
        vm.prank(artist);
        uint256 id = shapes.mint{value: 0.0101 ether}(0.01 ether, artist);
        vm.prank(stranger);
        vm.expectRevert();
        house.createAuction(address(shapes), id, 24 hours, 1, 500, 15 minutes);
    }
}

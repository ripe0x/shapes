// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeCardEscrow} from "../src/interfaces/IShapeCardEscrow.sol";
import {Denominations} from "../src/lib/Denominations.sol";

contract Token0Test is Test {
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
    Shapes shapes;
    ShapeRenderer renderer;
    ShapeCollection collection;
    ShapeAuctionHouse house;
    address artist = makeAddr("artist");
    address stranger = makeAddr("stranger");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            100, makeAddr("fee"), address(renderer), address(collection)
        );
        house = new ShapeAuctionHouse(address(shapes));
        vm.deal(artist, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    /// Genesis #0 is atomic and permissionless artwork minting begins at #1.
    function test_DeployerGetsTokenZeroAndFirstPublicMintIsOne() public {
        assertEq(shapes.ownerOf(0), address(this));
        assertEq(shapes.owner(), address(this));

        vm.prank(stranger);
        uint256 id = shapes.mint{value: (DENOMS[0] * 101) / 100}(DENOMS[0]);
        assertEq(id, 1, "the first public minter takes #1");
        assertEq(shapes.ownerOf(1), stranger);
        assertEq(shapes.ownerOf(0), address(this));
    }

    /// Shape #0 can be auctioned later through the ordinary lot path. While escrowed, its literal
    /// ERC721 owner, and therefore `Shapes.owner()`, is the house; admin remains independent.
    function test_DeployerCanAuctionShapeZeroLater() public {
        shapes.approve(address(house), 0);
        uint256 auctionId = house.createAuction(address(shapes), 0, 24 hours, 0, 500, 15 minutes);

        assertEq(shapes.owner(), address(house));
        assertEq(shapes.admin(), address(this));

        house.cancelAuction(auctionId);
        house.claimLot(auctionId);

        assertEq(shapes.owner(), address(this));
        assertEq(shapes.admin(), address(this));
    }

    /// Can a Shape be minted straight into the auction house?
    function test_CannotMintDirectlyToTheHouse() public {
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.UnsolicitedToken.selector, address(0)));
        shapes.mintTo{value: (DENOMS[0] * 101) / 100}(DENOMS[0], address(house));
    }

    /// The intended flow: artist owns it, then escrows it.
    function test_ArtistMintsThenEscrows() public {
        vm.prank(artist);
        uint256 id = shapes.mint{value: (DENOMS[0] * 101) / 100}(DENOMS[0]);
        assertEq(shapes.ownerOf(id), artist, "artist owns it first");

        vm.prank(artist);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 a = house.createAuction(address(shapes), id, 24 hours, 1, 500, 15 minutes);

        assertEq(shapes.ownerOf(id), address(house), "house escrows it");
        assertEq(house.auctions(a).seller, artist, "artist is the seller");
    }

    /// The bare forms mint to the caller; the `To` forms name a recipient. Same convention as
    /// `redeem`/`redeemTo` and `split`/`splitTo`.
    function test_BareMintGoesToTheCaller() public {
        vm.prank(artist);
        uint256 id = shapes.mint{value: (DENOMS[0] * 101) / 100}(DENOMS[0]);
        assertEq(shapes.ownerOf(id), artist, "bare mint went somewhere else");

        vm.prank(artist);
        uint256 first = shapes.mintBatch{value: 2 * (DENOMS[0] * 101) / 100}(DENOMS[0], 2);
        assertEq(shapes.ownerOf(first), artist);
        assertEq(shapes.ownerOf(first + 1), artist);
        assertEq(shapes.balanceOf(artist), 3);
    }

    /// `mintTo` and `mintBatchTo` name a recipient, so the payer and the owner need not be the
    /// same address.
    function test_MintsToAnyRecipient() public {
        vm.prank(artist);
        uint256 id = shapes.mintTo{value: (DENOMS[0] * 101) / 100}(DENOMS[0], stranger);
        assertEq(shapes.ownerOf(id), stranger, "minted to the named recipient, not the payer");

        vm.prank(artist);
        uint256 first = shapes.mintBatchTo{value: 3 * (DENOMS[0] * 101) / 100}(DENOMS[0], 3, stranger);
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
        uint256 selfId = shapes.mint{value: (DENOMS[0] * 101) / 100}(DENOMS[0]);
        bytes32 toSelf = shapes.seedOf(selfId);

        vm.revertToState(snap);
        vm.prank(artist);
        uint256 recipientId = shapes.mintTo{value: (DENOMS[0] * 101) / 100}(DENOMS[0], stranger);
        assertEq(recipientId, selfId, "snapshot did not reproduce the token id");
        assertEq(shapes.seedOf(recipientId), toSelf, "the recipient changed the seed");
    }

    /// Could someone open an auction on a token they do not own?
    function test_StrangerCannotAuctionTheArtistsToken() public {
        vm.prank(artist);
        uint256 id = shapes.mint{value: (DENOMS[0] * 101) / 100}(DENOMS[0]);
        vm.prank(stranger);
        vm.expectRevert();
        house.createAuction(address(shapes), id, 24 hours, 1, 500, 15 minutes);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice A plain, unrelated ERC721 collection, standing in for any NFT a seller might list.
contract PlainNFT is ERC721 {
    constructor() ERC721("Plain", "PLAIN") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @notice Exercises `ShapeAuctionHouse` selling a collection other than Shapes: full
///         create/bid/settle/claimLot lifecycle, plus the validation and bookkeeping errors that
///         only apply once the lot is not fixed to one collection
///         (`LotHasNoCode`, `LotNotERC721`, `NotTokenOwnerOrApproved`, `AuctionAlreadyExistsForToken`,
///         `LotAlreadyClaimed`, `NotLotRecipient`) and the `getAuctionFor`/`hasAuctionFor` views.
contract AuctionHouseArbitraryLotTest is Test {
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
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ShapeAuctionHouse internal house;
    PlainNFT internal nft;

    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    uint64 internal constant DURATION = 24 hours;

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
        house = new ShapeAuctionHouse(address(shapes));
        nft = new PlainNFT();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);

        nft.mint(seller, 1);
        vm.prank(seller);
        nft.setApprovalForAll(address(house), true);
        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(bob);
        shapes.setApprovalForAll(address(house), true);
    }

    function _cardFor(address to, uint256 amount) internal returns (uint256 id) {
        uint256 fee = amount / 100;
        vm.prank(to);
        id = shapes.mint{value: amount + fee}(amount);
    }

    /* --------------------------- full lifecycle --------------------------- */

    function test_SellsAPlainERC721EndToEnd() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 500, 15 minutes);
        assertEq(nft.ownerOf(1), address(house), "lot escrowed");

        uint256 card = _cardFor(alice, DENOMS[4]);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        vm.prank(alice);
        house.bid(id, ids, 0);

        skip(DURATION);
        house.settle(id);
        assertEq(nft.ownerOf(1), address(house), "settle does not deliver");

        vm.prank(alice);
        house.claimLot(id);
        assertEq(nft.ownerOf(1), alice, "winner claimed the plain NFT");

        vm.prank(seller);
        house.claimProceeds(id);
        assertEq(shapes.ownerOf(card), seller, "seller pulled the winning card");
    }

    /* ------------------------------ validation ------------------------------ */

    function test_LotWithNoCodeIsRejected() public {
        address nobody = address(0xdeaddead);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotHasNoCode.selector, nobody));
        house.createAuction(nobody, 1, DURATION, 0, 0, 0);
    }

    function test_LotNotERC721IsRejected() public {
        // The Shapes ERC-165 id claims support for many interfaces but not raw ERC721 via a
        // contract with no code at all is covered above; here a contract with code but no
        // ERC165 answer at all reverts before LotNotERC721 is even reachable, so this uses a
        // renderer (has code, does not claim ERC721) to hit LotNotERC721 specifically.
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotNotERC721.selector, address(renderer)));
        house.createAuction(address(renderer), 1, DURATION, 0, 0, 0);
    }

    function test_NotTokenOwnerOrApprovedIsRejected() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapeAuctionHouse.NotTokenOwnerOrApproved.selector, address(nft), 1, alice
            )
        );
        house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
    }

    /// @notice An approved operator, not just the owner, may list.
    function test_ApprovedOperatorCanCreateAuction() public {
        vm.prank(seller);
        nft.approve(alice, 1);
        vm.prank(alice);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
        assertEq(house.auctions(id).seller, alice, "the approved caller is the seller of record");
        assertEq(nft.ownerOf(1), address(house), "lot escrowed via the approved caller");
    }

    function test_AuctionAlreadyExistsForTokenIsRejected() public {
        nft.mint(seller, 2);
        vm.prank(seller);
        house.createAuction(address(nft), 2, DURATION, 0, 0, 0);

        // The house still holds token 2 (unsettled), so a second listing for the same token
        // reverts even though the seller is unchanged and would otherwise be authorized.
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(IShapeAuctionHouse.AuctionAlreadyExistsForToken.selector, address(nft), 2)
        );
        house.createAuction(address(nft), 2, DURATION, 0, 0, 0);
    }

    /* ------------------------------ claimLot ------------------------------ */

    function test_ClaimLotTwiceIsRejected() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
        uint256 card = _cardFor(alice, DENOMS[4]);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        vm.prank(alice);
        house.bid(id, ids, 0);
        skip(DURATION);
        house.settle(id);

        vm.prank(alice);
        house.claimLot(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotAlreadyClaimed.selector, id));
        house.claimLot(id);
    }

    function test_ClaimLotByAnyoneElseIsRejected() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
        uint256 card = _cardFor(alice, DENOMS[4]);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        vm.prank(alice);
        house.bid(id, ids, 0);
        skip(DURATION);
        house.settle(id);

        // bob is neither the winner (alice) nor the seller.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, id, bob));
        house.claimLot(id);
    }

    function test_ClaimLotRoutesToSellerWhenCancelledUnsold() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
        vm.prank(seller);
        house.cancelAuction(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, id, alice));
        house.claimLot(id);

        vm.prank(seller);
        house.claimLot(id);
        assertEq(nft.ownerOf(1), seller, "cancelled lot returned to the seller");
    }

    /// @notice The listed token is free to be relisted only after `claimLot` releases it, not at
    ///         settlement or cancellation.
    function test_TokenIsRelistableOnlyAfterClaimLot() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
        vm.prank(seller);
        house.cancelAuction(id);

        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(IShapeAuctionHouse.AuctionAlreadyExistsForToken.selector, address(nft), 1)
        );
        house.createAuction(address(nft), 1, DURATION, 0, 0, 0);

        vm.prank(seller);
        house.claimLot(id);

        vm.prank(seller);
        uint256 second = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);
        assertTrue(second != id, "a fresh auction id was issued");
    }

    /* -------------------------------- views -------------------------------- */

    function test_GetAuctionForAndHasAuctionFor() public {
        (bool existsBefore,) = house.getAuctionFor(address(nft), 1);
        assertFalse(existsBefore);
        assertFalse(house.hasAuctionFor(address(nft), 1));

        vm.prank(seller);
        uint256 id = house.createAuction(address(nft), 1, DURATION, 0, 0, 0);

        (bool exists, uint256 auctionId) = house.getAuctionFor(address(nft), 1);
        assertTrue(exists);
        assertEq(auctionId, id);
        assertTrue(house.hasAuctionFor(address(nft), 1));

        vm.prank(seller);
        house.cancelAuction(id);
        vm.prank(seller);
        house.claimLot(id);

        (bool existsAfter,) = house.getAuctionFor(address(nft), 1);
        assertFalse(existsAfter, "released once the lot is claimed");
        assertFalse(house.hasAuctionFor(address(nft), 1));
    }
}

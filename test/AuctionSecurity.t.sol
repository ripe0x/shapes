// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";

/// @dev H-01: transferFrom succeeds and moves nothing, and reports no ERC165 support. Now that
///      `createAuction` accepts any ERC721 collection, the exploit this used to demonstrate (a
///      contract impersonating the one fixed lot) no longer applies as such; what survives is that
///      a lot with no ERC165 claim of ERC721 support is rejected at creation, before any transfer
///      is attempted.
contract FakeLot {
    function transferFrom(address, address, uint256) external {}

    function ownerOf(uint256) external view returns (address) {
        return msg.sender;
    }
}

/// @dev I-06: an ERC721 whose `transferFrom` moves nothing but which otherwise answers `ownerOf`,
///      approval and ERC165 truthfully. Proves the post-transfer ownership check in
///      `createAuction` reverts when the house does not actually come to hold the lot.
contract NoOpShapes {
    address public immutable ownerAddress;

    constructor(address ownerAddress_) {
        ownerAddress = ownerAddress_;
    }

    function transferFrom(address, address, uint256) external {}

    function ownerOf(uint256) external view returns (address) {
        return ownerAddress;
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @dev L-02: a contract fee recipient. It gains control when the Shapes mint fee is forwarded to
///      it, which happens inside the house's bid-path mint, and tries to push a Shape it owns into
///      the house through `safeTransferFrom`. The house must refuse it: the inbound `from` is this
///      contract, not `address(0)`, so `onERC721Received` reverts and the Shape is never stranded.
contract MaliciousFeeRecipient is IERC721Receiver {
    Shapes public shapes;
    address public house;
    uint256 public held;
    bool public armed;

    function setTargets(Shapes shapes_, address house_) external {
        shapes = shapes_;
        house = house_;
    }

    function acquire(uint256 amount) external returns (uint256) {
        held = shapes.mint{value: amount + shapes.mintFeeFor(amount)}(amount);
        return held;
    }

    function arm() external {
        armed = true;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (armed) {
            armed = false; // one shot: the fee forwards once per denomination minted
            try IERC721(address(shapes)).safeTransferFrom(address(this), house, held) {} catch {}
        }
    }
}

contract AuctionSecurityTest is Test {
    Shapes shapes;
    ShapeRenderer renderer;
    ShapeCollection collection;
    ShapeAuctionHouse house;
    address seller = makeAddr("seller");
    address alice = makeAddr("alice");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, makeAddr("fee"), address(renderer), address(collection));
        vm.deal(seller, 10 ether);
        house = new ShapeAuctionHouse(address(shapes));
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
    }

    /// @notice H-01. A lot whose `transferFrom` returns without moving anything would let a
    ///         seller collect a real winning bid for a lot that never changed hands. The house
    ///         cannot tell such a contract from an honest one after the fact, so it screens at
    ///         creation instead: a lot with no ERC165 claim of ERC721 support is rejected before
    ///         any transfer is attempted. `FakeLot` has no `supportsInterface` at all, so the call
    ///         reverts with no return data.
    function test_H01_ALotWithNoERC165SupportIsRejected() public {
        FakeLot fake = new FakeLot();

        vm.prank(seller);
        vm.expectRevert();
        house.createAuction(address(fake), 1, 1 days, 100, 0, 0);

        assertEq(house.auctionCount(), 0, "no auction was opened over a non-conforming contract");
    }

    /// @notice H-02. `settle` moves nothing and touches no collection, so it cannot be blocked by
    ///         the lot: the outcome is always recordable, and every losing bidder's escrow and the
    ///         seller's proceeds, which move Shapes alone, are reachable regardless of the lot.
    ///         Delivery is `claimLot`, called separately by the winner.
    function test_H02_SettlementCannotBeBlockedByTheLot() public {
        vm.prank(seller);
        uint256 lot = shapes.mint{value: 0.101 ether}(0.1 ether);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 a = house.createAuction(address(shapes), lot, 1, 100, 0, 0);

        vm.prank(alice);
        uint256 card = shapes.mint{value: 1.01 ether}(1 ether);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        vm.prank(alice);
        house.bid(a, ids, 0);

        skip(2);
        house.settle(a); // completes; nothing can interpose
        assertEq(shapes.ownerOf(lot), address(house), "settle does not deliver the lot");

        vm.prank(alice);
        house.claimLot(a);
        assertEq(shapes.ownerOf(lot), alice, "winner received the lot");

        vm.prank(seller);
        house.claimProceeds(a);
        assertEq(shapes.ownerOf(card), seller, "seller received the bid, having delivered");
    }

    /// @notice M-02. The seller cannot bid its own auction. Shill-bidding to set a floor with cards
    ///         it later withdraws intact is refused at the source.
    function test_M02_SellerCannotBidItsOwnAuction() public {
        vm.prank(seller);
        uint256 lot = shapes.mint{value: 0.101 ether}(0.1 ether);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 a = house.createAuction(address(shapes), lot, 1 days, 1, 0, 0);

        vm.prank(seller);
        uint256 card = shapes.mint{value: 1.01 ether}(1 ether);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.SellerCannotBid.selector);
        house.bid(a, ids, 0);
    }

    /// @notice L-04. Auction timing is bounded at creation. An unbounded duration would hold every
    ///         bidder's escrow for as long as the seller chose; the extension window may not exceed
    ///         the duration it extends.
    function test_L04_DurationAndExtensionAreBounded() public {
        vm.prank(seller);
        uint256 lot = shapes.mint{value: 0.101 ether}(0.1 ether);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);

        uint64 max = house.MAX_DURATION();

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.DurationOutOfRange.selector);
        house.createAuction(address(shapes), lot, max + 1, 1, 0, 0);

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.ExtensionWindowTooLong.selector);
        house.createAuction(address(shapes), lot, 1 days, 1, 0, uint32(1 days + 1));

        // The boundaries themselves are accepted.
        vm.prank(seller);
        uint256 a = house.createAuction(address(shapes), lot, max, 1, 0, uint32(max));
        assertEq(shapes.ownerOf(lot), address(house), "lot escrowed at the boundary");
        a;
    }

    /// @notice I-06. `createAuction` confirms the house actually holds the lot after the transfer.
    ///         An `nft` whose `transferFrom` moves nothing opens no auction, even though it
    ///         otherwise answers ownership, approval and ERC165 truthfully.
    function test_I06_CreateVerifiesTheHouseHoldsTheLot() public {
        NoOpShapes fake = new NoOpShapes(seller);
        ShapeAuctionHouse fakeHouse = new ShapeAuctionHouse(address(shapes));

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.LotNotReceived.selector);
        fakeHouse.createAuction(address(fake), 1, 1 days, 1, 0, 0);

        assertEq(fakeHouse.auctionCount(), 0, "no auction over a lot the house never received");
    }

    /// @notice L-02. A contract fee recipient gains control inside the house's bid-path mint and
    ///         tries to push a Shape it owns into the house. `onERC721Received` refuses any inbound
    ///         `safeTransferFrom` (nonzero `from`) even during the mint window, so the Shape is not
    ///         stranded, and the honest bid still settles.
    function test_L02_FeeRecipientCannotStrandAShapeInTheHouse() public {
        MaliciousFeeRecipient mal = new MaliciousFeeRecipient();
        // A separate Shapes whose fee recipient is the malicious contract.
        Shapes shapes2 = new Shapes(100, address(mal), address(renderer), address(collection));
        ShapeAuctionHouse house2 = new ShapeAuctionHouse(address(shapes2));
        mal.setTargets(shapes2, address(house2));

        // The fee recipient acquires a Shape it will later try to push in.
        vm.deal(address(mal), 10 ether);
        uint256 pushed = mal.acquire(1 ether);
        assertEq(shapes2.ownerOf(pushed), address(mal), "fee recipient owns its Shape");

        // Seller opens an auction on the second house.
        address seller2 = makeAddr("seller2");
        vm.deal(seller2, 10 ether);
        vm.prank(seller2);
        uint256 lot = shapes2.mint{value: 0.101 ether}(0.1 ether);
        vm.prank(seller2);
        shapes2.setApprovalForAll(address(house2), true);
        vm.prank(seller2);
        uint256 a = house2.createAuction(address(shapes2), lot, 1 days, 1, 0, 0);

        // A bidder takes the ETH path. The mint forwards the fee to `mal`, which fires while the
        // house is minting and attempts the push.
        address carol = makeAddr("carol");
        vm.deal(carol, 10 ether);
        mal.arm();
        vm.prank(carol);
        house2.bid{value: 1.01 ether}(a, new uint256[](0), 1 ether);

        // The push was refused: the Shape stayed with the fee recipient, not the house.
        assertEq(shapes2.ownerOf(pushed), address(mal), "the pushed Shape was refused, not stranded");
        // The honest bid still went through.
        assertEq(house2.bidUnits(a, carol), 100, "carol's 1 ETH bid stands at 100 units");
    }
}

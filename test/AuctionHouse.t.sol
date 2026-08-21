// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";
import {IShapeCardEscrow} from "../src/interfaces/IShapeCardEscrow.sol";

/// @dev Refuses ERC721s. Used to prove the house never pushes a card at anyone.
contract HostileBidder is IERC721Receiver {
    ShapeAuctionHouse private immutable house;

    constructor(ShapeAuctionHouse house_) {
        house = house_;
    }

    function bid(uint256 auctionId, uint256[] calldata ids) external {
        house.bid(auctionId, ids, 0);
    }

    function approve(address shapes) external {
        IERC721(shapes).setApprovalForAll(address(house), true);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("no thanks");
    }
}

abstract contract AuctionBase is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ShapeAuctionHouse internal house;
    uint256 internal lotId;

    address internal titleHolder = makeAddr("titleHolder");

    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    uint64 internal constant DURATION = 24 hours;
    uint64 internal constant RESERVE_UNITS = 1; // 0.01 ETH
    uint16 internal constant INCREMENT_BPS = 500; // 5%
    uint32 internal constant EXTENSION = 15 minutes;

    function setUp() public virtual {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection), titleHolder);
        house = new ShapeAuctionHouse(address(shapes));

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(seller, 10 ether);

        // The lot is a Shape, which is the only collection the house will sell.
        vm.prank(seller);
        lotId = shapes.mint{value: 0.1 ether + feeOf(0.1 ether)}(0.1 ether);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(bob);
        shapes.setApprovalForAll(address(house), true);
    }

    function feeOf(uint256 wei_) internal pure returns (uint256) {
        return wei_ / 100;
    }

    function _mintCard(address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(to);
        id = shapes.mint{value: amount + feeOf(amount)}(amount);
    }

    function _open() internal returns (uint256 auctionId) {
        vm.prank(seller);
        auctionId =
            house.createAuction(address(shapes), lotId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    /// @dev Every Shape the house holds is either an escrowed bid card or a lot awaiting
    ///      settlement. If the two sides diverge, a card is stranded or claimable twice. The lot
    ///      is itself a Shape, so it counts toward the balance until it is delivered.
    function _assertEscrowExact(uint256 auctionId, address[] memory bidders) internal view {
        uint256 counted;
        for (uint256 i = 0; i < bidders.length; ++i) {
            uint256[] memory ids = house.escrowedCards(auctionId, bidders[i]);
            for (uint256 j = 0; j < ids.length; ++j) {
                assertEq(shapes.ownerOf(ids[j]), address(house), "escrowed card is not held");
                counted++;
            }
        }
        if (shapes.ownerOf(lotId) == address(house)) counted++; // the undelivered lot
        assertEq(shapes.balanceOf(address(house)), counted, "house holds unaccounted Shapes");
    }
}

contract AuctionHouseTest is AuctionBase {
    /* ---------------------------- creating ---------------------------- */

    function test_CreateEscrowsTheLotAndIdsFromZero() public {
        uint256 id = _open();
        assertEq(id, 0, "auction ids start at 0");
        assertEq(shapes.ownerOf(lotId), address(house), "lot escrowed");
        assertEq(house.auctionCount(), 1);
    }

    function test_CreateRejectsZeroDuration() public {
        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.DurationOutOfRange.selector);
        house.createAuction(address(shapes), lotId, 0, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    function test_SellerCancelsBeforeAnyBidAndNotAfter() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, 1 ether);

        vm.prank(alice);
        house.bid(id, _one(card), 0);

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.cancelAuction(id);

        vm.prank(seller);
        uint256 second = shapes.mint{value: 0.1 ether + feeOf(0.1 ether)}(0.1 ether);
        vm.prank(seller);
        uint256 fresh =
            house.createAuction(address(shapes), second, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
        vm.prank(seller);
        house.cancelAuction(fresh);
        vm.prank(seller);
        house.claimLot(fresh);
        assertEq(shapes.ownerOf(second), seller, "lot returned");
    }

    function test_OnlySellerCancels() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.cancelAuction(id);
    }

    /* ----------------------------- bidding ---------------------------- */

    function test_CardBidEscrowsAndCountsUnits() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, 1 ether);

        vm.prank(alice);
        house.bid(id, _one(card), 0);

        assertEq(shapes.ownerOf(card), address(house), "card escrowed");
        assertEq(house.bidUnits(id, alice), 100, "1 ETH is 100 units");
        assertEq(house.escrowedCards(id, alice).length, 1);
    }

    /// @notice A Black Shape reads as 100 ETH by denomination and zero by backing. Valuing off
    ///         the backing is what rejects it; this is the sharpest edge in the contract.
    function test_BlackShapeIsRejectedAsWorthless() public {
        uint256 id = _open();

        // Build an apex Complete and sacrifice it: 10,000 dust composed to 100 ETH.
        vm.prank(alice);
        uint256 first =
            shapes.mintBatchTo{value: 10_000 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 10_000, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        vm.prank(alice);
        shapes.sacrifice(first);

        assertEq(shapes.backingOf(first), 0, "a Black Shape backs nothing");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.WorthlessCard.selector, first));
        house.bid(id, _one(first), 0);
    }

    function test_NonexistentCardIsRejected() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert();
        house.bid(id, _one(999), 0);
    }

    function test_EmptyBidReverts() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(IShapeCardEscrow.EmptyBid.selector);
        house.bid(id, _none(), 0);
    }

    /// @notice ETH sent with a cards-only bid would otherwise be unreachable forever.
    function test_StrayEthIsRejected() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, 1 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, 0, 1 ether));
        house.bid{value: 1 ether}(id, _one(card), 0);
    }

    /* --------------------------- the ETH path -------------------------- */

    function test_EthBidMintsTheMinimalCardSet() public {
        uint256 id = _open();
        uint256 backing = 1.5 ether;

        vm.prank(alice);
        house.bid{value: backing + feeOf(backing)}(id, _none(), backing);

        // Minting walks the ladder upward, so the escrow lists ascending by denomination.
        uint256[] memory ids = house.escrowedCards(id, alice);
        assertEq(ids.length, 2, "1.5 ETH is a 0.5 and a 1");
        assertEq(shapes.backingOf(ids[0]), 0.5 ether);
        assertEq(shapes.backingOf(ids[1]), 1 ether);
        assertEq(house.bidUnits(id, alice), 150);
        assertEq(shapes.ownerOf(ids[0]), address(house));
    }

    function test_EthBidRequiresTheExactFee() public {
        uint256 id = _open();
        uint256 backing = 1 ether;
        uint256 exact = backing + feeOf(backing);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, exact, backing));
        house.bid{value: backing}(id, _none(), backing);
    }

    function test_EthBidRejectsAnOffLatticeAmount() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NotAUnitMultiple.selector, 0.015 ether));
        house.bid{value: 1 ether}(id, _none(), 0.015 ether);
    }

    /// @notice The greedy breakdown is minimal on this ladder, and never exceeds twenty cards
    ///         below 100 ETH. 99.99 is the worst case.
    function test_CardsForIsMinimalAtTheWorstCase() public view {
        uint256[9] memory counts = house.cardsFor(99.99 ether);
        uint256 total;
        uint256 backing;
        uint256[9] memory amounts = [
            uint256(0.01 ether),
            0.05 ether,
            0.1 ether,
            0.5 ether,
            1 ether,
            5 ether,
            10 ether,
            50 ether,
            100 ether
        ];
        for (uint256 i = 0; i < 9; ++i) {
            total += counts[i];
            backing += counts[i] * amounts[i];
        }
        assertEq(backing, 99.99 ether, "breakdown sums to the amount");
        assertEq(total, 20, "twenty cards is the worst case below 100 ETH");
    }

    function testFuzz_CardsForAlwaysSumsExactly(uint96 units) public view {
        uint256 backing = uint256(units % 10_000) * 0.01 ether; // below 100 ETH
        uint256[9] memory counts = house.cardsFor(backing);
        uint256[9] memory amounts = [
            uint256(0.01 ether),
            0.05 ether,
            0.1 ether,
            0.5 ether,
            1 ether,
            5 ether,
            10 ether,
            50 ether,
            100 ether
        ];
        uint256 sum;
        uint256 total;
        for (uint256 i = 0; i < 9; ++i) {
            sum += counts[i] * amounts[i];
            total += counts[i];
        }
        assertEq(sum, backing, "breakdown lost or invented value");
        assertLe(total, 20, "breakdown exceeded the minimal bound");
    }

    /* ---------------------------- the ladder --------------------------- */

    function test_BidMustClearTheReserve() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(shapes), lotId, DURATION, 100, INCREMENT_BPS, EXTENSION);
        uint256 card = _mintCard(alice, 0.5 ether); // 50 units, under a 100 unit reserve

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.BidTooLow.selector, 50, 100));
        house.bid(id, _one(card), 0);
    }

    function test_IncrementIsRoundedUpToAWholeUnit() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 0.01 ether); // 1 unit
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        // 5% of one unit rounds up to one unit, so the next bid must reach two. A truncating
        // increment would demand only one and let a tie take the lead.
        assertEq(house.minimumBid(id), 2, "increment floored below a whole unit");

        uint256 b = _mintCard(bob, 0.01 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.BidTooLow.selector, 1, 2));
        house.bid(id, _one(b), 0);
    }

    function test_TopUpAddsToAnExistingBid() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        uint256 more = _mintCard(alice, 0.5 ether);
        vm.prank(alice);
        house.bid(id, _one(more), 0);

        assertEq(house.bidUnits(id, alice), 150, "top-up added rather than replaced");
        assertEq(house.escrowedCards(id, alice).length, 2);
    }

    function test_EscrowIsCappedAcrossTopUpsNotPerCall() public {
        uint256 id = _open();

        uint256[] memory ids = new uint256[](64);
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 64 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 64);
        for (uint256 i = 0; i < 64; ++i) {
            ids[i] = first + i;
        }

        vm.prank(alice);
        house.bid(id, ids, 0);
        assertEq(house.escrowedCards(id, alice).length, 64);

        uint256 oneMore = _mintCard(alice, 0.01 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.TooManyCards.selector, 65));
        house.bid(id, _one(oneMore), 0);
    }

    /* ------------------------------ timing ----------------------------- */

    function test_ClockStartsAtTheFirstBid() public {
        uint256 id = _open();
        skip(365 days);

        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0); // still live, however long it sat unbid

        assertEq(house.auctions(id).endTime, uint64(block.timestamp) + DURATION);
    }

    function test_ABidInsideTheWindowExtendsTheEnd() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint64 firstEnd = house.auctions(id).endTime;

        skip(DURATION - 60); // one minute left, inside the 15 minute window
        uint256 b = _mintCard(bob, 5 ether);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        assertEq(house.auctions(id).endTime, uint64(block.timestamp) + EXTENSION);
        assertGt(house.auctions(id).endTime, firstEnd, "the end must move out, never in");
    }

    function test_ABidOutsideTheWindowLeavesTheEndAlone() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint64 firstEnd = house.auctions(id).endTime;

        skip(1 hours); // far from the end
        uint256 b = _mintCard(bob, 5 ether);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        assertEq(house.auctions(id).endTime, firstEnd, "the end moved without cause");
    }

    function test_BiddingStopsAtTheEnd() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        skip(DURATION);
        uint256 b = _mintCard(bob, 5 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionOver.selector, id));
        house.bid(id, _one(b), 0);
    }

    /* ---------------------------- settlement --------------------------- */

    function test_SettleRecordsAndBothSidesPull() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        skip(DURATION);
        house.settle(id); // permissionless, and moves nothing
        assertEq(shapes.ownerOf(lotId), address(house), "settlement is bookkeeping, not delivery");

        vm.prank(alice);
        house.claimLot(id);
        assertEq(shapes.ownerOf(lotId), alice, "winner pulled the lot");

        vm.prank(seller);
        house.claimProceeds(id);
        assertEq(shapes.ownerOf(card), seller, "seller has the winning card");
        assertEq(shapes.balanceOf(address(house)), 0, "house holds nothing after");
    }

    function test_SettleIsRefusedBeforeTheEndAndTwice() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionStillRunning.selector, id));
        house.settle(id);

        skip(DURATION);
        house.settle(id);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionAlreadySettled.selector, id));
        house.settle(id);
    }

    function test_AnUnbidAuctionNeverEnds() public {
        uint256 id = _open();
        skip(3650 days);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionStillRunning.selector, id));
        house.settle(id);
    }

    /* ------------------------------ escrow ----------------------------- */

    function test_OutbidBidderPullsBackTheExactCards() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        uint256 b = _mintCard(bob, 5 ether);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        vm.prank(alice);
        house.withdraw(id);
        assertEq(shapes.ownerOf(a), alice, "the same card came back");
        assertEq(house.bidUnits(id, alice), 0);
        assertEq(house.escrowedCards(id, alice).length, 0);
    }

    function test_TheLeaderCannotWithdraw() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, alice));
        house.withdraw(id);
    }

    function test_TheWinnerCannotWithdrawAfterSettlement() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        skip(DURATION);
        house.settle(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, alice));
        house.withdraw(id);
    }

    function test_WithdrawingTwiceIsRefused() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint256 b = _mintCard(bob, 5 ether);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        vm.prank(alice);
        house.withdraw(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, alice));
        house.withdraw(id);
    }

    function test_OnlySellerClaimsProceeds() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        skip(DURATION);
        house.settle(id);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, bob));
        house.claimProceeds(id);
    }

    /// @notice Through a full contested auction, every card the house holds belongs to exactly
    ///         one escrow entry. Nothing stranded, nothing claimable twice.
    function test_EscrowStaysExactThroughAContest() public {
        uint256 id = _open();
        address[] memory bidders = new address[](2);
        bidders[0] = alice;
        bidders[1] = bob;

        uint256 a = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        _assertEscrowExact(id, bidders);

        vm.prank(bob);
        house.bid{value: 5 ether + feeOf(5 ether)}(id, _none(), 5 ether);
        _assertEscrowExact(id, bidders);

        uint256 a2 = _mintCard(alice, 10 ether);
        vm.prank(alice);
        house.bid(id, _one(a2), 0);
        _assertEscrowExact(id, bidders);

        vm.prank(bob);
        house.withdraw(id);
        _assertEscrowExact(id, bidders);

        skip(DURATION);
        house.settle(id);
        vm.prank(seller);
        house.claimProceeds(id);
        _assertEscrowExact(id, bidders); // the lot is still here, and still counted
        vm.prank(alice); // alice led on the 10 ETH card
        house.claimLot(id);
        _assertEscrowExact(id, bidders);
        assertEq(shapes.balanceOf(address(house)), 0);
    }

    /* ----------------------------- custody ----------------------------- */

    /// @notice The house never pushes. A bidder that refuses ERC721s can still be outbid, and the
    ///         auction runs on without them; only their own pull fails, which is their problem.
    function test_AHostileBidderCannotFreezeTheAuction() public {
        uint256 id = _open();
        HostileBidder hostile = new HostileBidder(house);

        uint256 h = _mintCard(alice, 1 ether);
        vm.prank(alice);
        shapes.transferFrom(alice, address(hostile), h);
        hostile.approve(address(shapes));
        hostile.bid(id, _one(h));
        assertEq(house.auctions(id).highestBidder, address(hostile));

        // Outbidding does not push anything at the hostile contract, so it cannot revert.
        uint256 b = _mintCard(bob, 5 ether);
        vm.prank(bob);
        house.bid(id, _one(b), 0);
        assertEq(house.auctions(id).highestBidder, bob, "the auction moved on");

        skip(DURATION);
        house.settle(id);
        vm.prank(bob);
        house.claimLot(id);
        assertEq(shapes.ownerOf(lotId), bob);
    }

    /// @notice Unsolicited Shapes are refused, so a token cannot be stranded here with no escrow
    ///         entry naming its owner.
    function test_UnsolicitedShapeIsRefused() public {
        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.UnsolicitedToken.selector, alice));
        shapes.safeTransferFrom(alice, address(house), card);
    }

    function test_UnknownAuctionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionNotFound.selector, 7));
        house.minimumBid(7);
    }
}

/// @dev Has code and answers ERC165, but is not an ERC721. Stands in for the address a seller
///      pastes by mistake.
contract NotACollection {
    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
}

/// @dev A plain, honest ERC721 from some other collection: the case the house exists to serve
///      now that the lot is not required to be a Shape.
contract ForeignCollection is ERC721 {
    constructor() ERC721("Foreign", "FRGN") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @notice A lot from a collection the house knows nothing about, priced in Shapes. The lot moves
///         only through `claimLot`, and only to the party the outcome names.
contract ForeignLotTest is AuctionBase {
    ForeignCollection internal foreign;
    uint256 internal foreignId = 7;

    function setUp() public override {
        super.setUp();
        foreign = new ForeignCollection();
        foreign.mint(seller, foreignId);
        vm.prank(seller);
        foreign.setApprovalForAll(address(house), true);
    }

    function _openForeign() internal returns (uint256 id) {
        vm.prank(seller);
        id = house.createAuction(
            address(foreign), foreignId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION
        );
    }

    function test_AForeignTokenSellsForShapes() public {
        uint256 id = _openForeign();
        assertEq(foreign.ownerOf(foreignId), address(house), "lot escrowed");
        assertEq(house.auctions(id).nft, address(foreign), "the collection is recorded");

        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        skip(DURATION);
        house.settle(id);

        vm.prank(alice);
        house.claimLot(id);
        assertEq(foreign.ownerOf(foreignId), alice, "winner holds the foreign token");

        vm.prank(seller);
        house.claimProceeds(id);
        assertEq(shapes.ownerOf(card), seller, "seller was paid in Shapes");
    }

    /// @notice A bidder who brought no Shapes still pays in them: the ETH is minted into cards.
    function test_AForeignTokenCanBeWonWithTheEthPath() public {
        uint256 id = _openForeign();
        vm.prank(bob);
        house.bid{value: 1 ether + feeOf(1 ether)}(id, _none(), 1 ether);

        skip(DURATION);
        house.settle(id);
        vm.prank(bob);
        house.claimLot(id);
        assertEq(foreign.ownerOf(foreignId), bob);
    }

    function test_LotAddressMustHaveCode() public {
        address eoa = makeAddr("notACollection");
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotHasNoCode.selector, eoa));
        house.createAuction(eoa, 1, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    function test_ClaimLotIsRefusedBeforeSettlement() public {
        uint256 id = _openForeign();
        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionStillRunning.selector, id));
        house.claimLot(id);
    }

    function test_OnlyTheWinnerClaimsTheLot() public {
        uint256 id = _openForeign();
        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);
        skip(DURATION);
        house.settle(id);

        // Not the seller, who has been outbid out of their own lot, and not a bystander.
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, id, seller));
        house.claimLot(id);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, id, bob));
        house.claimLot(id);
    }

    function test_TheLotCannotBeClaimedTwice() public {
        uint256 id = _openForeign();
        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);
        skip(DURATION);
        house.settle(id);

        vm.prank(alice);
        house.claimLot(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotAlreadyClaimed.selector, id));
        house.claimLot(id);
    }

    /// @notice An auction nobody bid on returns the lot to the seller, through the same pull.
    function test_ACancelledAuctionReturnsTheLotToTheSeller() public {
        uint256 id = _openForeign();
        vm.prank(seller);
        house.cancelAuction(id);
        assertEq(foreign.ownerOf(foreignId), address(house), "cancelling moves nothing either");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, id, alice));
        house.claimLot(id);

        vm.prank(seller);
        house.claimLot(id);
        assertEq(foreign.ownerOf(foreignId), seller, "seller pulled their lot back");
    }

    /// @notice The seller cannot list what they do not own: the post-transfer ownership check is
    ///         what an honest collection is held to.
    function test_ASellerCannotListATokenTheyDoNotOwn() public {
        foreign.mint(bob, 99);
        vm.prank(seller);
        vm.expectRevert();
        house.createAuction(address(foreign), 99, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    /* ------------------- collection checks and the token index ------------------- */

    function test_LotMustReportTheErc721Interface() public {
        NotACollection wrong = new NotACollection();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotNotERC721.selector, address(wrong)));
        house.createAuction(address(wrong), 1, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    function test_ANonOwnerWithoutApprovalCannotList() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapeAuctionHouse.NotTokenOwnerOrApproved.selector, address(foreign), foreignId, bob
            )
        );
        house.createAuction(address(foreign), foreignId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    /// @notice An operator the owner approved may list on their behalf, and the lot is pulled from
    ///         the owner rather than from the operator.
    function test_AnApprovedOperatorCanListForTheOwner() public {
        vm.prank(seller);
        foreign.setApprovalForAll(bob, true);
        vm.prank(bob);
        uint256 id = house.createAuction(
            address(foreign), foreignId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION
        );
        assertEq(foreign.ownerOf(foreignId), address(house), "pulled from the owner");
        assertEq(house.auctions(id).seller, bob, "the lister is the seller of record");
    }

    function test_TheSameTokenCannotBeListedTwice() public {
        _openForeign();
        // The house holds it now, so a second listing is refused by the index before the transfer.
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapeAuctionHouse.AuctionAlreadyExistsForToken.selector, address(foreign), foreignId
            )
        );
        house.createAuction(address(foreign), foreignId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
    }

    function test_TheTokenIndexTracksTheLotAndClearsOnClaim() public {
        (bool exists,) = house.getAuctionFor(address(foreign), foreignId);
        assertFalse(exists, "nothing indexed before the auction");

        uint256 id = _openForeign();
        (bool found, uint256 foundId) = house.getAuctionFor(address(foreign), foreignId);
        assertTrue(found, "indexed while escrowed");
        assertEq(foundId, id, "auction id 0 is a real id, not an absence");
        assertTrue(house.hasAuctionFor(address(foreign), foreignId));

        uint256 card = _mintCard(alice, 1 ether);
        vm.prank(alice);
        house.bid(id, _one(card), 0);
        skip(DURATION);
        house.settle(id);

        // Settlement does not free the token: the house still holds it until the winner pulls.
        assertTrue(house.hasAuctionFor(address(foreign), foreignId), "still held, still indexed");

        vm.prank(alice);
        house.claimLot(id);
        assertFalse(house.hasAuctionFor(address(foreign), foreignId), "freed once it left");
    }

    /// @notice Once the lot has been pulled back out of a cancelled auction it can be listed again.
    function test_ATokenCanBeRelistedAfterItIsReclaimed() public {
        uint256 first = _openForeign();
        vm.prank(seller);
        house.cancelAuction(first);
        vm.prank(seller);
        house.claimLot(first);

        vm.prank(seller);
        uint256 second = house.createAuction(
            address(foreign), foreignId, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION
        );
        assertTrue(second != first, "a fresh auction");
        assertEq(foreign.ownerOf(foreignId), address(house), "escrowed again");
    }

    function test_PlainEthSentToTheHouseIsRejected() public {
        vm.prank(alice);
        (bool sent,) = address(house).call{value: 1 ether}("");
        assertFalse(sent, "the house has no receive and holds no ETH");
    }
}

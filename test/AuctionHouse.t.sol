// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapeAuctionHouse} from "../src/interfaces/IShapeAuctionHouse.sol";
import {IShapeCardEscrow} from "../src/interfaces/IShapeCardEscrow.sol";
import {Denominations} from "../src/lib/Denominations.sol";

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
    uint256 internal lotId;

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
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), address(collection), 0
        );
        house = new ShapeAuctionHouse(address(shapes));

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(seller, 10 ether);

        // The lot is a Shape, which is the only collection the house will sell.
        vm.prank(seller);
        lotId = shapes.mint{value: DENOMS[2] + feeOf(DENOMS[2])}(DENOMS[2]);
        vm.prank(seller);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
        vm.prank(bob);
        shapes.setApprovalForAll(address(house), true);
    }

    function feeOf(uint256) internal pure returns (uint256) {
        return Denominations.UNIT / 10;
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
        uint256 card = _mintCard(alice, DENOMS[4]);

        vm.prank(alice);
        house.bid(id, _one(card), 0);

        vm.prank(seller);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.cancelAuction(id);

        vm.prank(seller);
        uint256 second = shapes.mint{value: DENOMS[2] + feeOf(DENOMS[2])}(DENOMS[2]);
        vm.prank(seller);
        uint256 fresh =
            house.createAuction(address(shapes), second, DURATION, RESERVE_UNITS, INCREMENT_BPS, EXTENSION);
        vm.prank(seller);
        house.cancelAuction(fresh);
        assertEq(shapes.ownerOf(second), address(house), "cancelAuction moves nothing");
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
        uint256 card = _mintCard(alice, DENOMS[4]);

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
            shapes.mintBatchTo{value: 10_000 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 10_000, alice);
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
        uint256 card = _mintCard(alice, DENOMS[4]);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, 0, DENOMS[4]));
        house.bid{value: DENOMS[4]}(id, _one(card), 0);
    }

    /* --------------------------- the ETH path -------------------------- */

    function test_EthBidMintsTheMinimalCardSet() public {
        uint256 id = _open();
        uint256 backing = DENOMS[3] + DENOMS[4];
        uint256 exactCost = backing + 2 * feeOf(backing);
        assertEq(house.mintCostFor(backing), exactCost, "quote charges one flat fee per card");

        vm.prank(alice);
        house.bid{value: exactCost}(id, _none(), backing);

        // Minting walks the ladder upward, so the escrow lists ascending by denomination.
        uint256[] memory ids = house.escrowedCards(id, alice);
        assertEq(ids.length, 2, "1.5 ETH is a 0.5 and a 1");
        assertEq(shapes.backingOf(ids[0]), DENOMS[3]);
        assertEq(shapes.backingOf(ids[1]), DENOMS[4]);
        assertEq(house.bidUnits(id, alice), 150);
        assertEq(shapes.ownerOf(ids[0]), address(house));
    }

    function test_EthBidRequiresTheExactFee() public {
        uint256 id = _open();
        uint256 backing = DENOMS[4];
        uint256 exact = backing + feeOf(backing);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, exact, backing));
        house.bid{value: backing}(id, _none(), backing);
    }

    function test_EthBidChargesPerGeneratedCardNotPerBid() public {
        uint256 id = _open();
        uint256 backing = DENOMS[3] + DENOMS[4];
        uint256 oneFeeShort = backing + feeOf(backing);
        uint256 exact = backing + 2 * feeOf(backing);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, exact, oneFeeShort)
        );
        house.bid{value: oneFeeShort}(id, _none(), backing);
    }

    function test_EthBidRejectsAnOffLatticeAmount() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapeCardEscrow.NotAUnitMultiple.selector, (DENOMS[0] * 3) / 2)
        );
        house.bid{value: DENOMS[4]}(id, _none(), (DENOMS[0] * 3) / 2);
    }

    /// @notice The greedy breakdown is minimal on this ladder, and never exceeds twenty cards
    ///         below 100 ETH. 99.99 is the worst case.
    function test_CardsForIsMinimalAtTheWorstCase() public view {
        uint256[9] memory counts = house.cardsFor(DENOMS[8] - DENOMS[0]);
        uint256 total;
        uint256 backing;
        uint256[9] memory amounts = [
            uint256(DENOMS[0]),
            DENOMS[1],
            DENOMS[2],
            DENOMS[3],
            DENOMS[4],
            DENOMS[5],
            DENOMS[6],
            DENOMS[7],
            DENOMS[8]
        ];
        for (uint256 i = 0; i < 9; ++i) {
            total += counts[i];
            backing += counts[i] * amounts[i];
        }
        assertEq(backing, DENOMS[8] - DENOMS[0], "breakdown sums to the amount");
        assertEq(total, 20, "twenty cards is the worst case below 100 ETH");
    }

    function testFuzz_CardsForAlwaysSumsExactly(uint96 units) public view {
        uint256 backing = uint256(units % 10_000) * DENOMS[0]; // below 100 ETH
        uint256[9] memory counts = house.cardsFor(backing);
        uint256[9] memory amounts = [
            uint256(DENOMS[0]),
            DENOMS[1],
            DENOMS[2],
            DENOMS[3],
            DENOMS[4],
            DENOMS[5],
            DENOMS[6],
            DENOMS[7],
            DENOMS[8]
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
        uint256 card = _mintCard(alice, DENOMS[3]); // 50 units, under a 100 unit reserve

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.BidTooLow.selector, 50, 100));
        house.bid(id, _one(card), 0);
    }

    function test_IncrementIsRoundedUpToAWholeUnit() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, DENOMS[0]); // 1 unit
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        // 5% of one unit rounds up to one unit, so the next bid must reach two. A truncating
        // increment would demand only one and let a tie take the lead.
        assertEq(house.minimumBid(id), 2, "increment floored below a whole unit");

        uint256 b = _mintCard(bob, DENOMS[0]);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.BidTooLow.selector, 1, 2));
        house.bid(id, _one(b), 0);
    }

    function test_TopUpAddsToAnExistingBid() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        uint256 more = _mintCard(alice, DENOMS[3]);
        vm.prank(alice);
        house.bid(id, _one(more), 0);

        assertEq(house.bidUnits(id, alice), 150, "top-up added rather than replaced");
        assertEq(house.escrowedCards(id, alice).length, 2);
    }

    function test_EscrowIsCappedAcrossTopUpsNotPerCall() public {
        uint256 id = _open();

        uint256[] memory ids = new uint256[](64);
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 64 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 64);
        for (uint256 i = 0; i < 64; ++i) {
            ids[i] = first + i;
        }

        vm.prank(alice);
        house.bid(id, ids, 0);
        assertEq(house.escrowedCards(id, alice).length, 64);

        uint256 oneMore = _mintCard(alice, DENOMS[0]);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.TooManyCards.selector, 65));
        house.bid(id, _one(oneMore), 0);
    }

    /* ------------------------------ timing ----------------------------- */

    function test_ClockStartsAtTheFirstBid() public {
        uint256 id = _open();
        skip(365 days);

        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(card), 0); // still live, however long it sat unbid

        assertEq(house.auctions(id).endTime, uint64(block.timestamp) + DURATION);
    }

    function test_ABidInsideTheWindowExtendsTheEnd() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint64 firstEnd = house.auctions(id).endTime;

        skip(DURATION - 60); // one minute left, inside the 15 minute window
        uint256 b = _mintCard(bob, DENOMS[5]);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        assertEq(house.auctions(id).endTime, uint64(block.timestamp) + EXTENSION);
        assertGt(house.auctions(id).endTime, firstEnd, "the end must move out, never in");
    }

    function test_ABidOutsideTheWindowLeavesTheEndAlone() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint64 firstEnd = house.auctions(id).endTime;

        skip(1 hours); // far from the end
        uint256 b = _mintCard(bob, DENOMS[5]);
        vm.prank(bob);
        house.bid(id, _one(b), 0);

        assertEq(house.auctions(id).endTime, firstEnd, "the end moved without cause");
    }

    function test_BiddingStopsAtTheEnd() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        skip(DURATION);
        uint256 b = _mintCard(bob, DENOMS[5]);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionOver.selector, id));
        house.bid(id, _one(b), 0);
    }

    /* ---------------------------- settlement --------------------------- */

    function test_SettleRecordsTheOutcomeAndClaimLotDeliversAndSellerPullsTheCards() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        skip(DURATION);
        house.settle(id); // permissionless, moves nothing
        assertEq(shapes.ownerOf(lotId), address(house), "settle does not deliver the lot");

        vm.prank(alice);
        house.claimLot(id);
        assertEq(shapes.ownerOf(lotId), alice, "winner has the lot");

        vm.prank(seller);
        house.claimProceeds(id);
        assertEq(shapes.ownerOf(card), seller, "seller has the winning card");
        assertEq(shapes.balanceOf(address(house)), 0, "house holds nothing after");
    }

    function test_SettleIsRefusedBeforeTheEndAndTwice() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, DENOMS[4]);
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
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        uint256 b = _mintCard(bob, DENOMS[5]);
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
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, alice));
        house.withdraw(id);
    }

    function test_TheWinnerCannotWithdrawAfterSettlement() public {
        uint256 id = _open();
        uint256 a = _mintCard(alice, DENOMS[4]);
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
        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        uint256 b = _mintCard(bob, DENOMS[5]);
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
        uint256 a = _mintCard(alice, DENOMS[4]);
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

        uint256 a = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        _assertEscrowExact(id, bidders);

        vm.prank(bob);
        house.bid{value: DENOMS[5] + feeOf(DENOMS[5])}(id, _none(), DENOMS[5]);
        _assertEscrowExact(id, bidders);

        uint256 a2 = _mintCard(alice, DENOMS[6]);
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
        _assertEscrowExact(id, bidders);

        vm.prank(alice);
        house.claimLot(id);
        assertEq(shapes.balanceOf(address(house)), 0);
    }

    /* ----------------------------- custody ----------------------------- */

    /// @notice The house never pushes. A bidder that refuses ERC721s can still be outbid, and the
    ///         auction runs on without them; only their own pull fails, which is their problem.
    function test_AHostileBidderCannotFreezeTheAuction() public {
        uint256 id = _open();
        HostileBidder hostile = new HostileBidder(house);

        uint256 h = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        shapes.transferFrom(alice, address(hostile), h);
        hostile.approve(address(shapes));
        hostile.bid(id, _one(h));
        assertEq(house.auctions(id).highestBidder, address(hostile));

        // Outbidding does not push anything at the hostile contract, so it cannot revert.
        uint256 b = _mintCard(bob, DENOMS[5]);
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
        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.UnsolicitedToken.selector, alice));
        shapes.safeTransferFrom(alice, address(house), card);
    }

    function test_UnknownAuctionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.AuctionNotFound.selector, 7));
        house.minimumBid(7);
    }

    /// @notice The cap bounds what the escrow holds, and a card the house mints for an ETH bid
    ///         counts against it exactly as a deposited card does. Counting only deposits would
    ///         let the mint path push `_release` past the loop the cap exists to bound.
    function test_TheCapCountsMintedCardsNotOnlyDepositedOnes() public {
        uint256 id = _open();

        uint256[] memory ids = new uint256[](64);
        vm.prank(alice);
        uint256 first = shapes.mintBatch{value: 64 * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], 64);
        for (uint256 i = 0; i < 64; ++i) {
            ids[i] = first + i;
        }
        vm.prank(alice);
        house.bid(id, ids, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.TooManyCards.selector, 65));
        house.bid{value: DENOMS[0] + feeOf(DENOMS[0])}(id, _none(), DENOMS[0]);

        assertEq(house.escrowedCards(id, alice).length, 64, "the refused bid left the escrow alone");
        assertEq(house.bidUnits(id, alice), 64, "and left the standing bid alone");
    }

    /// @notice A zero increment does not permit a tie. The step is floored at one unit, so the
    ///         standing bid can only be displaced by a strictly larger one.
    function test_AZeroIncrementStillDemandsOneMoreUnit() public {
        vm.prank(seller);
        uint256 id = house.createAuction(address(shapes), lotId, DURATION, RESERVE_UNITS, 0, EXTENSION);

        uint256 a = _mintCard(alice, DENOMS[4]); // 100 units
        vm.prank(alice);
        house.bid(id, _one(a), 0);
        assertEq(house.minimumBid(id), 101, "a zero increment still steps by one unit");

        uint256 tie = _mintCard(bob, DENOMS[4]); // the same 100 units
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.BidTooLow.selector, 100, 101));
        house.bid(id, _one(tie), 0);
        assertEq(house.auctions(id).highestBidder, alice, "the standing bid held");
    }

    /// @notice `cardsFor` is a public quote, so it validates its own argument rather than
    ///         relying on the bid path having checked first.
    function test_CardsForRejectsAnOffLatticeAmount() public {
        vm.expectRevert(
            abi.encodeWithSelector(IShapeCardEscrow.NotAUnitMultiple.selector, (DENOMS[0] * 3) / 2)
        );
        house.cardsFor((DENOMS[0] * 3) / 2);
    }

    /// @notice Every custody rule here is enforced by calling `shapes`. An address with no code
    ///         would accept those calls silently, so it is refused at construction.
    function test_ConstructorRejectsAShapesAddressWithNoCode() public {
        vm.expectRevert(bytes("shapes has no code"));
        new ShapeAuctionHouse(address(0));

        vm.expectRevert(bytes("shapes has no code"));
        new ShapeAuctionHouse(alice); // an EOA
    }

    /* ------------------------- mixed cards and ETH ------------------------- */

    /// @notice A single bid carrying both a deposited card and an ETH backing amount escrows
    ///         both: the deposited card first, then the card the ETH path mints. The ETH leg
    ///         stays exact-payment, same as a cards-only bid.
    function test_ACombinedCardsAndEthBidEscrowsBoth() public {
        uint256 id = _open();
        uint256 card = _mintCard(alice, DENOMS[2]); // 0.1 ETH, 10 units

        vm.prank(alice);
        house.bid{value: DENOMS[1] + feeOf(DENOMS[1])}(id, _one(card), DENOMS[1]);

        assertEq(house.bidUnits(id, alice), 15, "10 units deposited + 5 units minted");
        uint256[] memory ids = house.escrowedCards(id, alice);
        assertEq(ids.length, 2, "the deposited card plus one minted card");
        assertEq(ids[0], card, "the deposited card is escrowed first");
        assertEq(shapes.backingOf(ids[1]), DENOMS[1], "the minted card is the 0.05 denomination");
        assertEq(shapes.ownerOf(ids[0]), address(house));
        assertEq(shapes.ownerOf(ids[1]), address(house));
        assertEq(address(house).balance, 0, "the house forwards ETH to shapes, holding none itself");

        // The ETH leg is still exact-payment: one wei over the expected cost reverts.
        uint256 card2 = _mintCard(alice, DENOMS[2]);
        uint256 expected = DENOMS[1] + feeOf(DENOMS[1]);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, expected, expected + 1)
        );
        house.bid{value: expected + 1}(id, _one(card2), DENOMS[1]);
    }

    /// @notice A bid naming a card the caller does not own is refused: the house is an approved
    ///         operator for the card's actual owner, so `_takeCards`' `transferFrom` succeeds
    ///         authorization but fails the `from` check, since the caller is not the owner.
    function test_ABidWithAnotherBiddersCardIsRefused() public {
        uint256 id = _open();
        uint256 bobCard = _mintCard(bob, DENOMS[4]);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, bobCard, bob)
        );
        house.bid(id, _one(bobCard), 0);

        assertEq(shapes.ownerOf(bobCard), bob, "bob's card stays with bob");
    }

    /// @notice `claimProceeds` after a no-bid cancellation has nothing to release: `highestBidder`
    ///         is zero, so `_release` finds an empty escrow entry for it.
    function test_ClaimProceedsAfterCancelHasNothingToRelease() public {
        uint256 id = _open();
        vm.prank(seller);
        house.cancelAuction(id);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, id, address(0)));
        house.claimProceeds(id);
    }
}

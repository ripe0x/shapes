// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {ShapeAuctionHouse} from "../../src/ShapeAuctionHouse.sol";
import {IShapeAuctionHouse} from "../../src/interfaces/IShapeAuctionHouse.sol";
import {IShapeCardEscrow} from "../../src/interfaces/IShapeCardEscrow.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice Required adversarial attempt 9: every auction path, with the owner token as the lot
///         and with ETH-backed bids, checked against the reserve invariant and against the house
///         gaining any authority over the token.
contract AuctionPathsTest is AuditBase {
    ShapeAuctionHouse internal house;
    address internal carol = address(0xCA401);

    function setUp() public override {
        super.setUp();
        house = new ShapeAuctionHouse(address(shapes));
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(house));
        vm.deal(carol, 10_000 ether);
    }

    /// @dev List `tokenId` (a Shape) as the lot, sold by `seller`.
    function _list(address seller, uint256 tokenId, uint64 reserveUnits) private returns (uint256 auctionId) {
        vm.prank(seller);
        shapes.approve(address(house), tokenId);
        vm.prank(seller);
        auctionId = house.createAuction(address(shapes), tokenId, 1 days, reserveUnits, 500, 300, 0);
    }

    /// @dev A cards-only bid of `k` freshly minted dust from `who`.
    function _cardBid(address who, uint256 auctionId, uint256 k) private returns (uint256[] memory ids) {
        uint256 first = _mintBatchTo(who, DENOMS[0], k);
        ids = new uint256[](k);
        for (uint256 i = 0; i < k; ++i) {
            ids[i] = first + i;
        }
        vm.prank(who);
        shapes.setApprovalForAll(address(house), true);
        uint256[] memory none = new uint256[](0);
        none;
        vm.prank(who);
        house.bid(auctionId, ids, 0);
    }

    /* -------------------------- the whole happy path ------------------------- */

    /// @notice Bid, outbid, settle, claim proceeds, claim lot, withdraw. Every card ends where it
    ///         should and the reserve is untouched throughout.
    function test_BidOutbidSettleClaimWithdraw() public {
        uint256 lot = _mint(alice, DENOMS[2]);
        uint256 auctionId = _list(alice, lot, 1);
        uint256 reserveBefore = shapes.redeemableBacking();

        _cardBid(bob, auctionId, 2); // 2 units
        assertEq(house.bidUnits(auctionId, bob), 2, "bob's bid not credited");

        _cardBid(carol, auctionId, 4); // 4 units, clears the 5% increment on 2
        assertEq(house.bidUnits(auctionId, carol), 4, "carol's bid not credited");

        // Bob is no longer the leader and pulls his cards back untouched.
        uint256[] memory bobCards = house.escrowedCards(auctionId, bob);
        vm.prank(bob);
        house.withdraw(auctionId);
        for (uint256 i = 0; i < bobCards.length; ++i) {
            assertEq(shapes.ownerOf(bobCards[i]), bob, "bob's card did not come back");
            assertEq(shapes.backingOf(bobCards[i]), DENOMS[0], "bob's card lost backing in escrow");
        }

        // The leader cannot withdraw.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, auctionId, carol));
        house.withdraw(auctionId);

        vm.warp(block.timestamp + 2 days);
        house.settle(auctionId);

        // Still cannot withdraw once settled: those cards are the seller's proceeds.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NothingToWithdraw.selector, auctionId, carol));
        house.withdraw(auctionId);

        uint256[] memory proceeds = house.escrowedCards(auctionId, carol);
        vm.prank(alice);
        house.claimProceeds(auctionId);
        for (uint256 i = 0; i < proceeds.length; ++i) {
            assertEq(shapes.ownerOf(proceeds[i]), alice, "seller did not receive the winning cards");
        }

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.NotLotRecipient.selector, auctionId, bob));
        house.claimLot(auctionId);

        vm.prank(carol);
        house.claimLot(auctionId);
        assertEq(shapes.ownerOf(lot), carol, "winner did not receive the lot");

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeAuctionHouse.LotAlreadyClaimed.selector, auctionId));
        house.claimLot(auctionId);

        assertEq(shapes.redeemableBacking(), reserveBefore + 6 * DENOMS[0], "the auction moved backing");
        _assertReserveInvariant();
    }

    /// @notice Cancelling returns the lot to the seller and is refused once a bid stands.
    function test_CancelOnlyBeforeABidAndOnlyBySeller() public {
        uint256 lot = _mint(alice, DENOMS[2]);
        uint256 auctionId = _list(alice, lot, 1);

        vm.prank(bob);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.cancelAuction(auctionId);

        vm.prank(alice);
        house.cancelAuction(auctionId);

        vm.prank(alice);
        house.claimLot(auctionId);
        assertEq(shapes.ownerOf(lot), alice, "cancelled lot did not come back");

        // A second auction, this time with a bid: cancelling is refused.
        uint256 lot2 = _mint(alice, DENOMS[2]);
        uint256 a2 = _list(alice, lot2, 1);
        _cardBid(bob, a2, 1);
        vm.prank(alice);
        vm.expectRevert(IShapeAuctionHouse.InvalidAuction.selector);
        house.cancelAuction(a2);
        _assertReserveInvariant();
    }

    /* ------------------------------ owner token ------------------------------ */

    /// @notice Escrowing the owner token moves `owner()` to the house for the auction's life and
    ///         changes nothing else. The house gains no authority over the token.
    function test_OwnerTokenAsTheLotMovesOwnerAndNothingElse() public {
        assertEq(shapes.ownerToken(), 0, "genesis is not the owner token");
        assertEq(shapes.owner(), address(this), "owner wrong at the start");

        uint256 auctionId = _list(address(this), 0, 1);

        assertEq(shapes.owner(), address(house), "owner() did not follow the escrowed token");
        assertEq(shapes.ownerToken(), 0, "the owner token pointer moved");
        assertEq(shapes.admin(), address(this), "the house took the admin role");

        // The house cannot use its position for anything on the token.
        vm.prank(address(house));
        vm.expectRevert();
        shapes.setMintFee(0);
        vm.prank(address(house));
        vm.expectRevert();
        shapes.transferAdmin(address(house));
        vm.prank(address(house));
        vm.expectRevert();
        shapes.lockPresentation();

        _cardBid(bob, auctionId, 3);
        vm.warp(block.timestamp + 2 days);
        house.settle(auctionId);
        house.claimProceeds(auctionId);

        vm.prank(bob);
        house.claimLot(auctionId);
        assertEq(shapes.owner(), bob, "collection ownership did not follow the lot");
        assertEq(shapes.ownerToken(), 0, "the owner token pointer moved");
        assertEq(shapes.admin(), address(this), "the admin role moved with the lot");
        _assertReserveInvariant();
    }

    /// @notice The winner can redeem the owner token they just won, which ends collection
    ///         ownership. Accounting stays exact.
    function test_RedeemingAWonOwnerTokenEndsOwnershipCleanly() public {
        uint256 auctionId = _list(address(this), 0, 1);
        _cardBid(bob, auctionId, 3);
        vm.warp(block.timestamp + 2 days);
        house.settle(auctionId);
        vm.prank(bob);
        house.claimLot(auctionId);

        uint256 before = bob.balance;
        vm.prank(bob);
        shapes.redeem(0);
        assertEq(bob.balance, before + DENOMS[0], "redemption paid the wrong amount");
        assertEq(shapes.owner(), address(0), "owner() did not clear");
        vm.expectRevert(IShapes.NoOwnerToken.selector);
        shapes.ownerToken();
        _assertReserveInvariant();
    }

    /* ----------------------------- ETH-backed bids ---------------------------- */

    /// @notice An ETH bid mints the minimal card set into escrow, pays the token's fee per card,
    ///         and leaves the reserve invariant intact.
    function test_EthBackedBidMintsExactlyAndKeepsTheReserveExact() public {
        uint256 lot = _mint(alice, DENOMS[3]);
        uint256 auctionId = _list(alice, lot, 1);

        uint256 backing = 16 * Denominations.UNIT; // ladder-relative, so both profiles agree
        uint256 cost = house.mintCostFor(backing);
        uint256 mintedBefore = shapes.totalMinted();
        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 feesBefore = shapes.pendingFees();

        uint256[] memory none = new uint256[](0);
        vm.prank(bob);
        house.bid{value: cost}(auctionId, none, backing);

        uint256[] memory cards = house.escrowedCards(auctionId, bob);
        assertGt(cards.length, 0, "no cards minted");
        assertEq(shapes.totalMinted(), mintedBefore + cards.length, "wrong number minted");
        assertEq(shapes.redeemableBacking(), reserveBefore + backing, "reserve wrong after an ETH bid");
        assertEq(shapes.pendingFees(), feesBefore + MINT_FEE * cards.length, "fee wrong after an ETH bid");
        assertEq(house.bidUnits(auctionId, bob), uint64(backing / Denominations.UNIT), "units wrong");

        uint256 sum;
        for (uint256 i = 0; i < cards.length; ++i) {
            assertEq(shapes.ownerOf(cards[i]), address(house), "card not escrowed");
            sum += shapes.backingOf(cards[i]);
        }
        assertEq(sum, backing, "the minted set is not worth the bid");
        _assertReserveInvariant();

        // Wrong payment is refused exactly.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, cost, cost - 1));
        house.bid{value: cost - 1}(auctionId, none, backing);

        // ETH alongside a cards-only bid is refused rather than stranded.
        uint256 spare = _mint(carol, DENOMS[0]);
        vm.prank(carol);
        shapes.approve(address(house), spare);
        uint256[] memory one = new uint256[](1);
        one[0] = spare;
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.IncorrectPayment.selector, 0, uint256(1)));
        house.bid{value: 1}(auctionId, one, 0);

        // An amount off the unit lattice is refused.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.NotAUnitMultiple.selector, uint256(1)));
        house.bid{value: 1}(auctionId, none, 1);
    }

    /* ------------------------------- griefing -------------------------------- */

    /// @notice A Black Shape is worth zero and is refused as a card, so a bid cannot be padded
    ///         with unredeemable tokens.
    function test_BlackShapeIsRefusedAsACard() public {
        uint256 first = _mintBatchTo(alice, DENOMS[0], 10_000);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, burn);
        vm.prank(alice);
        shapes.burnBacking(first);
        assertTrue(shapes.isBlackShape(first), "not Black");

        uint256 lot = _mint(bob, DENOMS[0]);
        uint256 auctionId = _list(bob, lot, 1);

        vm.prank(alice);
        shapes.setApprovalForAll(address(house), true);
        uint256[] memory cards = new uint256[](1);
        cards[0] = first;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.WorthlessCard.selector, first));
        house.bid(auctionId, cards, 0);
        _assertReserveInvariant();
    }

    /// @notice A lot whose transfer reverts blocks only its own delivery. Card paths still run.
    function test_ARevertingLotBlocksOnlyItsOwnDelivery() public {
        StubbornNft nft = new StubbornNft();
        uint256 lotId = nft.mint(alice);
        vm.prank(alice);
        nft.setApprovalForAll(address(house), true);
        vm.prank(alice);
        uint256 auctionId = house.createAuction(address(nft), lotId, 1 days, 1, 500, 300, 0);

        _cardBid(bob, auctionId, 2);
        _cardBid(carol, auctionId, 4);

        // The loser gets his cards back even though the lot is stuck.
        vm.prank(bob);
        house.withdraw(auctionId);

        vm.warp(block.timestamp + 2 days);
        house.settle(auctionId);

        nft.setStubborn(true);
        vm.prank(carol);
        vm.expectRevert();
        house.claimLot(auctionId);

        // The seller still gets paid.
        vm.prank(alice);
        house.claimProceeds(auctionId);
        assertEq(house.escrowedCards(auctionId, carol).length, 0, "proceeds not released");
        _assertReserveInvariant();
    }

    /// @notice The seller cannot bid its own lot, and the same token cannot be listed twice while
    ///         the house still holds it.
    function test_SellerCannotBidAndALotCannotBeDoubleListed() public {
        uint256 lot = _mint(alice, DENOMS[2]);
        uint256 auctionId = _list(alice, lot, 1);

        uint256 spare = _mint(alice, DENOMS[0]);
        vm.prank(alice);
        shapes.approve(address(house), spare);
        uint256[] memory cards = new uint256[](1);
        cards[0] = spare;
        vm.prank(alice);
        vm.expectRevert(IShapeAuctionHouse.SellerCannotBid.selector);
        house.bid(auctionId, cards, 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapeAuctionHouse.AuctionAlreadyExistsForToken.selector, address(shapes), lot
            )
        );
        house.createAuction(address(shapes), lot, 1 days, 1, 500, 300, 0);
        auctionId;
    }

    /// @notice An inbound `safeTransferFrom` to the escrow is refused, so a card cannot be
    ///         stranded there with no owner of record.
    function test_UnsolicitedSafeTransferIsRefused() public {
        uint256 id = _mint(alice, DENOMS[0]);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapeCardEscrow.UnsolicitedToken.selector, alice));
        shapes.safeTransferFrom(alice, address(house), id);
    }
}

/// @dev An ERC-721 that can be made to refuse the outbound transfer of a settled lot.
contract StubbornNft {
    mapping(uint256 => address) private _owner;
    mapping(address => mapping(address => bool)) private _all;
    mapping(uint256 => address) private _approved;
    uint256 private _next;
    bool private _stubborn;

    function setStubborn(bool v) external {
        _stubborn = v;
    }

    function mint(address to) external returns (uint256 id) {
        id = ++_next;
        _owner[id] = to;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _owner[id];
    }

    function getApproved(uint256 id) external view returns (address) {
        return _approved[id];
    }

    function isApprovedForAll(address o, address op) external view returns (bool) {
        return _all[o][op];
    }

    function setApprovalForAll(address op, bool ok) external {
        _all[msg.sender][op] = ok;
    }

    function approve(address to, uint256 id) external {
        _approved[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(!_stubborn, "stubborn");
        require(_owner[id] == from, "not owner");
        _owner[id] = to;
        _approved[id] = address(0);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x01ffc9a7;
    }
}

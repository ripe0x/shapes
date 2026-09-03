// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Shapes} from "../../src/Shapes.sol";
import {ShapeAuctionHouse} from "../../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../../src/ShapeCollection.sol";
import {ShapeRenderer} from "../../src/ShapeRenderer.sol";
import {IShapeCardEscrow} from "../../src/interfaces/IShapeCardEscrow.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice Required adversarial attempt 6: find a path that creates a backed token before
///         `mintStart`, and pin the boundary at exactly the timestamp.
contract MintStartBoundaryTest is Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;
    uint64 internal constant START = 1_000_000;

    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;
    ShapeAuctionHouse internal house;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        vm.warp(1);
        renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), START
        );
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
        house = new ShapeAuctionHouse(address(shapes));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    /* ------------------------------ the boundary ----------------------------- */

    /// @notice The constructor's Shape #0 is the sole token that exists before `mintStart`.
    function test_TokenZeroIsTheOnlyPreStartToken() public view {
        assertEq(shapes.totalMinted(), 1, "something else was minted");
        assertEq(shapes.totalSupply(), 1, "supply wrong");
        assertEq(shapes.backingOf(0), Denominations.amountAt(0), "genesis backing wrong");
        assertEq(shapes.mintStart(), START, "mintStart wrong");
        assertLt(block.timestamp, START, "the harness is already past the start");
    }

    /// @notice One second before the start, every public mint path refuses.
    function test_OneSecondBeforeStartEveryMintPathRefuses() public {
        vm.warp(START - 1);
        uint256 amount = Denominations.amountAt(0);
        uint256 pay = amount + MINT_FEE;

        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mint{value: pay}(amount);

        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mintTo{value: pay}(amount, bob);

        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mintBatch{value: 3 * pay}(amount, 3);

        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mintBatchTo{value: 3 * pay}(amount, 3, bob);

        // The gate runs before every other check, so a bad amount or quantity still reports it.
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        shapes.mintBatch{value: 0}(1 wei, 0);

        assertEq(shapes.totalMinted(), 1, "a token was created before the start");
    }

    /// @notice At exactly the start timestamp every path opens.
    function test_AtExactlyTheStartMintingOpens() public {
        vm.warp(START);
        uint256 amount = Denominations.amountAt(0);
        uint256 pay = amount + MINT_FEE;

        vm.prank(alice);
        uint256 id = shapes.mint{value: pay}(amount);
        assertEq(id, 1, "public minting should begin at #1");

        vm.prank(alice);
        shapes.mintTo{value: pay}(amount, bob);
        vm.prank(alice);
        shapes.mintBatch{value: 3 * pay}(amount, 3);
        vm.prank(alice);
        shapes.mintBatchTo{value: 3 * pay}(amount, 3, bob);

        assertEq(shapes.totalMinted(), 9, "wrong count after the start");
    }

    /* ------------------------- other creation paths ------------------------- */

    /// @notice Recomposition is the only other way an id is issued, and it cannot run before the
    ///         start: the single pre-start token cannot be split (no two outputs sum to one unit),
    ///         cannot be composed (there is nothing to burn into it), and has no record to
    ///         decompose.
    function test_NoRecompositionPathCreatesATokenBeforeStart() public {
        vm.warp(START - 1);

        uint8[] memory outs = new uint8[](2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IShapes.SplitSumMismatch.selector,
                Denominations.amountAt(0),
                2 * Denominations.amountAt(0)
            )
        );
        shapes.split(0, outs);

        uint256[] memory burn = new uint256[](1);
        burn[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, uint256(0)));
        shapes.compose(0, burn);

        vm.expectRevert(abi.encodeWithSelector(IShapes.NoComposeRecord.selector, uint256(0)));
        shapes.decompose(0);

        assertEq(shapes.totalMinted(), 1, "an id was issued before the start");
    }

    /// @notice The ETH-backed auction bid mints through `Shapes`, so it is gated too. This is the
    ///         indirect mint path the brief names.
    function test_EscrowEthBidCannotMintBeforeStart() public {
        vm.warp(START - 1);
        uint256 lot = _lotFor(alice);

        vm.prank(alice);
        uint256 auctionId = house.createAuction(_lotNft, lot, 1 days, 1, 500, 300);

        uint256[] memory none = new uint256[](0);
        uint256 backing = Denominations.amountAt(1);
        uint256 cost = house.mintCostFor(backing);

        vm.prank(bob);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        house.bid{value: cost}(auctionId, none, backing);

        assertEq(shapes.totalMinted(), 1, "the escrow minted before the start");

        // After the start the same bid goes through.
        vm.warp(START);
        vm.prank(bob);
        house.bid{value: cost}(auctionId, none, backing);
        assertEq(house.bidUnits(auctionId, bob), backing / Denominations.UNIT, "bid not credited");
        assertGe(
            address(shapes).balance,
            shapes.redeemableBacking() + shapes.pendingFees(),
            "reserve invariant broken by an escrow mint"
        );
    }

    /// @notice A card bid needs no mint, so it works before the start using the one token that
    ///         exists. Nothing about that creates backing.
    function test_CardOnlyBidWorksBeforeStartAndCreatesNothing() public {
        vm.warp(START - 1);
        uint256 lot = _lotFor(alice);

        vm.prank(alice);
        uint256 auctionId = house.createAuction(_lotNft, lot, 1 days, 1, 500, 300);

        // Shape #0 is the only card in existence; hand it to bob and let him bid it.
        shapes.transferFrom(address(this), bob, 0);
        vm.prank(bob);
        shapes.approve(address(house), 0);

        uint256[] memory cards = new uint256[](1);
        cards[0] = 0;
        uint256 mintedBefore = shapes.totalMinted();
        uint256 reserveBefore = shapes.redeemableBacking();

        vm.prank(bob);
        house.bid(auctionId, cards, 0);

        assertEq(shapes.totalMinted(), mintedBefore, "a card bid minted");
        assertEq(shapes.redeemableBacking(), reserveBefore, "a card bid moved the reserve");
        assertEq(shapes.ownerOf(0), address(house), "the card was not escrowed");
        assertEq(house.bidUnits(auctionId, bob), 1, "bid units wrong");
    }

    /// @dev An arbitrary ERC-721 lot the house can escrow before minting is open.
    function _lotFor(address seller) private returns (uint256) {
        DummyNft nft = new DummyNft();
        uint256 id = nft.mint(seller);
        vm.prank(seller);
        nft.setApprovalForAll(address(house), true);
        _lotNft = address(nft);
        return id;
    }

    address private _lotNft;
}

/// @dev The smallest ERC-721 that satisfies the house's checks.
contract DummyNft {
    mapping(uint256 => address) private _owner;
    mapping(address => mapping(address => bool)) private _all;
    mapping(uint256 => address) private _approved;
    uint256 private _next;

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

    function isApprovedForAll(address owner_, address op) external view returns (bool) {
        return _all[owner_][op];
    }

    function setApprovalForAll(address op, bool ok) external {
        _all[msg.sender][op] = ok;
    }

    function approve(address to, uint256 id) external {
        _approved[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(_owner[id] == from, "not owner");
        require(
            msg.sender == from || _all[from][msg.sender] || _approved[id] == msg.sender, "not approved"
        );
        _owner[id] = to;
        _approved[id] = address(0);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x01ffc9a7;
    }
}

/// @dev Silences the unused-import linter for IShapeCardEscrow, which names the escrow errors the
///      auction tests above rely on by selector.
abstract contract _EscrowErrorAnchor is IShapeCardEscrow {}

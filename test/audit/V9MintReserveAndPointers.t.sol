// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {IShapeCardEscrow} from "../../src/interfaces/IShapeCardEscrow.sol";
import {IShapePositionResolver} from "../../src/interfaces/IShapePositionResolver.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Shapes} from "../../src/Shapes.sol";
import {ShapeAuctionHouse} from "../../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../../src/ShapeCollection.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice v9 attempts 2 (a hostile positions target), 3 (forced ETH) and 6 (the `mintStart`
///         boundary, including the ETH-backed auction bid path).
contract V9MintReserveAndPointersTest is AuditBase {
    /* ------------------------------------------------------------------ */
    /*  attempt 2: a hostile positions target                              */
    /* ------------------------------------------------------------------ */

    /// @notice `positionOf` returns zero for every hostile answer and never reverts: a revert, a
    ///         gas burner, a short return, a long return, dirty upper bits, and a target that
    ///         reenters `Shapes`.
    function test_Attempt2_HostilePositionsTargets() public {
        uint256 id = _mint(alice, DENOMS[0]);
        uint256 gasFloor = 400_000;

        address[5] memory targets = [
            address(new V9Reverter()),
            address(new V9GasBurner()),
            address(new V9ShortReturn()),
            address(new V9LongReturn()),
            address(new V9DirtyBits())
        ];

        for (uint256 i = 0; i < targets.length; ++i) {
            shapes.setPointer(uint8(IShapes.Pointer.Positions), targets[i]);
            uint256 gasBefore = gasleft();
            address got = shapes.positionOf(id);
            uint256 used = gasBefore - gasleft();
            assertEq(got, address(0), "a hostile positions target produced a nonzero answer");
            assertLt(used, gasFloor, "a hostile positions target consumed an unbounded amount of gas");
            emit log_named_uint("positionOf gas", used);
        }

        // A target that reenters `Shapes` runs inside a STATICCALL frame, so it can read but not
        // write. Its well-formed answer is returned; nothing on `Shapes` moved.
        V9Reenterer reenterer = new V9Reenterer(address(shapes));
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(reenterer));
        uint256 supplyBefore = shapes.totalSupply();
        uint256 backingBefore = shapes.redeemableBacking();
        uint256 g = gasleft();
        assertEq(shapes.positionOf(id), address(reenterer));
        assertLt(g - gasleft(), gasFloor, "a reentrant positions target consumed unbounded gas");
        assertEq(shapes.totalSupply(), supplyBefore);
        assertEq(shapes.redeemableBacking(), backingBefore);

        // An honest target still answers.
        V9HonestResolver good = new V9HonestResolver(bob);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(good));
        assertEq(shapes.positionOf(id), bob);

        // A target with no code is refused outright.
        vm.expectRevert(IShapes.InvalidPointerTarget.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), makeAddr("no code here"));

        // Zero clears, and the lock is permanent.
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(0));
        assertEq(shapes.positionOf(id), address(0));
        shapes.lockPointer(uint8(IShapes.Pointer.Positions));
        vm.expectRevert(IShapes.PointerIsLocked.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(good));
    }

    /* ------------------------------------------------------------------ */
    /*  attempt 3: forced ETH                                              */
    /* ------------------------------------------------------------------ */

    /// @notice ETH pushed in outside the payable entrypoints raises the balance above
    ///         `redeemableBacking + pendingFees` and is unreachable by every path.
    function test_Attempt3_ForcedEthIsUnreachable() public {
        uint256 id = _mint(alice, DENOMS[4]);
        _mint(bob, DENOMS[0]);

        // The two ordinary deposit paths are refused outright.
        vm.prank(alice);
        (bool ok,) = address(shapes).call{value: 1 ether}("");
        assertFalse(ok, "receive() accepted a direct deposit");
        vm.prank(alice);
        (ok,) = address(shapes).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "fallback() accepted a direct deposit");

        // selfdestruct in the same transaction as creation still forces ETH in on Cancun.
        new V9Forcer{value: 3 ether}(payable(address(shapes)));

        assertEq(address(shapes).balance, shapes.redeemableBacking() + shapes.pendingFees() + 3 ether);
        _assertReserveInvariant();

        // Nothing pays it out: redemption pays face value, fees pay accrued balances.
        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance - before, DENOMS[4], "redemption paid more than the backing");

        before = feeRecipient.balance;
        shapes.withdrawFees(feeRecipient);
        assertEq(feeRecipient.balance - before, 2 * MINT_FEE, "withdrawFees paid more than accrued");

        assertEq(shapes.pendingFees(), 0);
        assertEq(
            address(shapes).balance,
            shapes.redeemableBacking() + 3 ether,
            "the forced ETH is still stranded, as documented"
        );
        _assertReserveInvariant();
    }

    /* ------------------------------------------------------------------ */
    /*  attempt 6: the mintStart boundary                                  */
    /* ------------------------------------------------------------------ */

    /// @notice Minting opens at exactly `mintStart`, and no other path creates a backed token
    ///         before it. Shape #0 from the constructor is the only exception.
    function test_Attempt6_MintStartBoundary() public {
        uint64 start = uint64(block.timestamp + 1 days);
        (Shapes gated,) = _deployGated(start);
        vm.deal(alice, 1_000 ether);

        vm.warp(start - 1);
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        gated.mint{value: DENOMS[0] + MINT_FEE}(DENOMS[0]);
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        gated.mintTo{value: DENOMS[0] + MINT_FEE}(DENOMS[0], alice);
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        gated.mintBatch{value: 2 * (DENOMS[0] + MINT_FEE)}(DENOMS[0], 2);
        vm.prank(alice);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        gated.mintBatchTo{value: 2 * (DENOMS[0] + MINT_FEE)}(DENOMS[0], 2, alice);

        // Shape #0 is the only live token, and it cannot be split: two outputs already exceed its
        // 0.01 backing, so no recomposition path issues a token before mintStart either.
        assertEq(gated.totalSupply(), 1);
        uint8[] memory outs = new uint8[](2);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitSumMismatch.selector, DENOMS[0], 2 * DENOMS[0]));
        gated.split(0, outs);

        vm.warp(start);
        vm.prank(alice);
        uint256 id = gated.mint{value: DENOMS[0] + MINT_FEE}(DENOMS[0]);
        assertEq(id, 1, "minting opens at exactly mintStart");
    }

    /// @notice An ETH-backed auction bid mints Shapes through `mintBatchTo`, so `mintStart` gates
    ///         it too. Attempt 6 and attempt 9 meet here.
    function test_Attempt6_EthBackedBidsAreGatedByMintStart() public {
        uint64 start = uint64(block.timestamp + 1 days);
        (Shapes gated, ShapeAuctionHouse house) = _deployGated(start);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);

        V9Lot lot = new V9Lot();
        lot.mintTo(alice, 1);
        vm.startPrank(alice);
        lot.setApprovalForAll(address(house), true);
        uint256 auctionId = house.createAuction(address(lot), 1, 1 days, 1, 500, 0, 0);
        vm.stopPrank();

        vm.warp(start - 1);
        uint256[] memory none = new uint256[](0);
        uint256 cost = house.mintCostFor(DENOMS[0]);
        vm.prank(bob);
        vm.expectRevert(IShapes.MintNotOpen.selector);
        house.bid{value: cost}(auctionId, none, DENOMS[0]);

        vm.warp(start);
        vm.prank(bob);
        house.bid{value: cost}(auctionId, none, DENOMS[0]);
        assertEq(house.bidUnits(auctionId, bob), 1);
        assertGe(address(gated).balance, gated.redeemableBacking() + gated.pendingFees(), "reserve");
    }

    function _deployGated(uint64 start) internal returns (Shapes gated, ShapeAuctionHouse house) {
        gated = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(renderer), start);
        ShapeCollection c = new ShapeCollection(renderer, gated);
        gated.setCollection(address(c));
        house = new ShapeAuctionHouse(address(gated));
    }
}

/* ----------------------------- positions mocks ---------------------------- */

contract V9Reverter {
    function positionOf(uint256) external pure returns (address) {
        revert("nope");
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract V9GasBurner {
    function positionOf(uint256) external view returns (address) {
        uint256 x;
        // Runs until the 50,000 gas stipend is exhausted: the staticcall fails with out of gas.
        while (true) {
            x = uint256(keccak256(abi.encode(x)));
        }
        return address(uint160(x));
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract V9ShortReturn {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 16)
        }
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @notice Returns a very large buffer, the returndata-bomb shape, within its 50,000 gas stipend.
contract V9LongReturn {
    function positionOf(uint256) external pure returns (address) {
        assembly {
            return(0, 60000)
        }
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract V9DirtyBits {
    function positionOf(uint256) external pure returns (address) {
        assembly {
            mstore(0, not(0))
            return(0, 32)
        }
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract V9Reenterer {
    address private immutable _shapes;

    constructor(address shapes_) {
        _shapes = shapes_;
    }

    function positionOf(uint256 tokenId) external view returns (address) {
        // A staticcall frame: any write reverts, and the outer call swallows the failure.
        (bool ok, bytes memory data) =
            _shapes.staticcall(abi.encodeWithSignature("positionOf(uint256)", tokenId));
        ok;
        data;
        return address(this);
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract V9HonestResolver is IShapePositionResolver {
    address private immutable _answer;

    constructor(address answer) {
        _answer = answer;
    }

    function positionOf(uint256) external view returns (address) {
        return _answer;
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @notice Forces ETH into a contract that refuses deposits.
contract V9Forcer {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/// @notice A minimal ERC-721 to auction, with just the surface `ShapeAuctionHouse` uses.
contract V9Lot {
    mapping(uint256 => address) private _owner;
    mapping(address => mapping(address => bool)) private _all;

    function mintTo(address to, uint256 id) external {
        _owner[id] = to;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _owner[id];
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address owner_, address operator) external view returns (bool) {
        return _all[owner_][operator];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _all[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(_owner[id] == from, "not owner");
        require(msg.sender == from || _all[from][msg.sender], "not approved");
        _owner[id] = to;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd;
    }
}

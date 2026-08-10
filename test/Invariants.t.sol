// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";

/// @notice Drives arbitrary sequences of mint / batch mint / transfer / redeem / batch redeem
///         against Shapes, tracking its own view of what the reserve should be.
contract Handler is Test, IERC721Receiver {
    Shapes public immutable shapes;
    uint256 public immutable feeBps;

    address[4] public actors;

    /// @dev Ghost accounting, maintained independently of the contract's own counters.
    uint256 public ghostBackingIn;
    uint256 public ghostBackingOut;
    uint256 public ghostFeesPaid;
    uint256 public ghostMints;
    uint256 public ghostRedeems;

    uint256[] public liveTokens;
    mapping(uint256 => uint256) private _indexOfToken;

    uint256[9] internal DENOMS = [
        uint256(0.01 ether),
        0.1 ether,
        0.5 ether,
        1 ether,
        5 ether,
        10 ether,
        25 ether,
        50 ether,
        100 ether
    ];

    constructor(Shapes shapes_) {
        shapes = shapes_;
        feeBps = shapes_.feeBps();
        actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];
        for (uint256 i = 0; i < actors.length; ++i) {
            vm.deal(actors[i], 100_000 ether);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    function liveTokenCount() external view returns (uint256) {
        return liveTokens.length;
    }

    function _actor(uint256 s) private view returns (address) {
        return actors[s % actors.length];
    }

    function _track(uint256 tokenId) private {
        _indexOfToken[tokenId] = liveTokens.length;
        liveTokens.push(tokenId);
    }

    function _untrack(uint256 tokenId) private {
        uint256 i = _indexOfToken[tokenId];
        uint256 last = liveTokens.length - 1;
        if (i != last) {
            uint256 moved = liveTokens[last];
            liveTokens[i] = moved;
            _indexOfToken[moved] = i;
        }
        liveTokens.pop();
        delete _indexOfToken[tokenId];
    }

    /* ----------------------------- actions ----------------------------- */

    function mint(uint256 denomSeed, uint256 actorSeed) public {
        uint256 amount = DENOMS[denomSeed % 9];
        address who = _actor(actorSeed);

        vm.prank(who);
        try shapes.mint{value: amount + shapes.mintFeeFor(amount)}(amount, who) returns (uint256 id) {
            ghostBackingIn += amount;
            ghostFeesPaid += shapes.mintFeeFor(amount);
            ghostMints += 1;
            _track(id);
        } catch {}
    }

    function mintBatch(uint256 denomSeed, uint256 actorSeed, uint256 qtySeed) public {
        uint256 amount = DENOMS[denomSeed % 9];
        uint256 qty = bound(qtySeed, 1, 8);
        address who = _actor(actorSeed);
        uint256 cost = qty * (amount + shapes.mintFeeFor(amount));

        vm.prank(who);
        try shapes.mintBatch{value: cost}(amount, qty, who) returns (uint256 first) {
            ghostBackingIn += amount * qty;
            ghostFeesPaid += shapes.mintFeeFor(amount) * qty;
            ghostMints += qty;
            for (uint256 i = 0; i < qty; ++i) {
                _track(first + i);
            }
        } catch {}
    }

    function transfer(uint256 tokenSeed, uint256 actorSeed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[tokenSeed % liveTokens.length];
        address from = shapes.ownerOf(id);
        address to = _actor(actorSeed);
        if (from == to) return;

        vm.prank(from);
        try shapes.transferFrom(from, to, id) {} catch {}
    }

    function redeem(uint256 tokenSeed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[tokenSeed % liveTokens.length];
        address owner = shapes.ownerOf(id);
        uint256 amount = shapes.backingOf(id);

        vm.prank(owner);
        try shapes.redeem(id) {
            ghostBackingOut += amount;
            ghostRedeems += 1;
            _untrack(id);
        } catch {}
    }

    function redeemBatch(uint256 tokenSeed, uint256 countSeed) public {
        if (liveTokens.length == 0) return;
        uint256 start = tokenSeed % liveTokens.length;
        address owner = shapes.ownerOf(liveTokens[start]);

        // gather up to four consecutive live tokens owned by the same actor
        uint256[] memory scratch = new uint256[](4);
        uint256 n;
        uint256 want = bound(countSeed, 1, 4);
        for (uint256 i = 0; i < liveTokens.length && n < want; ++i) {
            uint256 id = liveTokens[(start + i) % liveTokens.length];
            if (shapes.ownerOf(id) != owner) continue;
            bool dup;
            for (uint256 j = 0; j < n; ++j) {
                if (scratch[j] == id) dup = true;
            }
            if (!dup) scratch[n++] = id;
        }
        if (n == 0) return;

        uint256[] memory ids = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = scratch[i];
            total += shapes.backingOf(ids[i]);
        }

        vm.prank(owner);
        try shapes.redeemBatch(ids) {
            ghostBackingOut += total;
            ghostRedeems += n;
            for (uint256 i = 0; i < n; ++i) {
                _untrack(ids[i]);
            }
        } catch {}
    }

    /// @dev Ethereum can force ETH into any address. The reserve model must survive it.
    function forceEther(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, 50 ether);
        vm.deal(address(shapes), address(shapes).balance + amount);
    }

    /// @dev Nothing here should ever be able to move backing, but try anyway.
    function pokeUnknownSelector(bytes4 selector, uint256 valueSeed) public {
        uint256 value = bound(valueSeed, 0, 10 ether);
        vm.deal(address(this), value);
        (bool ok,) = address(shapes).call{value: value}(abi.encodePacked(selector));
        ok; // expected to fail; the invariants prove nothing moved
    }
}

/* ==================================================================== *
 *  Invariants
 * ==================================================================== */

contract ShapesInvariantTest is StdInvariant, Test {
    uint256 internal constant FEE_BPS = 100; // 1%

    ShapeRenderer internal renderer;
    Shapes internal shapes;
    Handler internal handler;
    address internal feeRecipient = address(0xFEE);

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes(FEE_BPS, feeRecipient, address(renderer));
        handler = new Handler(shapes);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = Handler.mint.selector;
        selectors[1] = Handler.mintBatch.selector;
        selectors[2] = Handler.transfer.selector;
        selectors[3] = Handler.redeem.selector;
        selectors[4] = Handler.redeemBatch.selector;
        selectors[5] = Handler.forceEther.selector;
        selectors[6] = Handler.pokeUnknownSelector.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice The reserve is always solvent. This is the invariant that matters.
    function invariant_ReserveIsSolvent() public view {
        assertGe(
            address(shapes).balance,
            shapes.totalBacking(),
            "contract balance fell below totalBacking"
        );
    }

    /// @notice totalBacking is exactly what came in minus what was redeemed out.
    function invariant_BackingIsConservedExactly() public view {
        assertEq(
            shapes.totalBacking(),
            handler.ghostBackingIn() - handler.ghostBackingOut(),
            "backing accounting drifted"
        );
    }

    /// @notice Every wei counted by totalBacking corresponds to a live Shape.
    function invariant_BackingEqualsSumOfLiveTokens() public view {
        uint256 sum;
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            sum += shapes.backingOf(id);
        }
        assertEq(sum, shapes.totalBacking(), "totalBacking does not match live tokens");
        assertEq(n, shapes.totalSupply(), "live supply mismatch");
    }

    /// @notice Fees never enter the reserve, and every minted token paid exactly one.
    function invariant_FeesAreSeparateFromBacking() public view {
        assertEq(feeRecipient.balance, handler.ghostFeesPaid(), "fee accounting drifted");
        assertEq(
            handler.ghostFeesPaid(),
            (handler.ghostBackingIn() * handler.feeBps()) / 10_000,
            "fees are exactly feeBps of all backing minted"
        );
        assertGe(
            address(shapes).balance,
            shapes.totalBacking(),
            "fees leaked into or out of the reserve"
        );
    }

    /// @notice Supply counters stay consistent with each other.
    function invariant_SupplyCountersAgree() public view {
        assertEq(
            shapes.totalSupply(),
            handler.ghostMints() - handler.ghostRedeems(),
            "live supply drifted"
        );
        assertEq(shapes.totalMinted(), handler.ghostMints(), "totalMinted drifted");
        assertGe(shapes.totalMinted(), shapes.totalSupply(), "totalMinted must be monotonic");
    }

    /// @notice Every live token carries one of the nine denominations. Nothing else is
    ///         representable.
    function invariant_EveryLiveTokenIsOnTheLadder() public view {
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            assertTrue(
                shapes.isSupportedDenomination(shapes.backingOf(id)),
                "token holds an off-ladder amount"
            );
        }
    }

    /// @notice Whatever the sequence was, every live Shape can still be redeemed for exactly
    ///         its backing. Solvency in the sense that actually matters to a holder.
    function invariant_EveryLiveShapeIsStillRedeemable() public {
        uint256 n = handler.liveTokenCount();
        if (n == 0) return;

        uint256 snapshot = vm.snapshotState();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            address owner = shapes.ownerOf(id);
            uint256 amount = shapes.backingOf(id);
            uint256 before = owner.balance;

            vm.prank(owner);
            shapes.redeem(id);

            assertEq(owner.balance - before, amount, "a live Shape could not pay out in full");
        }
        assertEq(shapes.totalBacking(), 0, "reserve not fully drained by redeeming everything");
        vm.revertToState(snapshot);
    }
}

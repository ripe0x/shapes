// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";

/* ==================================================================== *
 *  Hostile recipients for the `*To` value-flow paths (PR #1).
 * ==================================================================== */

/// @dev Accepts NFTs but reverts on ETH. A `redeemTo` paying it reverts; it can still own tokens
///      minted by `splitTo`, which the suite must still be able to drain.
contract HostileRejectETH is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        revert("HostileRejectETH: no ETH");
    }
}

/// @dev Accepts ETH but is not an ERC721 receiver, so `splitTo` minting to it
///      reverts on `_safeMint`. It therefore never comes to own a Shape.
contract HostileRejectNFT {
    receive() external payable {}
}

/// @dev On every value receipt (an NFT via `onERC721Received`, or ETH via `receive`) it tries to
///      reenter `Shapes`. The reentrancy guard must block every attempt; the invariants prove
///      nothing was double-counted. Attempts are caught internally so the primary op still
///      completes, which is the harder case to keep solvent.
contract HostileReentrant is IERC721Receiver {
    Shapes public immutable shapes;
    uint256 public lastToken;

    constructor(Shapes shapes_) {
        shapes = shapes_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        lastToken = tokenId;
        try shapes.redeem(tokenId) {} catch {} // reentry during a mint-to-recipient
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (lastToken != 0) {
            try shapes.redeem(lastToken) {} catch {} // reentry during a payout
        }
    }
}

/// @notice Drives arbitrary sequences of mint / batch mint / transfer / redeem / batch redeem,
///         recomposition, and the recipient-directed `*To` variants against hostile recipients,
///         tracking its own view of what the reserve should be.
contract Handler is Test, IERC721Receiver {
    Shapes public immutable shapes;
    uint256 public immutable feeBps;

    address[4] public actors;

    /// @dev Hostile recipients for the recipient-directed `*To` paths: [rejectETH, rejectNFT, reentrant].
    address[3] public hostiles;

    /// @dev Ghost accounting, maintained independently of the contract's own counters.
    uint256 public ghostBackingIn;
    uint256 public ghostBackingOut;
    uint256 public ghostFeesPaid;
    uint256 public ghostMints;
    uint256 public ghostRedeems;
    uint256 public ghostOriginsRedeemed;
    uint256 public ghostSacrificed;

    uint256[] public liveTokens;
    mapping(uint256 => uint256) private _indexOfToken;

    uint256[9] internal DENOMS = [
        uint256(0.01 ether), 0.05 ether, 0.1 ether, 0.5 ether, 1 ether, 5 ether, 10 ether, 50 ether, 100 ether
    ];

    constructor(Shapes shapes_) {
        shapes = shapes_;
        feeBps = shapes_.feeBps();
        actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];
        for (uint256 i = 0; i < actors.length; ++i) {
            vm.deal(actors[i], 100_000 ether);
        }
        hostiles = [
            address(new HostileRejectETH()),
            address(new HostileRejectNFT()),
            address(new HostileReentrant(shapes_))
        ];
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
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
        uint256 origins = shapes.originCountOf(id);

        vm.prank(owner);
        try shapes.redeem(id) {
            ghostBackingOut += amount;
            ghostRedeems += 1;
            ghostOriginsRedeemed += origins;
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
        uint256 origins;
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = scratch[i];
            total += shapes.backingOf(ids[i]);
            origins += shapes.originCountOf(ids[i]);
        }

        vm.prank(owner);
        try shapes.redeemBatch(ids) {
            ghostBackingOut += total;
            ghostRedeems += n;
            ghostOriginsRedeemed += origins;
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

    /// @dev Compose a token one tier up with same-denom siblings of the same owner, when enough
    ///      are available. Exercises composition without moving ETH.
    function compose(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 survivor = liveTokens[seed % liveTokens.length];
        uint256 amt = shapes.backingOf(survivor);
        uint256 di = _denomIndex(amt);
        if (di == 9 || di == 8) return; // unknown, or already the top tier
        address owner = shapes.ownerOf(survivor);
        uint256 ratio = DENOMS[di + 1] / amt; // 2 or 5

        uint256[] memory burn = new uint256[](ratio - 1);
        uint256 got;
        for (uint256 i = 0; i < liveTokens.length && got < ratio - 1; ++i) {
            uint256 id = liveTokens[i];
            if (id == survivor) continue;
            if (shapes.ownerOf(id) != owner) continue;
            if (shapes.backingOf(id) != amt) continue;
            burn[got++] = id;
        }
        if (got < ratio - 1) return;

        vm.prank(owner);
        try shapes.compose(survivor, burn) {
            for (uint256 i = 0; i < burn.length; ++i) {
                _untrack(burn[i]);
            }
        } catch {}
    }

    /// @dev Split a token one tier down. Exercises decomposition without moving ETH. The
    function split(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[seed % liveTokens.length];
        uint256 amt = shapes.backingOf(id);
        uint256 di = _denomIndex(amt);
        if (di == 9 || di == 0) return; // unknown, or already the minimum tier
        address owner = shapes.ownerOf(id);
        uint256 ratio = amt / DENOMS[di - 1]; // 2 or 5

        uint8[] memory outs = new uint8[](ratio);
        for (uint256 i = 0; i < ratio; ++i) {
            outs[i] = uint8(di - 1);
        }

        vm.prank(owner);
        try shapes.split(id, outs) returns (uint256[] memory kids) {
            _untrack(id);
            for (uint256 i = 0; i < kids.length; ++i) _track(kids[i]);
        } catch {}
    }

    /// @dev Sacrifice a live apex Complete if one exists. Apex Completes essentially never arise
    ///      from random fuzzing (10,000 conserved origins on one token), so this rarely fires;
    ///      the sacrifice path is exercised directly by the unit suite. It is kept here so the
    ///      invariant model stays exact should one ever be reached.
    function sacrifice(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[seed % liveTokens.length];
        if (shapes.isBlack(id)) return;
        if (shapes.backingOf(id) != 100 ether || shapes.originCountOf(id) != 10_000) return;

        address owner = shapes.ownerOf(id);
        vm.prank(owner);
        try shapes.sacrifice(id) {
            ghostSacrificed += 100 ether;
        } catch {}
    }

    /* -------------------- recipient-directed value flows (PR #1) -------------------- */

    /// @dev Redeem to a hostile recipient. The owner still authorises it; the payout lands on a
    ///      third party that may revert or reenter. Reserve accounting is identical to `redeem` —
    ///      only the destination differs — so the ghosts move only if the call actually settles.
    function redeemToHostile(uint256 tokenSeed, uint256 recipSeed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[tokenSeed % liveTokens.length];
        address owner = shapes.ownerOf(id);
        address payable recip = payable(hostiles[recipSeed % 3]);
        uint256 amount = shapes.backingOf(id);
        uint256 origins = shapes.originCountOf(id);

        vm.prank(owner);
        try shapes.redeemTo(id, recip) {
            ghostBackingOut += amount;
            ghostRedeems += 1;
            ghostOriginsRedeemed += origins;
            _untrack(id);
        } catch {}
    }

    function redeemBatchToHostile(uint256 tokenSeed, uint256 countSeed, uint256 recipSeed) public {
        if (liveTokens.length == 0) return;
        uint256 start = tokenSeed % liveTokens.length;
        address owner = shapes.ownerOf(liveTokens[start]);

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
        uint256 origins;
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = scratch[i];
            total += shapes.backingOf(ids[i]);
            origins += shapes.originCountOf(ids[i]);
        }
        address payable recip = payable(hostiles[recipSeed % 3]);

        vm.prank(owner);
        try shapes.redeemBatchTo(ids, recip) returns (uint256) {
            ghostBackingOut += total;
            ghostRedeems += n;
            ghostOriginsRedeemed += origins;
            for (uint256 i = 0; i < n; ++i) {
                _untrack(ids[i]);
            }
        } catch {}
    }

    /// @dev Split, minting the children to a hostile recipient. Moves no ETH; if the recipient
    ///      rejects the mint the whole call reverts and nothing changes.
    function splitToHostile(uint256 seed, uint256 recipSeed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[seed % liveTokens.length];
        uint256 amt = shapes.backingOf(id);
        uint256 di = _denomIndex(amt);
        if (di == 9 || di == 0) return;
        address owner = shapes.ownerOf(id);
        address recip = hostiles[recipSeed % 3];
        uint256 ratio = amt / DENOMS[di - 1];

        uint8[] memory outs = new uint8[](ratio);
        for (uint256 i = 0; i < ratio; ++i) {
            outs[i] = uint8(di - 1);
        }

        vm.prank(owner);
        try shapes.splitTo(id, outs, recip) returns (uint256[] memory kids) {
            _untrack(id);
            for (uint256 i = 0; i < kids.length; ++i) _track(kids[i]);
        } catch {}
    }

    /// @dev Reverse a token's most recent compose, if it has one. Re-minted inputs come back under
    ///      their original ids and are re-tracked, so the live set and the ETH-conservation model
    ///      stay exact across the merge/un-merge round trip.
    function decompose(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 survivor = liveTokens[seed % liveTokens.length];
        if (shapes.composeDepth(survivor) == 0) return;
        address owner = shapes.ownerOf(survivor);
        vm.prank(owner);
        try shapes.decompose(survivor) returns (uint256[] memory restored) {
            for (uint256 i = 0; i < restored.length; ++i) {
                _track(restored[i]);
            }
        } catch {}
    }

    /// @dev Reverse a compose, reviving the inputs to a hostile recipient. Moves no ETH; if the
    ///      recipient rejects the mint the whole call reverts and the record stays intact.
    function decomposeToHostile(uint256 seed, uint256 recipSeed) public {
        if (liveTokens.length == 0) return;
        uint256 survivor = liveTokens[seed % liveTokens.length];
        if (shapes.composeDepth(survivor) == 0) return;
        address owner = shapes.ownerOf(survivor);
        address recip = hostiles[recipSeed % 3];
        vm.prank(owner);
        try shapes.decomposeTo(survivor, recip) returns (uint256[] memory restored) {
            for (uint256 i = 0; i < restored.length; ++i) {
                _track(restored[i]);
            }
        } catch {}
    }

    function _denomIndex(uint256 amt) private view returns (uint256) {
        for (uint256 i = 0; i < 9; ++i) {
            if (DENOMS[i] == amt) return i;
        }
        return 9;
    }
}

/* ==================================================================== *
 *  Invariants
 * ==================================================================== */

contract ShapesInvariantTest is StdInvariant, Test {
    uint256 internal constant FEE_BPS = 100; // 1%

    ShapeRenderer internal renderer;

    ShapeCollection internal collection;
    Shapes internal shapes;
    Handler internal handler;
    address internal feeRecipient = address(0xFEE);

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(FEE_BPS, feeRecipient, address(renderer), address(collection));
        handler = new Handler(shapes);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = Handler.mint.selector;
        selectors[1] = Handler.mintBatch.selector;
        selectors[2] = Handler.transfer.selector;
        selectors[3] = Handler.redeem.selector;
        selectors[4] = Handler.redeemBatch.selector;
        selectors[5] = Handler.forceEther.selector;
        selectors[6] = Handler.pokeUnknownSelector.selector;
        selectors[7] = Handler.compose.selector;
        selectors[8] = Handler.split.selector;
        selectors[9] = Handler.sacrifice.selector;
        selectors[10] = Handler.redeemToHostile.selector;
        selectors[11] = Handler.redeemBatchToHostile.selector;
        selectors[12] = Handler.splitToHostile.selector;
        selectors[13] = Handler.decompose.selector;
        selectors[14] = Handler.decomposeToHostile.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice The reserve is always solvent. This is the invariant that matters.
    function invariant_ReserveIsSolvent() public view {
        assertGe(
            address(shapes).balance,
            shapes.redeemableBacking(),
            "contract balance fell below redeemableBacking"
        );
    }

    /// @notice redeemableBacking is exactly what came in, minus what was redeemed out, minus what
    ///         was sacrificed to Black Shapes.
    function invariant_BackingIsConservedExactly() public view {
        assertEq(
            shapes.redeemableBacking(),
            handler.ghostBackingIn() - handler.ghostBackingOut() - handler.ghostSacrificed(),
            "backing accounting drifted"
        );
    }

    /// @notice Sacrificed backing is monotonic and always exactly 100 ETH per Black Shape.
    function invariant_SacrificeAccounting() public view {
        assertEq(shapes.sacrificedBacking(), 100 ether * shapes.blackCount(), "sacrifice per Black drifted");
        assertEq(shapes.sacrificedBacking(), handler.ghostSacrificed(), "sacrifice accounting drifted");
    }

    /// @notice Every wei counted by redeemableBacking corresponds to a live Shape.
    function invariant_BackingEqualsSumOfLiveTokens() public view {
        uint256 sum;
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            sum += shapes.backingOf(id);
        }
        assertEq(sum, shapes.redeemableBacking(), "redeemableBacking does not match live tokens");
        assertEq(n, shapes.totalSupply(), "live supply mismatch");
    }

    /// @notice The generic draft ERC-8060 value seam is exactly the native backing query.
    function invariant_ValueAlwaysEqualsBacking() public view {
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            assertEq(shapes.valueOf(id), shapes.backingOf(id), "valueOf/backingOf drifted");
        }
    }

    /// @notice Origins are created only by mint and destroyed only by redeem. The sum of live
    ///         origin counts equals mints minus origins redeemed — no operation manufactures them.
    function invariant_OriginsAreConserved() public view {
        uint256 sum;
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            sum += shapes.originCountOf(handler.liveTokens(i));
        }
        assertEq(
            sum, handler.ghostMints() - handler.ghostOriginsRedeemed(), "origin count was fabricated or lost"
        );
    }

    /// @notice No token ever holds more origins than its backing has 0.01 units.
    function invariant_OriginsWithinCapacity() public view {
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            assertLe(
                shapes.originCountOf(id), shapes.backingOf(id) / 0.01 ether, "origin count exceeds capacity"
            );
        }
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
            address(shapes).balance, shapes.redeemableBacking(), "fees leaked into or out of the reserve"
        );
    }

    /// @notice Supply counters stay consistent. Recomposition mints and burns tokens without
    ///         creating origins, so totalMinted is a high-water id counter, not a mint tally;
    ///         only its relationship to live supply is asserted here (live supply itself is
    ///         checked against the tracked live set in invariant_BackingEqualsSumOfLiveTokens).
    function invariant_SupplyCountersAgree() public view {
        assertGe(shapes.totalMinted(), shapes.totalSupply(), "totalMinted below live supply");
    }

    /// @notice No id ever escapes the counter. Ids are issued from 0 and `totalMinted` counts
    ///         them, so every id in existence is strictly below it. This is the property that
    ///         keeps `decompose`'s revived ids from colliding with a fresh mint: a revived id was
    ///         issued in the past and so is bounded here, while a fresh mint takes `totalMinted`
    ///         itself. An off-by-one in `_mintBatch`, `split` or `decompose`'s deliberate refusal
    ///         to advance the counter would surface as a violation whatever the sequence was.
    function invariant_EveryLiveIdIsBelowTheCounter() public view {
        uint256 minted = shapes.totalMinted();
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            assertLt(handler.liveTokens(i), minted, "a live id reached or passed totalMinted");
        }
    }

    /// @notice Every live token carries one of the nine denominations. Nothing else is
    ///         representable.
    function invariant_EveryLiveTokenIsOnTheLadder() public view {
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            if (shapes.isBlack(id)) continue; // Black tokens hold no redeemable backing
            assertTrue(
                shapes.isSupportedDenomination(shapes.backingOf(id)), "token holds an off-ladder amount"
            );
        }
    }

    /// @notice Whatever the sequence was, every live Shape's backing can still be extracted in
    ///         full. Solvency in the sense that actually matters. Drained via `redeemTo` to a
    ///         benign sink rather than `redeem`, so a Shape that a hostile recipient came to own
    ///         (through `splitTo`) is still provably redeemable: the owner
    ///         authorises the burn, and the ETH is directed somewhere that can receive it.
    function invariant_EveryLiveShapeIsStillRedeemable() public {
        uint256 n = handler.liveTokenCount();
        if (n == 0) return;

        address payable sink = payable(address(0x5169));
        uint256 snapshot = vm.snapshotState();
        uint256 expected;
        uint256 before = sink.balance;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.liveTokens(i);
            if (shapes.isBlack(id)) continue; // Black Shapes are intentionally non-redeemable
            expected += shapes.backingOf(id);

            vm.prank(shapes.ownerOf(id));
            shapes.redeemTo(id, sink);
        }
        assertEq(sink.balance - before, expected, "a live Shape could not pay out in full");
        assertEq(shapes.redeemableBacking(), 0, "reserve not fully drained by redeeming everything");
        vm.revertToState(snapshot);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {Denominations} from "../src/lib/Denominations.sol";

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
    uint256 public immutable mintFee;
    address public immutable admin;

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

    constructor(Shapes shapes_) {
        shapes = shapes_;
        mintFee = shapes_.mintFee();
        admin = shapes_.admin();
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
        // Hoist the fee query out of the prank window: an external call inside the `{value:}`
        // expression would consume the prank, and the mint would then run as the handler.
        uint256 cost = amount + shapes.mintFee();

        vm.prank(who);
        try shapes.mintTo{value: cost}(amount, who) returns (uint256 id) {
            ghostBackingIn += amount;
            ghostFeesPaid += shapes.mintFee();
            ghostMints += 1;
            _track(id);
        } catch {}
    }

    function mintBatch(uint256 denomSeed, uint256 actorSeed, uint256 qtySeed) public {
        uint256 amount = DENOMS[denomSeed % 9];
        uint256 qty = bound(qtySeed, 1, 8);
        address who = _actor(actorSeed);
        uint256 cost = qty * (amount + shapes.mintFee());

        vm.prank(who);
        try shapes.mintBatchTo{value: cost}(amount, qty, who) returns (uint256 first) {
            ghostBackingIn += amount * qty;
            ghostFeesPaid += shapes.mintFee() * qty;
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
            for (uint256 i = 0; i < kids.length; ++i) {
                _track(kids[i]);
            }
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
        if (shapes.backingOf(id) != DENOMS[8] || shapes.originCountOf(id) != 10_000) return;

        address owner = shapes.ownerOf(id);
        vm.prank(owner);
        try shapes.sacrifice(id) {
            ghostSacrificed += DENOMS[8];
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
            for (uint256 i = 0; i < kids.length; ++i) {
                _track(kids[i]);
            }
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

    /* -------------------- heterogeneous compose/split/decompose -------------------- */

    /// @dev Compose a survivor one tier up using a burn set gathered across whatever
    ///      denominations the owner currently holds, instead of `compose`'s same-denomination
    ///      siblings: greedily takes same-owner, non-Black, non-survivor live tokens whose
    ///      backing does not exceed the remaining gap, largest first, until the gap closes or the
    ///      12-id cap is reached. Exercises a heterogeneous burn set (SAMPLING_SPEC.md section 5).
    function composeMixed(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 survivor = liveTokens[seed % liveTokens.length];
        uint256 amt = shapes.backingOf(survivor);
        uint256 di = _denomIndex(amt);
        if (di == 9 || di == 8) return; // unknown, or already the top tier
        address owner = shapes.ownerOf(survivor);
        uint256 need = DENOMS[di + 1] - amt;

        uint256[] memory candidates = new uint256[](liveTokens.length);
        uint256 nCand;
        for (uint256 i = 0; i < liveTokens.length; ++i) {
            uint256 id = liveTokens[i];
            if (id == survivor) continue;
            if (shapes.ownerOf(id) != owner) continue;
            if (shapes.isBlack(id)) continue;
            candidates[nCand++] = id;
        }

        uint256[] memory burn = new uint256[](12);
        uint256 got;
        while (got < 12 && need > 0) {
            uint256 bestIdx = type(uint256).max;
            uint256 bestBacking;
            for (uint256 i = 0; i < nCand; ++i) {
                uint256 id = candidates[i];
                if (id == type(uint256).max) continue;
                uint256 b = shapes.backingOf(id);
                if (b <= need && b > bestBacking) {
                    bestBacking = b;
                    bestIdx = i;
                }
            }
            if (bestIdx == type(uint256).max) break;
            burn[got++] = candidates[bestIdx];
            need -= bestBacking;
            candidates[bestIdx] = type(uint256).max;
        }
        if (need != 0) return;

        uint256[] memory finalBurn = new uint256[](got);
        for (uint256 i = 0; i < got; ++i) {
            finalBurn[i] = burn[i];
        }

        vm.prank(owner);
        try shapes.compose(survivor, finalBurn) {
            for (uint256 i = 0; i < got; ++i) {
                _untrack(finalBurn[i]);
            }
        } catch {}
    }

    /// @dev Split a live token into non-equal output denominations: one tier-(di-1) output
    ///      followed by `(DENOMS[di] - DENOMS[di-1]) / DENOMS[di-2]` tier-(di-2) outputs, an
    ///      integer count on every rung of this ladder from di == 2 upward. Exercises an uneven
    ///      split, distinct from `split`'s equal-outDenoms breakdown.
    function splitUneven(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 id = liveTokens[seed % liveTokens.length];
        uint256 amt = shapes.backingOf(id);
        uint256 di = _denomIndex(amt);
        if (di == 9 || di < 2) return;
        address owner = shapes.ownerOf(id);

        uint256 n = (DENOMS[di] - DENOMS[di - 1]) / DENOMS[di - 2];
        uint8[] memory outs = new uint8[](1 + n);
        outs[0] = uint8(di - 1);
        for (uint256 i = 0; i < n; ++i) {
            outs[1 + i] = uint8(di - 2);
        }

        vm.prank(owner);
        try shapes.split(id, outs) returns (uint256[] memory kids) {
            _untrack(id);
            for (uint256 i = 0; i < kids.length; ++i) {
                _track(kids[i]);
            }
        } catch {}
    }

    /// @dev Reverses up to two stacked compose records on one survivor through the batch
    ///      `decomposeMany` entrypoint, instead of `decompose`'s single-record call, by repeating
    ///      the survivor's id `min(depth, 2)` times.
    function decomposeMany(uint256 seed) public {
        if (liveTokens.length == 0) return;
        uint256 survivor = liveTokens[seed % liveTokens.length];
        uint256 depth = shapes.composeDepth(survivor);
        if (depth == 0) return;
        uint256 reps = depth < 2 ? depth : 2;
        address owner = shapes.ownerOf(survivor);

        uint256[] memory ids = new uint256[](reps);
        for (uint256 i = 0; i < reps; ++i) {
            ids[i] = survivor;
        }

        vm.prank(owner);
        try shapes.decomposeMany(ids) returns (uint256[][] memory restored) {
            for (uint256 i = 0; i < restored.length; ++i) {
                for (uint256 j = 0; j < restored[i].length; ++j) {
                    _track(restored[i][j]);
                }
            }
        } catch {}
    }

    /// @dev Forwards whatever is currently pending to the fee recipient. No ghost accounting
    ///      changes: `pendingFees` and `feeRecipient.balance` are read directly by the invariant.
    function withdrawFees() public {
        try shapes.withdrawFees() {} catch {}
    }

    /// @dev Pranks the admin to change the mint fee within the cap. Every mint action reads
    ///      `shapes.mintFee()` live, so this is exercised against real mints regardless of when it
    ///      lands in a fuzz sequence.
    function setMintFee(uint256 feeSeed) public {
        uint256 newFee = bound(feeSeed, 0, shapes.unit());
        vm.prank(admin);
        try shapes.setMintFee(newFee) {} catch {}
    }
}

/* ==================================================================== *
 *  Invariants
 * ==================================================================== */

contract ShapesInvariantTest is StdInvariant, Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    ShapeRenderer internal renderer;

    ShapeCollection internal collection;
    Shapes internal shapes;
    Handler internal handler;
    address internal feeRecipient = address(0xFEE);

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, feeRecipient, address(renderer), address(collection), 0
        );
        // The handler must own and account for every live Shape. Genesis ownership is covered by
        // ContractOwnership.t.sol, so retire it before handing this collection to the handler.
        shapes.redeemTo(0, payable(address(0xD15CA4D)));
        handler = new Handler(shapes);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](20);
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
        selectors[15] = Handler.composeMixed.selector;
        selectors[16] = Handler.splitUneven.selector;
        selectors[17] = Handler.decomposeMany.selector;
        selectors[18] = Handler.withdrawFees.selector;
        selectors[19] = Handler.setMintFee.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice The reserve is always solvent. This is the invariant that matters.
    function invariant_ReserveIsSolvent() public view {
        assertGe(
            address(shapes).balance,
            shapes.redeemableBacking() + shapes.pendingFees(),
            "contract balance fell below redeemableBacking + pendingFees"
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
        assertEq(
            shapes.sacrificedBacking(),
            Denominations.amountAt(8) * shapes.blackCount(),
            "sacrifice per Black drifted"
        );
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
                shapes.originCountOf(id),
                shapes.backingOf(id) / Denominations.UNIT,
                "origin count exceeds capacity"
            );
        }
    }

    /// @notice Fees never enter the reserve. Every fee ever charged is accounted for either as
    ///         still pending or as already paid to whichever recipient was current at withdrawal
    ///         time; `setMintFee` makes the fee itself variable, so this no longer checks a fixed
    ///         per-mint amount, only that nothing was created or destroyed.
    function invariant_FeesAreSeparateFromBacking() public view {
        assertEq(
            feeRecipient.balance + shapes.pendingFees(), handler.ghostFeesPaid(), "fee accounting drifted"
        );
        assertGe(
            address(shapes).balance,
            shapes.redeemableBacking() + shapes.pendingFees(),
            "fees leaked into or out of the reserve"
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
            assertTrue(Denominations.isSupported(shapes.backingOf(id)), "token holds an off-ladder amount");
        }
    }

    /// @dev Set once `ownerToken()` has reverted, so later runs of the invariant below can catch
    ///      it ever coming back.
    bool internal ownerTokenEverAbsent;

    /// @notice While the owner token exists, `owner()` is exactly its ERC-721 holder and the
    ///         token is live. Once `ownerToken()` reverts (redeemed or burned), it never
    ///         succeeds again for the rest of the run: ownership does not silently reappear.
    function invariant_OwnerTokenTracksItsHolder() public {
        try shapes.ownerToken() returns (uint256 id) {
            assertFalse(ownerTokenEverAbsent, "owner token reappeared after ending");
            assertEq(shapes.owner(), shapes.ownerOf(id), "owner() did not match the owner token's holder");
        } catch {
            ownerTokenEverAbsent = true;
            assertEq(shapes.owner(), address(0), "owner() nonzero with no owner token");
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

    /// @dev The index of `tokenId` in the handler's current live set, for turning a token id into
    ///      the `seed` argument an action expects (`seed % liveTokenCount == index` when
    ///      `seed == index`).
    function _indexInLive(uint256 tokenId) internal view returns (uint256) {
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            if (handler.liveTokens(i) == tokenId) return i;
        }
        revert("token not live");
    }

    /// @notice Guards against `composeMixed`, `splitUneven` and `decomposeMany` going silently
    ///         inert (a consumed `vm.prank` leaving every call a no-op), the same failure mode
    ///         `AuctionInvariantTest.test_HandlerActuallyDrivesTheHouse` guards against for the
    ///         auction handler. Hand-drives a 0.5 ETH plus five 0.1 ETH mint to one actor, composes
    ///         them into 1 ETH with `composeMixed`, splits an independently minted 1 ETH token
    ///         unevenly with `splitUneven`, and reverses the compose with `decomposeMany`,
    ///         asserting `totalSupply` and `composeDepth` move at every step.
    function test_HandlerHeterogeneousActionsFire() public {
        uint256 actorSeed = 7; // arbitrary; only needs to stay fixed across every call below

        handler.mint(3, actorSeed); // DENOMS[3] = 0.5 ETH
        uint256 survivor = handler.liveTokens(handler.liveTokenCount() - 1);
        handler.mintBatch(2, actorSeed, 5); // 5 x DENOMS[2] = 0.1 ETH
        handler.mint(4, actorSeed); // an independent 1 ETH original, for splitUneven
        uint256 splitTarget = handler.liveTokens(handler.liveTokenCount() - 1);

        uint256 supply0 = shapes.totalSupply();
        assertEq(supply0, 7, "one 0.5, five 0.1, one 1 ETH");

        handler.composeMixed(_indexInLive(survivor));
        assertEq(shapes.composeDepth(survivor), 1, "composeMixed did not push a compose record");
        assertEq(shapes.backingOf(survivor), Denominations.amountAt(4), "0.5 + 5 x 0.1 composed to 1 ETH");
        assertEq(shapes.totalSupply(), supply0 - 5, "five burns removed from supply");

        uint256 supply1 = shapes.totalSupply();
        handler.splitUneven(_indexInLive(splitTarget));
        assertEq(shapes.totalSupply(), supply1 + 5, "1 ETH split into 6 children, net +5");

        uint256 supply2 = shapes.totalSupply();
        handler.decomposeMany(_indexInLive(survivor));
        assertEq(shapes.composeDepth(survivor), 0, "decomposeMany did not pop the record");
        assertEq(shapes.backingOf(survivor), Denominations.amountAt(3), "survivor reverted to 0.5 ETH");
        assertEq(shapes.totalSupply(), supply2 + 5, "five inputs restored by decomposeMany");
    }
}

/* ==================================================================== *
 *  Auction house: escrow custody invariants (I-2)
 * ==================================================================== */

/// @notice Drives the auction house through create / bid (cards and ETH) / withdraw / settle /
///         claim / cancel, so the house's card custody sits under the stateful suite. The
///         invariants prove: every Shape the house holds is either an open lot or in exactly one
///         escrow list, and everything the house holds can always be pulled back out.
contract AuctionHandler is Test, IERC721Receiver {
    Shapes public immutable shapes;
    ShapeAuctionHouse public immutable house;

    address[4] public actors;

    uint256[] public auctionIds;
    mapping(uint256 => uint256) public lotOf;
    mapping(uint256 => address) public sellerOf;
    mapping(uint256 => address[]) private _biddersOf;
    mapping(uint256 => mapping(address => bool)) private _isBidder;

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

    constructor(Shapes shapes_, ShapeAuctionHouse house_) {
        shapes = shapes_;
        house = house_;
        actors = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];
        for (uint256 i = 0; i < actors.length; ++i) {
            vm.deal(actors[i], 1_000_000 ether);
            vm.prank(actors[i]);
            shapes_.setApprovalForAll(address(house_), true);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function auctionCount() external view returns (uint256) {
        return auctionIds.length;
    }

    function bidders(uint256 id) external view returns (address[] memory) {
        return _biddersOf[id];
    }

    function _actor(uint256 s) private view returns (address) {
        return actors[s % actors.length];
    }

    function _recordBidder(uint256 id, address who) private {
        if (!_isBidder[id][who]) {
            _isBidder[id][who] = true;
            _biddersOf[id].push(who);
        }
    }

    /* ----------------------------- actions ----------------------------- */

    function createAuction(uint256 actorSeed, uint256 durSeed, uint256 extSeed, uint256 resSeed) public {
        address seller = _actor(actorSeed);
        uint64 duration = uint64(bound(durSeed, 1, house.MAX_DURATION()));
        uint32 extensionWindow = uint32(bound(extSeed, 0, duration));
        uint64 reserve = uint64(bound(resSeed, 1, 10));

        // Hoist the fee query out of the prank window; an external call inside `{value:}` consumes
        // the prank and the mint would run as the handler.
        uint256 cost = DENOMS[2] + shapes.mintFee();
        vm.prank(seller);
        try shapes.mint{value: cost}(DENOMS[2]) returns (uint256 lot) {
            vm.prank(seller);
            try house.createAuction(address(shapes), lot, duration, reserve, 500, extensionWindow) returns (
                uint256 id
            ) {
                auctionIds.push(id);
                lotOf[id] = lot;
                sellerOf[id] = seller;
            } catch {}
        } catch {}
    }

    function bidEth(uint256 aSeed, uint256 actorSeed, uint256 unitsSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        address bidder = _actor(actorSeed);
        uint256 backing = bound(unitsSeed, 1, 200) * Denominations.UNIT;
        uint256 cost = backing + shapes.mintFee();

        vm.prank(bidder);
        try house.bid{value: cost}(id, new uint256[](0), backing) {
            _recordBidder(id, bidder);
        } catch {}
    }

    function bidCards(uint256 aSeed, uint256 actorSeed, uint256 denomSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        address bidder = _actor(actorSeed);
        uint256 amount = DENOMS[denomSeed % 7]; // cap at 10 ETH to keep fuzzing cheap
        uint256 cost = amount + shapes.mintFee();

        vm.prank(bidder);
        uint256 card;
        try shapes.mint{value: cost}(amount) returns (uint256 c) {
            card = c;
        } catch {
            return;
        }

        uint256[] memory ids = new uint256[](1);
        ids[0] = card;
        vm.prank(bidder);
        try house.bid(id, ids, 0) {
            _recordBidder(id, bidder);
        } catch {}
    }

    /// @dev Several cards in one bid, so the multi-card `_takeCards` loop and the escrow bound are
    ///      exercised, not just the single-card path.
    function bidCardsMulti(uint256 aSeed, uint256 actorSeed, uint256 denomSeed, uint256 qtySeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        address bidder = _actor(actorSeed);
        uint256 amount = DENOMS[denomSeed % 5]; // <= 1 ETH
        uint256 qty = bound(qtySeed, 2, 8);
        uint256 unit = amount + shapes.mintFee();

        vm.prank(bidder);
        uint256 first;
        try shapes.mintBatch{value: unit * qty}(amount, qty) returns (uint256 f) {
            first = f;
        } catch {
            return;
        }

        uint256[] memory ids = new uint256[](qty);
        for (uint256 i = 0; i < qty; ++i) {
            ids[i] = first + i;
        }
        vm.prank(bidder);
        try house.bid(id, ids, 0) {
            _recordBidder(id, bidder);
        } catch {}
    }

    function withdraw(uint256 aSeed, uint256 actorSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        vm.prank(_actor(actorSeed));
        try house.withdraw(id) {} catch {}
    }

    function settle(uint256 aSeed, uint256 warpSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        if (warpSeed % 2 == 0) vm.warp(block.timestamp + 2 days);
        try house.settle(id) {} catch {}
    }

    function claimProceeds(uint256 aSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        vm.prank(sellerOf[id]);
        try house.claimProceeds(id) {} catch {}
    }

    function cancel(uint256 aSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        vm.prank(sellerOf[id]);
        try house.cancelAuction(id) {} catch {}
    }

    /// @dev Pulls the lot: the winner if a bid landed, the seller otherwise. Mirrors the house's
    ///      own recipient rule so a settled or cancelled auction can actually be drained.
    function claimLot(uint256 aSeed) public {
        if (auctionIds.length == 0) return;
        uint256 id = auctionIds[aSeed % auctionIds.length];
        address highestBidder = house.auctions(id).highestBidder;
        address recipient = highestBidder == address(0) ? sellerOf[id] : highestBidder;
        vm.prank(recipient);
        try house.claimLot(id) {} catch {}
    }

    function warp(uint256 s) public {
        vm.warp(block.timestamp + bound(s, 1, 2 days));
    }

    /// @dev Forwards whatever mint fee has accrued to the current `feeRecipient`. Registered so
    ///      `AuctionInvariantHostileFeeTest`'s hostile recipient still gets a chance to reenter
    ///      from its `receive` during fuzzing, now that the callback lives here instead of inside
    ///      a bid's escrow mint.
    function withdrawFees() public {
        try shapes.withdrawFees() {} catch {}
    }
}

contract AuctionInvariantTest is StdInvariant, Test {
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;
    ShapeAuctionHouse internal house;
    AuctionHandler internal handler;

    function setUp() public virtual {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, address(0xFEE), address(renderer), address(collection), 0
        );
        house = new ShapeAuctionHouse(address(shapes));
        handler = new AuctionHandler(shapes, house);
        _wire();
    }

    /// @dev Register the handler and its action selectors as the fuzz target. Shared with the
    ///      hostile-fee-recipient variant so both drive the same action set.
    function _wire() internal {
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = AuctionHandler.createAuction.selector;
        selectors[1] = AuctionHandler.bidEth.selector;
        selectors[2] = AuctionHandler.bidCards.selector;
        selectors[3] = AuctionHandler.bidCardsMulti.selector;
        selectors[4] = AuctionHandler.withdraw.selector;
        selectors[5] = AuctionHandler.settle.selector;
        selectors[6] = AuctionHandler.claimProceeds.selector;
        selectors[7] = AuctionHandler.cancel.selector;
        selectors[8] = AuctionHandler.claimLot.selector;
        selectors[9] = AuctionHandler.warp.selector;
        selectors[10] = AuctionHandler.withdrawFees.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Guards against the handler silently going inert (a consumed `vm.prank` leaving every
    ///         action a no-op). If a handful of hand-driven actions do not open an auction and
    ///         escrow a card, the fuzz invariants below would be asserting over an empty house.
    function test_HandlerActuallyDrivesTheHouse() public {
        handler.createAuction(0, 1000, 10, 1);
        handler.bidEth(0, 1, 50);
        handler.bidCardsMulti(0, 2, 4, 3);
        assertGt(handler.auctionCount(), 0, "handler opened no auction");
        assertGt(shapes.balanceOf(address(house)), 0, "handler escrowed nothing");
    }

    /// @notice (a) Every Shape the house holds under its own operations is accounted for: an open
    ///         lot, or a card in exactly one bidder's escrow list. Balance above the escrow-plus-lot
    ///         sum means a stranded card; below it means one double-counted. This covers the house's
    ///         own paths only; a plain `transferFrom` push (documented as accepted, and unreachable
    ///         from this handler) would need a separate pushed term.
    function invariant_HouseHoldingsAreAccounted() public view {
        uint256 counted;
        uint256 n = handler.auctionCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.auctionIds(i);
            address[] memory bs = handler.bidders(id);
            for (uint256 j = 0; j < bs.length; ++j) {
                uint256[] memory cards = house.escrowedCards(id, bs[j]);
                for (uint256 k = 0; k < cards.length; ++k) {
                    assertEq(shapes.ownerOf(cards[k]), address(house), "escrowed card is not held");
                }
                counted += cards.length;
            }
            if (shapes.ownerOf(handler.lotOf(id)) == address(house)) counted++;
        }
        assertEq(shapes.balanceOf(address(house)), counted, "house holds an unaccounted Shape");
    }

    /// @notice (b) Every Shape the house holds has a reachable exit. Ending every auction and then
    ///         pulling every escrow and every lot drains the house to nothing, whatever the
    ///         sequence was. This is the property H-1 turns on: no escrow can be trapped.
    function invariant_HouseFullyDrains() public {
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 2 * house.MAX_DURATION()); // past every possible deadline

        uint256 n = handler.auctionCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.auctionIds(i);
            try house.settle(id) {}
            catch {
                vm.prank(handler.sellerOf(id));
                try house.cancelAuction(id) {} catch {}
            }
        }
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.auctionIds(i);
            address[] memory bs = handler.bidders(id);
            for (uint256 j = 0; j < bs.length; ++j) {
                vm.prank(bs[j]);
                try house.withdraw(id) {} catch {}
            }
            vm.prank(handler.sellerOf(id));
            try house.claimProceeds(id) {} catch {}

            // settle/cancelAuction record the outcome and move nothing; claimLot is the only path
            // that delivers the lot, to the winner if one exists, otherwise back to the seller.
            address highestBidder = house.auctions(id).highestBidder;
            address lotRecipient = highestBidder == address(0) ? handler.sellerOf(id) : highestBidder;
            vm.prank(lotRecipient);
            try house.claimLot(id) {} catch {}
        }

        assertEq(shapes.balanceOf(address(house)), 0, "house retained a Shape with no exit");
        vm.revertToState(snap);
    }

    /// @notice The house never accumulates ETH. Every bid's payment is forwarded to `shapes` in the
    ///         same call; the house holds only Shapes, never value directly.
    function invariant_HouseHoldsNoEther() public view {
        assertEq(address(house).balance, 0, "house accumulated ETH");
    }
}

/// @dev L-02 as a stateful property. The Shapes fee recipient is a contract that, on every fee it
///      receives (which happens inside the house's bid-path mint), tries to push a Shape it owns
///      into the house. `onERC721Received` must refuse every attempt, so the accounting invariant
///      holds with an actively hostile recipient in the loop, not only the single L-02 unit test.
contract HostileAuctionFeeRecipient is IERC721Receiver {
    Shapes public shapes;
    address public house;
    uint256 public held;
    bool public holds;

    function setTargets(Shapes shapes_, address house_) external {
        shapes = shapes_;
        house = house_;
    }

    function acquire(uint256 amount) external {
        held = shapes.mint{value: amount + shapes.mintFee()}(amount);
        holds = true;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (holds) {
            try IERC721(address(shapes)).safeTransferFrom(address(this), house, held) {} catch {}
        }
    }
}

contract AuctionInvariantHostileFeeTest is AuctionInvariantTest {
    HostileAuctionFeeRecipient internal hostile;

    function setUp() public override {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        hostile = new HostileAuctionFeeRecipient();
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, address(hostile), address(renderer), address(collection), 0
        );
        house = new ShapeAuctionHouse(address(shapes));
        hostile.setTargets(shapes, address(house));

        // The recipient acquires a Shape it will try to push in on every fee it later receives.
        vm.deal(address(hostile), 100 ether);
        hostile.acquire(Denominations.amountAt(2));

        handler = new AuctionHandler(shapes, house);
        _wire();
    }

    /// @notice The hostile recipient never succeeds in stranding its Shape in the house.
    function invariant_HostileFeeRecipientKeepsItsShape() public view {
        assertEq(shapes.ownerOf(hostile.held()), address(hostile), "a pushed Shape was stranded");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {Shapes} from "shapes/Shapes.sol";

import {ShapePacks} from "../src/ShapePacks.sol";
import {PacksTest} from "./utils/PacksTest.sol";

/// @notice Drives arbitrary sequences of pack creation (minted, pulled, mixed), extension, transfer,
///         every exit (open, openTo, redeem, redeemTo, unseal, claim, claimEth), forced ETH, Shapes
///         pushed in by plain `transferFrom`, refused `safeTransferFrom`s and raw calldata, while
///         keeping its own ghost view of what the contract must say.
/// @dev Every action reads what it needs into locals before `vm.prank`, because the prank is
///      consumed by the next external call, and wraps the contract call in `try` so that a rule
///      the contract enforces on its own (a floor, an owner check) is a skipped step rather than a
///      handler failure. Ghost state is updated only when the call succeeded.
contract PacksHandler is Test {
    ShapePacks public immutable packs;
    Shapes public immutable shapes;
    uint256 public immutable minValue;

    address[3] public actors;

    /* ----------------------------- ghost state ----------------------------- */

    /// @dev Live pack ids, in no particular order. `_liveAt1[id]` is the index plus one.
    uint256[] public live;
    mapping(uint256 => uint256) private _liveAt1;

    /// @dev Unsealed packs that still have Shapes to claim, and the claimant each was given.
    uint256[] public unsealed;
    mapping(uint256 => uint256) private _unsealedAt1;
    mapping(uint256 => address) public claimantGhost;
    /// @dev Unsealed packs that have been fully drained.
    uint256[] public drained;

    /// @dev Shapes pushed into the pack contract by plain `transferFrom`: accepted, stranded.
    uint256[] public strays;
    mapping(uint256 => bool) public isStray;

    /// @dev Every pack id the contract ever returned from a creation, in order.
    uint256[] public everIds;
    mapping(uint256 => bool) public everCreated;
    uint256 public lastId;

    /// @dev I3: the contents of every live pack as of the end of the previous action.
    mapping(uint256 => uint256[]) private _snapshot;

    /// @dev ETH put on the pack contract by `vm.deal`. I4 says the balance is exactly this.
    uint256 public forcedEth;

    /// @dev Highest `totalMinted` ever observed (I6).
    uint256 public maxTotalMinted;

    /// @dev Violations seen mid-sequence, which a view-only invariant could not catch afterwards.
    bool public contentsShrankOrReordered;
    bool public totalMintedDecreased;
    bool public packIdReissued;
    bool public redeemPaidWrongAmount;
    bool public unsolicitedSafeTransferAccepted;

    mapping(bytes32 => uint256) public attempts;
    mapping(bytes32 => uint256) public successes;

    constructor(ShapePacks packs_, Shapes shapes_) {
        packs = packs_;
        shapes = shapes_;
        minValue = packs_.MIN_PACK_VALUE();
        actors = [address(0xAC70), address(0xAC71), address(0xAC72)];
        for (uint256 i = 0; i < actors.length; ++i) {
            vm.deal(actors[i], 1_000_000 ether);
            vm.prank(actors[i]);
            shapes_.setApprovalForAll(address(packs_), true);
        }
    }

    /* ------------------------------ views ------------------------------ */

    function liveLength() external view returns (uint256) {
        return live.length;
    }

    function unsealedLength() external view returns (uint256) {
        return unsealed.length;
    }

    function drainedLength() external view returns (uint256) {
        return drained.length;
    }

    function strayLength() external view returns (uint256) {
        return strays.length;
    }

    function everLength() external view returns (uint256) {
        return everIds.length;
    }

    function isLive(uint256 id) public view returns (bool) {
        return _liveAt1[id] != 0;
    }

    /* ------------------------------ helpers ------------------------------ */

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _other(address who, uint256 s) internal view returns (address) {
        address a = _actor(s);
        return a == who ? _actor(s + 1) : a;
    }

    function _hit(bytes32 key, bool ok) internal {
        ++attempts[key];
        if (ok) ++successes[key];
    }

    function _addLive(uint256 id) internal {
        live.push(id);
        _liveAt1[id] = live.length;
        _snapshot[id] = packs.contentsOf(id);
    }

    function _removeLive(uint256 id) internal {
        uint256 i = _liveAt1[id] - 1;
        uint256 last = live.length - 1;
        if (i != last) {
            uint256 moved = live[last];
            live[i] = moved;
            _liveAt1[moved] = i + 1;
        }
        live.pop();
        delete _liveAt1[id];
        delete _snapshot[id];
    }

    function _removeUnsealed(uint256 id) internal {
        uint256 i = _unsealedAt1[id] - 1;
        uint256 last = unsealed.length - 1;
        if (i != last) {
            uint256 moved = unsealed[last];
            unsealed[i] = moved;
            _unsealedAt1[moved] = i + 1;
        }
        unsealed.pop();
        delete _unsealedAt1[id];
    }

    /// @dev Up to `max` live Shapes `who` owns, scanning from a seed-dependent offset so different
    ///      calls reach different Shapes.
    function _ownedBy(address who, uint256 max, uint256 seed) internal view returns (uint256[] memory out) {
        uint256 total = shapes.totalMinted();
        uint256[] memory tmp = new uint256[](max);
        uint256 n;
        uint256 start = total == 0 ? 0 : seed % total;
        for (uint256 k = 0; k < total && n < max; ++k) {
            uint256 id = (start + k) % total;
            if (shapes.exists(id) && shapes.ownerOf(id) == who) tmp[n++] = id;
        }
        out = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    /// @dev A small random makeup over the four cheapest denominations.
    function _makeup(uint256 seed) internal view returns (uint32[] memory counts) {
        counts = new uint32[](shapes.denominationCount());
        counts[0] = uint32(seed % 4);
        counts[1] = uint32((seed >> 8) % 3);
        counts[2] = uint32((seed >> 16) % 2);
        counts[3] = (seed >> 24) % 5 == 0 ? 1 : 0;
    }

    function _backing(uint32[] memory counts) internal view returns (uint256 total) {
        for (uint256 d = 0; d < counts.length; ++d) {
            total += uint256(counts[d]) * shapes.denominationAt(uint8(d));
        }
    }

    function _cost(uint32[] memory counts) internal view returns (uint256 total) {
        uint256 fee = shapes.mintFee();
        for (uint256 d = 0; d < counts.length; ++d) {
            total += uint256(counts[d]) * (shapes.denominationAt(uint8(d)) + fee);
        }
    }

    function _pulledBacking(uint256[] memory ids) internal view returns (uint256 total) {
        for (uint256 i = 0; i < ids.length; ++i) {
            total += shapes.backingOf(ids[i]);
        }
    }

    function _concat(uint256[] memory a, uint256[] memory b) internal pure returns (uint256[] memory out) {
        out = new uint256[](a.length + b.length);
        for (uint256 i = 0; i < a.length; ++i) {
            out[i] = a[i];
        }
        for (uint256 i = 0; i < b.length; ++i) {
            out[a.length + i] = b[i];
        }
    }

    /// @dev Mints `n` Shapes of ladder index `index` to `who`, paid by `who`.
    function _mintTo(address who, uint256 index, uint256 n) internal returns (uint256[] memory ids) {
        uint256 amount = shapes.denominationAt(uint8(index));
        uint256 cost = n * (amount + shapes.mintFee());
        vm.prank(who);
        uint256 first = shapes.mintBatchTo{value: cost}(amount, n, who);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = first + i;
        }
    }

    /// @dev Called at the end of every action: checks the I3 prefix property and I6 monotonicity
    ///      against the previous action's snapshot, then refreshes the snapshots.
    function _afterOp() internal {
        uint256 tm = packs.totalMinted();
        if (tm < maxTotalMinted) totalMintedDecreased = true;
        else maxTotalMinted = tm;

        for (uint256 k = 0; k < live.length; ++k) {
            uint256 id = live[k];
            uint256[] memory now_ = packs.contentsOf(id);
            uint256[] storage was = _snapshot[id];
            if (now_.length < was.length) {
                contentsShrankOrReordered = true;
            } else {
                for (uint256 i = 0; i < was.length; ++i) {
                    if (now_[i] != was[i]) {
                        contentsShrankOrReordered = true;
                        break;
                    }
                }
            }
            _snapshot[id] = now_;
        }
    }

    function _onCreated(uint256 id) internal {
        if (id != lastId + 1 || everCreated[id]) packIdReissued = true;
        lastId = id;
        everCreated[id] = true;
        everIds.push(id);
        _addLive(id);
    }

    function _create(address who, address to, uint256[] memory pulled, uint32[] memory counts, bytes32 key)
        internal
    {
        uint256 cost = _cost(counts);
        vm.prank(who);
        try packs.createPackTo{value: cost}(pulled, counts, to) returns (uint256 id) {
            _hit(key, true);
            _onCreated(id);
        } catch {
            _hit(key, false);
        }
        _afterOp();
    }

    function _pickLive(uint256 seed) internal view returns (bool ok, uint256 id) {
        if (live.length == 0) return (false, 0);
        return (true, live[seed % live.length]);
    }

    /* ----------------------------- creation ----------------------------- */

    /// @notice A pack of Shapes minted from ETH only.
    function createPackMinted(uint256 seed) public {
        address who = _actor(seed);
        address to = _actor(seed >> 8);
        uint32[] memory counts = _makeup(seed >> 16);
        if (_backing(counts) < minValue) counts[0] += 3;
        _create(who, to, new uint256[](0), counts, "createMinted");
    }

    /// @notice A pack of Shapes the creator already holds (plus one fresh mint to guarantee the
    ///         floor). Half the time the fresh mint is two 0.05 Shapes composed into one survivor,
    ///         so packs hold sampled-module Shapes too.
    function createPackPulled(uint256 seed) public {
        address who = _actor(seed);
        address to = _actor(seed >> 8);
        uint256[] memory owned = _ownedBy(who, 2, seed >> 16);

        uint256 pick = (seed >> 24) % 3;
        uint256[] memory fresh;
        if (pick == 0) {
            fresh = _mintTo(who, 0, 3);
        } else if (pick == 1) {
            fresh = _mintTo(who, 1, 1);
        } else {
            fresh = _mintTo(who, 1, 2);
            uint256 survivor = fresh[0];
            uint256[] memory burn = new uint256[](1);
            burn[0] = fresh[1];
            vm.prank(who);
            try shapes.compose(survivor, burn) {
                fresh = new uint256[](1);
                fresh[0] = survivor;
            } catch {}
        }
        _create(who, to, _concat(owned, fresh), new uint32[](shapes.denominationCount()), "createPulled");
    }

    /// @notice A pack of held Shapes and minted Shapes together.
    function createPackMixed(uint256 seed) public {
        address who = _actor(seed);
        address to = _actor(seed >> 8);
        uint256[] memory owned = _ownedBy(who, 2, seed >> 16);
        uint32[] memory counts = _makeup(seed >> 24);
        if (_pulledBacking(owned) + _backing(counts) < minValue) counts[0] += 3;
        _create(who, to, owned, counts, "createMixed");
    }

    /* ------------------------------ extension ------------------------------ */

    function addToPack(uint256 seed) public {
        (bool ok, uint256 id) = _pickLive(seed);
        if (!ok) return;
        address owner = packs.ownerOf(id);
        uint256[] memory owned = _ownedBy(owner, (seed >> 8) % 2, seed >> 16);
        uint32[] memory counts = _makeup(seed >> 24);
        if (owned.length == 0 && _backing(counts) == 0) counts[0] = 1;
        uint256 cost = _cost(counts);

        vm.prank(owner);
        try packs.addToPack{value: cost}(id, owned, counts) {
            _hit("add", true);
        } catch {
            _hit("add", false);
        }
        _afterOp();
    }

    function transferPack(uint256 seed) public {
        (bool ok, uint256 id) = _pickLive(seed);
        if (!ok) return;
        address from = packs.ownerOf(id);
        address to = _other(from, seed >> 8);
        vm.prank(from);
        try packs.transferFrom(from, to, id) {
            _hit("transfer", true);
        } catch {
            _hit("transfer", false);
        }
        _afterOp();
    }

    /* -------------------------------- exits -------------------------------- */

    function open(uint256 seed) public {
        (bool ok, uint256 id) = _pickLive(seed);
        if (!ok) return;
        address owner = packs.ownerOf(id);
        vm.prank(owner);
        try packs.open(id) {
            _hit("open", true);
            _removeLive(id);
            drained.push(id);
        } catch {
            _hit("open", false);
        }
        _afterOp();
    }

    function openTo(uint256 seed) public {
        (bool ok, uint256 id) = _pickLive(seed);
        if (!ok) return;
        address owner = packs.ownerOf(id);
        address to = _actor(seed >> 8);
        vm.prank(owner);
        try packs.openTo(id, to) {
            _hit("openTo", true);
            _removeLive(id);
            drained.push(id);
        } catch {
            _hit("openTo", false);
        }
        _afterOp();
    }

    /// @notice `redeem` or `redeemTo`, asserting the recipient is paid exactly the pack's value.
    function redeem(uint256 seed) public {
        (bool ok, uint256 id) = _pickLive(seed);
        if (!ok) return;
        address owner = packs.ownerOf(id);
        address payable recipient = payable((seed >> 8) % 2 == 0 ? owner : _actor(seed >> 9));
        uint256 value = packs.valueOf(id);
        uint256 before_ = recipient.balance;
        bool viaTo = (seed >> 16) % 2 == 0;

        vm.prank(owner);
        if (viaTo) {
            try packs.redeemTo(id, recipient) {
                _hit("redeem", true);
                _removeLive(id);
                drained.push(id);
                if (recipient.balance != before_ + value) redeemPaidWrongAmount = true;
            } catch {
                _hit("redeem", false);
            }
        } else {
            recipient = payable(owner);
            before_ = recipient.balance;
            try packs.redeem(id) {
                _hit("redeem", true);
                _removeLive(id);
                drained.push(id);
                if (recipient.balance != before_ + value) redeemPaidWrongAmount = true;
            } catch {
                _hit("redeem", false);
            }
        }
        _afterOp();
    }

    function unseal(uint256 seed) public {
        (bool ok, uint256 id) = _pickLive(seed);
        if (!ok) return;
        address owner = packs.ownerOf(id);
        address claimant = _actor(seed >> 8);
        vm.prank(owner);
        try packs.unseal(id, claimant) {
            _hit("unseal", true);
            _removeLive(id);
            unsealed.push(id);
            _unsealedAt1[id] = unsealed.length;
            claimantGhost[id] = claimant;
        } catch {
            _hit("unseal", false);
        }
        _afterOp();
    }

    function _drainedCheck(uint256 id) internal {
        if (packs.contentsOf(id).length == 0) {
            _removeUnsealed(id);
            drained.push(id);
        }
    }

    function claim(uint256 seed) public {
        if (unsealed.length == 0) return;
        uint256 id = unsealed[seed % unsealed.length];
        uint256 max = bound(seed >> 8, 1, 4);
        address claimant = claimantGhost[id];
        vm.prank(claimant);
        try packs.claim(id, max) {
            _hit("claim", true);
            _drainedCheck(id);
        } catch {
            _hit("claim", false);
        }
        _afterOp();
    }

    function claimEth(uint256 seed) public {
        if (unsealed.length == 0) return;
        uint256 id = unsealed[seed % unsealed.length];
        uint256 max = bound(seed >> 8, 1, 4);
        address claimant = claimantGhost[id];
        address payable recipient = payable(_actor(seed >> 16));

        // The Shapes that leave are the last `max` of the remaining list.
        uint256[] memory remaining = packs.contentsOf(id);
        uint256 n = max < remaining.length ? max : remaining.length;
        uint256 expected;
        for (uint256 i = 0; i < n; ++i) {
            expected += shapes.backingOf(remaining[remaining.length - 1 - i]);
        }
        uint256 before_ = recipient.balance;

        vm.prank(claimant);
        try packs.claimEth(id, max, recipient) {
            _hit("claimEth", true);
            if (recipient.balance != before_ + expected) redeemPaidWrongAmount = true;
            _drainedCheck(id);
        } catch {
            _hit("claimEth", false);
        }
        _afterOp();
    }

    /* ----------------------- ETH, strays and raw calls ----------------------- */

    /// @notice ETH can be forced into any contract. I4 allows exactly this much and no more.
    function forceEth(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, 10 ether);
        vm.deal(address(packs), address(packs).balance + amount);
        forcedEth += amount;
        _hit("forceEth", true);
    }

    /// @notice Pushes a held Shape into the pack contract with a plain `transferFrom`. Accepted
    ///         and stranded, per the design; recorded so I5 can account for it.
    function strayTransferFrom(uint256 seed) public {
        address who = _actor(seed);
        uint256[] memory owned = _ownedBy(who, 1, seed >> 8);
        uint256 id;
        if (owned.length == 0) {
            id = _mintTo(who, 0, 1)[0];
        } else {
            id = owned[0];
        }
        vm.prank(who);
        try shapes.transferFrom(who, address(packs), id) {
            _hit("stray", true);
            isStray[id] = true;
            strays.push(id);
        } catch {
            _hit("stray", false);
        }
        _afterOp();
    }

    /// @notice A `safeTransferFrom` into the pack contract must be refused, whatever the state.
    function pokeSafeTransfer(uint256 seed) public {
        address who = _actor(seed);
        uint256[] memory owned = _ownedBy(who, 1, seed >> 8);
        if (owned.length == 0) return;
        uint256 id = owned[0];
        vm.prank(who);
        try shapes.safeTransferFrom(who, address(packs), id) {
            _hit("safeTransfer", true);
            unsolicitedSafeTransferAccepted = true;
            isStray[id] = true;
            strays.push(id);
        } catch {
            _hit("safeTransfer", false);
        }
        _afterOp();
    }

    /// @notice Arbitrary calldata and value at the pack contract, from an account that owns
    ///         nothing. Everything except a harmless view should revert.
    function poke(bytes4 selector, bytes calldata data, uint256 valueSeed) public {
        uint256 value = bound(valueSeed, 0, 1 ether);
        vm.deal(address(this), value);
        bytes memory payload = selector == bytes4(0) ? bytes("") : abi.encodePacked(selector, data);
        (bool ok,) = address(packs).call{value: value}(payload);
        _hit("poke", ok);
        _afterOp();
    }
}

contract PacksInvariantTest is StdInvariant, PacksTest {
    PacksHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PacksHandler(packs, shapes);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = PacksHandler.createPackMinted.selector;
        selectors[1] = PacksHandler.createPackPulled.selector;
        selectors[2] = PacksHandler.createPackMixed.selector;
        selectors[3] = PacksHandler.addToPack.selector;
        selectors[4] = PacksHandler.transferPack.selector;
        selectors[5] = PacksHandler.open.selector;
        selectors[6] = PacksHandler.openTo.selector;
        selectors[7] = PacksHandler.redeem.selector;
        selectors[8] = PacksHandler.unseal.selector;
        selectors[9] = PacksHandler.claim.selector;
        selectors[10] = PacksHandler.claimEth.selector;
        selectors[11] = PacksHandler.forceEth.selector;
        selectors[12] = PacksHandler.strayTransferFrom.selector;
        selectors[13] = PacksHandler.poke.selector;
        selectors[14] = PacksHandler.pokeSafeTransfer.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /* ------------------------ guards against an inert handler ------------------------ */

    /// @notice Hand-drives one of every action, so the invariants below are known to be asserting
    ///         over real packs and a consumed `vm.prank` cannot silently turn the handler into a
    ///         no-op.
    function test_HandlerActuallyDrivesThePacks() public {
        handler.createPackMinted(1);
        handler.createPackMixed(2);
        handler.createPackPulled(3);
        handler.createPackPulled(2 << 24); // a composed survivor goes in
        assertGt(handler.liveLength(), 0, "no pack created");
        bool sampled;
        for (uint256 k = 0; k < handler.liveLength(); ++k) {
            uint256[] memory ids = packs.contentsOf(handler.live(k));
            for (uint256 i = 0; i < ids.length; ++i) {
                if (shapes.modulesOf(ids[i]).length != 0) sampled = true;
            }
        }
        assertTrue(sampled, "no pack holds a compose survivor");
        assertEq(packs.totalSupply(), handler.liveLength());

        handler.addToPack(0);
        handler.transferPack(1);
        handler.forceEth(7);
        handler.strayTransferFrom(2);
        handler.pokeSafeTransfer(4);
        handler.poke(0x12345678, "", 5);
        assertGt(handler.successes("add"), 0, "addToPack never succeeded");
        assertGt(handler.successes("transfer"), 0, "transferPack never succeeded");
        assertGt(handler.successes("stray"), 0, "stray never recorded");

        handler.unseal(0);
        assertEq(handler.unsealedLength(), 1, "unseal never succeeded");
        handler.claim(0);
        handler.claimEth(0);
        handler.open(0);
        handler.openTo(1);
        handler.redeem(2);
        handler.redeem(3);
        assertGt(handler.successes("open") + handler.successes("openTo"), 0, "no pack was opened");
        assertGt(handler.successes("redeem"), 0, "no pack was redeemed");

        assertFalse(handler.contentsShrankOrReordered());
        assertFalse(handler.redeemPaidWrongAmount());
    }

    /* -------------------------------- invariants -------------------------------- */

    /// @dev I1: every live pack's contents are owned by the pack contract and name that pack.
    function invariant_I1_ContentsAreCustodiedAndNamed() public view {
        for (uint256 k = 0; k < handler.liveLength(); ++k) {
            uint256 packId = handler.live(k);
            assertTrue(packs.exists(packId), "live pack does not exist");
            uint256[] memory ids = packs.contentsOf(packId);
            assertGt(ids.length, 0, "live pack is empty");
            for (uint256 i = 0; i < ids.length; ++i) {
                assertEq(shapes.ownerOf(ids[i]), address(packs), "packed Shape not held by the pack contract");
                assertEq(packs.packOf(ids[i]), packId, "packOf does not name the pack");
            }
        }
    }

    /// @dev I2: the cached value is the live sum of backing, and never under the floor.
    function invariant_I2_ValueIsTheExactSumAndAtLeastTheFloor() public view {
        for (uint256 k = 0; k < handler.liveLength(); ++k) {
            uint256 packId = handler.live(k);
            uint256[] memory ids = packs.contentsOf(packId);
            uint256 sum;
            for (uint256 i = 0; i < ids.length; ++i) {
                sum += shapes.backingOf(ids[i]);
            }
            assertEq(packs.valueOf(packId), sum, "valueOf != sum of backing");
            assertGe(packs.valueOf(packId), packs.MIN_PACK_VALUE(), "value under the floor");
        }
    }

    /// @dev I3: contents only grow, in order. The handler compares every live pack against its
    ///      snapshot from the previous action, then refreshes it.
    function invariant_I3_ContentsOnlyGrow() public view {
        assertFalse(handler.contentsShrankOrReordered(), "a live pack's contents shrank or were reordered");
    }

    /// @dev I4: the pack contract holds exactly the ETH that was forced onto it, nothing else.
    ///      Creation, addition and redemption never leave a wei behind, and nothing can pay in.
    function invariant_I4_NoEthBeyondForcedEth() public view {
        assertEq(
            address(packs).balance, handler.forcedEth(), "ETH other than forced ETH is on the pack contract"
        );
    }

    /// @dev I5: every Shape owned by the pack contract is in exactly one live pack's contents, or
    ///      one unsealed pack's remaining list, or is a recorded stray. Conversely everything
    ///      those lists name is owned by the pack contract.
    function invariant_I5_EveryHeldShapeIsAccountedForOnce() public view {
        uint256 total = shapes.totalMinted();
        uint256[] memory claims = new uint256[](total);

        for (uint256 k = 0; k < handler.liveLength(); ++k) {
            uint256[] memory ids = packs.contentsOf(handler.live(k));
            for (uint256 i = 0; i < ids.length; ++i) {
                ++claims[ids[i]];
            }
        }
        for (uint256 k = 0; k < handler.unsealedLength(); ++k) {
            uint256[] memory ids = packs.contentsOf(handler.unsealed(k));
            for (uint256 i = 0; i < ids.length; ++i) {
                ++claims[ids[i]];
            }
        }
        for (uint256 k = 0; k < handler.strayLength(); ++k) {
            ++claims[handler.strays(k)];
        }

        for (uint256 id = 0; id < total; ++id) {
            bool held = shapes.exists(id) && shapes.ownerOf(id) == address(packs);
            if (held) {
                assertEq(claims[id], 1, "held Shape is not in exactly one pack or the stray set");
            } else {
                assertEq(claims[id], 0, "a pack or stray names a Shape the pack contract does not hold");
            }
        }
    }

    /// @dev I6: pack ids are never reissued, `totalMinted` never decreases, `totalSupply` counts
    ///      exactly the live packs, and every id ever created exists iff the handler has it live.
    function invariant_I6_IdsNeverReissuedAndCountsAgree() public view {
        assertFalse(handler.packIdReissued(), "a pack id was reissued or skipped");
        assertFalse(handler.totalMintedDecreased(), "totalMinted decreased");
        assertGe(packs.totalMinted(), handler.maxTotalMinted(), "totalMinted below its high-water mark");
        assertEq(packs.totalMinted(), handler.lastId(), "totalMinted != ids handed out");
        assertEq(packs.totalMinted(), handler.everLength(), "totalMinted != packs created");
        assertEq(packs.totalSupply(), handler.liveLength(), "totalSupply != live packs");
        for (uint256 k = 0; k < handler.everLength(); ++k) {
            uint256 id = handler.everIds(k);
            assertEq(
                packs.exists(id), handler.isLive(id), "a created id's existence disagrees with the ghost"
            );
        }
    }

    /// @dev I7: an unsealed pack with Shapes remaining has a claimant and is not a token; a
    ///      drained pack has no claimant and nothing remaining.
    function invariant_I7_UnsealedPacksHaveClaimantsAndNoToken() public view {
        for (uint256 k = 0; k < handler.unsealedLength(); ++k) {
            uint256 id = handler.unsealed(k);
            assertGt(packs.contentsOf(id).length, 0, "tracked unsealed pack has nothing remaining");
            assertTrue(packs.claimantOf(id) != address(0), "unsealed pack with Shapes has no claimant");
            assertEq(packs.claimantOf(id), handler.claimantGhost(id), "claimant changed");
            assertFalse(packs.exists(id), "unsealed pack is still a token");
        }
        for (uint256 k = 0; k < handler.drainedLength(); ++k) {
            uint256 id = handler.drained(k);
            assertEq(packs.contentsOf(id).length, 0, "drained pack still lists Shapes");
            assertEq(packs.claimantOf(id), address(0), "drained pack still has a claimant");
            assertFalse(packs.exists(id), "drained pack is still a token");
        }
    }

    /* ------------------------------ supporting checks ------------------------------ */

    /// @dev Shapes remaining in an unsealed pack stay named by it until claimed.
    function invariant_UnsealedRemainderStaysNamed() public view {
        for (uint256 k = 0; k < handler.unsealedLength(); ++k) {
            uint256 id = handler.unsealed(k);
            uint256[] memory ids = packs.contentsOf(id);
            for (uint256 i = 0; i < ids.length; ++i) {
                assertEq(packs.packOf(ids[i]), id, "remaining Shape not named by its unsealed pack");
            }
        }
    }

    /// @dev A Shape that is in no pack is named by none: strays, wallets and burned ids read zero.
    function invariant_PackOfIsZeroOutsidePacks() public view {
        uint256 total = shapes.totalMinted();
        for (uint256 id = 0; id < total; ++id) {
            if (!shapes.exists(id) || shapes.ownerOf(id) != address(packs)) {
                assertEq(packs.packOf(id), 0, "a Shape outside custody is named by a pack");
            }
        }
        for (uint256 k = 0; k < handler.strayLength(); ++k) {
            assertEq(packs.packOf(handler.strays(k)), 0, "a stray is named by a pack");
        }
    }

    /// @dev Exits pay exactly the value of what leaves, through redeem, redeemTo and claimEth.
    function invariant_ExitsPayExactValue() public view {
        assertFalse(handler.redeemPaidWrongAmount(), "an ETH exit paid the wrong amount");
    }

    /// @dev A `safeTransferFrom` into the pack contract is refused in every state.
    function invariant_UnsolicitedSafeTransferIsRefused() public view {
        assertFalse(
            handler.unsolicitedSafeTransferAccepted(), "safeTransferFrom into the pack contract worked"
        );
    }

    function _name(bytes32 key) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && key[n] != 0) {
            ++n;
        }
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = key[i];
        }
        return string(out);
    }

    /// @notice Per-action counts, so a run shows what the fuzzer actually reached.
    function invariant_callSummary() public view {
        bytes32[13] memory keys = [
            bytes32("createMinted"),
            "createPulled",
            "createMixed",
            "add",
            "transfer",
            "open",
            "openTo",
            "redeem",
            "unseal",
            "claim",
            "claimEth",
            "stray",
            "safeTransfer"
        ];
        console.log("--- pack handler: successes / attempts ---");
        for (uint256 i = 0; i < keys.length; ++i) {
            console.log(_name(keys[i]), handler.successes(keys[i]), handler.attempts(keys[i]));
        }
        console.log("live", handler.liveLength());
        console.log("unsealed", handler.unsealedLength());
        console.log("strays", handler.strayLength());
        console.log("forced wei", handler.forcedEth());
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Handler} from "./Invariants.t.sol";
import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @dev Deterministic replay of the shrunk `invariant_DecomposeRestoredEveryRecordedState`
///      counterexample found by the 2026-09-03 invariant campaign at `1c2cfd9`, plus a minimal
///      hand-built sequence for the same class of state. Both drive the invariant suite's `Handler`
///      with fixed seeds, so a regression reproduces without a fuzz run.
contract DecomposeInvariantRegressionTest is Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;
    Handler internal handler;

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, address(0xFEE), address(renderer), 0);
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
        shapes.redeemTo(0, payable(address(0xD15CA4D)));
        handler = new Handler(shapes);
    }

    /// @dev The 12-step sequence shrunk from the deep-profile run (2000 runs, depth 100, seed
    ///      `0x889db500830486505c89004d5f9bcc9e7e40552042c5780512375c89326ea916`), replayed with the
    ///      same pre-`bound()` handler seeds.
    function test_ShrunkCounterexampleRestoresEveryRecordedState() public {
        handler.mint(762179621605252850435079043384466910685340236425304380779, 39478587752452895567990718339237944261420991);
        handler.mintBatch(8729, 9258, 1225148678);
        handler.redeemToHostile(21369, 7);
        handler.split(7443);
        handler.mint(164, 1000000000000);
        handler.split(3777);
        handler.split(8513);
        handler.composeMixed(1831565813);
        handler.composeMixed(1405310203571408291950365054053061012934685786633);
        handler.split(3);
        handler.redeem(9);
        handler.decomposeMany(6025621);

        assertFalse(handler.restoreMismatch(), "decompose did not restore a recorded pre-compose state");
    }

    /// @dev Minimal form of the same state: one survivor carrying two stacked compose records,
    ///      unwound by a single `decomposeMany` call. After the call the survivor holds its state
    ///      from before the older of the two composes. The state between the two records exists
    ///      only inside the transaction and cannot be read afterwards.
    function test_StackedRecordsUnwoundInOneCall() public {
        uint256 actorSeed = 7; // arbitrary; only needs to stay fixed across every call below

        handler.mint(3, actorSeed); // 0.5 ETH
        uint256 survivor = handler.liveTokens(handler.liveTokenCount() - 1);
        handler.mintBatch(2, actorSeed, 5); // 5 x 0.1 ETH, closing the gap to 1 ETH
        handler.composeMixed(_indexInLive(survivor));
        assertEq(shapes.composeDepth(survivor), 1, "first compose did not push a record");

        handler.mintBatch(4, actorSeed, 4); // 4 x 1 ETH, closing the gap to 5 ETH
        handler.composeMixed(_indexInLive(survivor));
        assertEq(shapes.composeDepth(survivor), 2, "second compose did not push a record");

        handler.decomposeMany(_indexInLive(survivor));
        assertEq(shapes.composeDepth(survivor), 0, "decomposeMany did not pop both records");
        assertEq(shapes.backingOf(survivor), Denominations.amountAt(3), "survivor did not return to 0.5 ETH");
        assertFalse(handler.restoreMismatch(), "decompose did not restore a recorded pre-compose state");
    }

    /// @dev The index of `tokenId` in the handler's current live set, for turning a token id into
    ///      the `seed` argument an action expects.
    function _indexInLive(uint256 tokenId) internal view returns (uint256) {
        uint256 n = handler.liveTokenCount();
        for (uint256 i = 0; i < n; ++i) {
            if (handler.liveTokens(i) == tokenId) return i;
        }
        revert("token not live");
    }
}

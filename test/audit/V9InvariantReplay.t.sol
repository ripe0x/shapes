// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Handler} from "../Invariants.t.sol";
import {Shapes} from "../../src/Shapes.sol";
import {ShapeCollection} from "../../src/ShapeCollection.sol";
import {ShapeRenderer} from "../../src/ShapeRenderer.sol";
import {Denominations} from "../../src/lib/Denominations.sol";
import {ComposeRecordView, ShapeState} from "../../src/ShapeTypes.sol";

/// @notice Deterministic replay of the seventeen-call sequence that broke
///         `invariant_DecomposeRestoredEveryRecordedState`. Same setup, same actions, same order,
///         so the sequence can be bisected without rerunning the fuzzer.
contract V9InvariantReplayTest is Test {
    uint256 internal constant MINT_FEE = Denominations.UNIT / 10;

    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;
    Handler internal handler;
    address internal feeRecipient = address(0xFEE);

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(renderer), 0);
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
        shapes.redeemTo(0, payable(address(0xD15CA4D)));
        handler = new Handler(shapes);
    }

    /// @dev `stopAfter` truncates the sequence, so a bisect is one parameter.
    function _replay(uint256 stopAfter) internal {
        if (stopAfter < 1) return;
        vm.prank(0x3c3508B3D1abDc54ae8c6aC211e5C98c291bd339);
        handler.mint(140000000000000000, 777);
        if (stopAfter < 2) return;
        vm.prank(0x0000000000000000000000000000000000001F19);
        handler.mintBatch(106759836418726450, 35772288380991758022554768065613654, 2662793118821);
        if (stopAfter < 3) return;
        vm.prank(0x0A5072B0A88D0a6Ff94CB7Bb71183013FF1fc39F);
        handler.split(190912322);
        if (stopAfter < 4) return;
        vm.prank(0x0000000000000000000000000000000000000B0b);
        handler.mintBatch(1916727116, 1965, 1000000000000000000000);
        if (stopAfter < 5) return;
        vm.prank(0x00000000000000000000000000000000000026da);
        handler.redeemToHostile(86400, 1535);
        if (stopAfter < 6) return;
        vm.prank(0x2b325A24531dE5D49dec2b1Aac8f20622720bAA9);
        handler.splitToHostile(2595, 224);
        if (stopAfter < 7) return;
        vm.prank(0x9DA0186F96a65158341dbe8ae0C304Ea76669a11);
        handler.redeemToHostile(2190172573, 227743786126973813218757308669571874488130752518563036745);
        if (stopAfter < 8) return;
        vm.prank(0x00000000000000000000000000000000000006a3);
        handler.split(3684167382);
        if (stopAfter < 9) return;
        vm.prank(0xb0FD68568177948b91fc1B112E77a41A51701D59);
        handler.redeemBatch(
            19356, 80167465652159884487584418398737133515478493586045375474096367959472086682926
        );
        if (stopAfter < 10) return;
        vm.prank(0x00000000000000000000000000000000000000b2);
        handler.redeemBatch(73457503900766342297038127143335, 120081314022995090699);
        if (stopAfter < 11) return;
        vm.prank(0x9d125dc6CD85f4E3C1db20956d291C7957A3b50E);
        handler.compose(1);
        if (stopAfter < 12) return;
        vm.prank(0x000000000000000000000000000000000D15Ca4D);
        handler.mint(830000000000000000, 38);
        if (stopAfter < 13) return;
        vm.prank(0x00000000000000000000000000000000000049D4);
        handler.redeem(14735);
        if (stopAfter < 14) return;
        vm.prank(0x00000000000000000000000000000000000000B4);
        handler.redeemBatchToHostile(
            1532990370612, 47858569385752083732370711561010937531621124817899318, 62806123916842
        );
        if (stopAfter < 15) return;
        vm.prank(0x0000000000000000000000000000000000000781);
        handler.redeem(224);
        if (stopAfter < 16) return;
        vm.prank(0xf80a5b7Ba4238a3f650EcBeac793568105f8AA49);
        handler.compose(503614795697069171873551676508672291877);
        if (stopAfter < 17) return;
        vm.prank(0x0000000000000000000000000000000000004bF0);
        handler.decomposeMany(15841);
    }

    /// @dev The sequence flagged a false mismatch before the handler compared each popped record
    ///      on its own; the fixed handler keeps it clean.
    function test_Replay_StaysCleanAfterTheHandlerFix() public {
        _replay(17);
        assertFalse(handler.restoreMismatch(), "the replayed sequence flagged a restore mismatch");
    }

    /// @dev Which call first sets the flag.
    function test_Replay_BisectTheFlaggingCall() public {
        for (uint256 n = 1; n <= 17; ++n) {
            uint256 snap = vm.snapshotState();
            _replay(n);
            bool flagged = handler.restoreMismatch();
            emit log_named_uint("calls", n);
            emit log_named_string("mismatch", flagged ? "yes" : "no");
            vm.revertToState(snap);
            if (flagged) {
                emit log_named_uint("first flagging call index", n);
                return;
            }
        }
        emit log("no call flagged");
    }

    /// @dev Checks the contract against its own record across the final decompose, independent of
    ///      the handler's ghost bookkeeping.
    function test_Diagnose_ContractAgainstItsOwnRecord() public {
        _replay(16);

        uint256 n = handler.liveTokenCount();
        uint256 survivor = handler.liveTokens(15841 % n);
        uint256 depth = shapes.composeDepth(survivor);
        emit log_named_uint("live tokens", n);
        emit log_named_uint("survivor", survivor);
        emit log_named_uint("composeDepth", depth);

        uint256 reps = depth < 2 ? depth : 2;
        ComposeRecordView[] memory recs = new ComposeRecordView[](reps);
        for (uint256 r = 0; r < reps; ++r) {
            recs[r] = shapes.composeRecordAt(survivor, depth - 1 - r);
            emit log_named_uint("record index", depth - 1 - r);
            emit log_named_uint("  survivor denom", recs[r].survivorDenominationIndex);
            emit log_named_uint("  survivor origins", recs[r].survivorOriginCount);
            emit log_named_uint("  survivor gene", recs[r].survivorInkGene);
            emit log_named_uint("  survivor modules len", recs[r].survivorModules.length);
            emit log_named_uint("  input count", recs[r].inputs.length);
            for (uint256 i = 0; i < recs[r].inputs.length; ++i) {
                emit log_named_uint("    input id", recs[r].inputs[i].id);
                emit log_named_uint("    input denom", recs[r].inputs[i].denominationIndex);
                emit log_named_uint("    input origins", recs[r].inputs[i].originCount);
                emit log_named_uint("    input gene", recs[r].inputs[i].inkGene);
                emit log_named_uint("    input modules len", recs[r].inputs[i].modules.length);
            }
        }

        vm.prank(0x0000000000000000000000000000000000004bF0);
        handler.decomposeMany(15841);

        ComposeRecordView memory oldest = recs[reps - 1];
        ShapeState memory st = shapes.shapeState(survivor);
        assertEq(st.denominationIndex, oldest.survivorDenominationIndex, "survivor denom");
        assertEq(st.originCount, oldest.survivorOriginCount, "survivor origins");
        assertEq(st.inkGene, oldest.survivorInkGene, "survivor gene");
        assertEq(st.modules, oldest.survivorModules, "survivor modules");

        for (uint256 r = 0; r < reps; ++r) {
            for (uint256 i = 0; i < recs[r].inputs.length; ++i) {
                uint256 id = recs[r].inputs[i].id;
                ShapeState memory ist = shapes.shapeState(id);
                assertEq(ist.seed, recs[r].inputs[i].seed, "input seed");
                assertEq(ist.denominationIndex, recs[r].inputs[i].denominationIndex, "input denom");
                assertEq(ist.originCount, recs[r].inputs[i].originCount, "input origins");
                assertEq(ist.inkGene, recs[r].inputs[i].inkGene, "input gene");
                assertEq(ist.modules, recs[r].inputs[i].modules, "input modules");
                assertFalse(ist.isBlack, "input black");
            }
        }
        emit log_named_string("contract matches its own record", "yes");
        emit log_named_string("handler ghost mismatch", handler.restoreMismatch() ? "yes" : "no");
    }

    /// @dev The same two records, unwound one call at a time through `decompose` instead of one
    ///      `decomposeMany`. The contract does the same work either way; only the moment the
    ///      handler's check runs differs.
    function test_Diagnose_SameRecordsUnwoundOneCallAtATime() public {
        _replay(16);

        uint256 n = handler.liveTokenCount();
        uint256 survivor = handler.liveTokens(15841 % n);
        assertEq(shapes.composeDepth(survivor), 2, "the survivor carries two stacked records");

        uint256 index = type(uint256).max;
        for (uint256 i = 0; i < n; ++i) {
            if (handler.liveTokens(i) == survivor) index = i;
        }
        assertLt(index, n, "survivor not found in the handler's live set");

        handler.decompose(index);
        assertFalse(handler.restoreMismatch(), "first single decompose flagged");
        assertEq(shapes.composeDepth(survivor), 1);

        uint256 n2 = handler.liveTokenCount();
        uint256 index2 = type(uint256).max;
        for (uint256 i = 0; i < n2; ++i) {
            if (handler.liveTokens(i) == survivor) index2 = i;
        }
        handler.decompose(index2);
        assertEq(shapes.composeDepth(survivor), 0);
        assertFalse(
            handler.restoreMismatch(), "two single decomposes flagged, so the contract really did not restore"
        );
    }
}

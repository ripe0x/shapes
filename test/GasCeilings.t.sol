// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapesBase} from "./Shapes.t.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";

/// @notice Reproducible mainnet-ceiling measurements for the value-moving API.
/// @dev `foundry.toml` deliberately gives tests an inflated limit. The 30M checks below model
///      one Ethereum L1 block; their purpose is to distinguish a single unbounded operation from
///      the legal, bounded rung-by-rung route.
contract GasCeilingsTest is ShapesBase {
    uint256 internal constant MAINNET_BLOCK_GAS = 30_000_000;

    function _ratio(uint256 index) internal pure returns (uint256) {
        return index % 2 == 0 ? 5 : 2;
    }

    function _mintBatch(uint256 denomIndex, uint256 quantity) internal returns (uint256 first) {
        uint256 amount = DENOMS[denomIndex];
        vm.prank(alice);
        first = shapes.mintBatch{value: quantity * (amount + feeOf(amount))}(amount, quantity);
    }

    function _composeOneRung(uint256 oldIndex) internal returns (uint256 survivor) {
        uint256 count = _ratio(oldIndex);
        uint256 first = _mintBatch(oldIndex, count);
        uint256[] memory burns = new uint256[](count - 1);
        for (uint256 i = 0; i < burns.length; ++i) {
            burns[i] = first + i + 1;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burns);
    }

    function _measureComposeAndDecomposeRung(uint256 oldIndex) internal {
        uint256 count = _ratio(oldIndex);
        uint256 first = _mintBatch(oldIndex, count);
        uint256[] memory burns = new uint256[](count - 1);
        for (uint256 i = 0; i < burns.length; ++i) {
            burns[i] = first + i + 1;
        }

        vm.prank(alice);
        uint256 before = gasleft();
        shapes.compose(first, burns);
        emit log_named_uint("compose rung gas", before - gasleft());

        vm.prank(alice);
        before = gasleft();
        shapes.decompose(first);
        emit log_named_uint("decompose rung gas", before - gasleft());
    }

    function test_Measure_MintAndRedeemEntrypoints() public {
        uint256 amount = DENOMS[0];
        uint256 before;

        vm.prank(alice);
        before = gasleft();
        uint256 direct = shapes.mint{value: amount + feeOf(amount)}(amount);
        emit log_named_uint("mint(0.01) gas", before - gasleft());

        vm.prank(alice);
        before = gasleft();
        shapes.redeem(direct);
        emit log_named_uint("redeem gas", before - gasleft());

        vm.prank(alice);
        before = gasleft();
        uint256 toId = shapes.mintTo{value: amount + feeOf(amount)}(amount, bob);
        emit log_named_uint("mintTo gas", before - gasleft());
        vm.prank(bob);
        before = gasleft();
        shapes.redeemTo(toId, payable(bob));
        emit log_named_uint("redeemTo gas", before - gasleft());

        vm.prank(alice);
        before = gasleft();
        uint256 first = shapes.mintBatch{value: 10 * (amount + feeOf(amount))}(amount, 10);
        emit log_named_uint("mintBatch(10) gas", before - gasleft());
        uint256[] memory ids = new uint256[](10);
        for (uint256 i = 0; i < ids.length; ++i) {
            ids[i] = first + i;
        }
        vm.prank(alice);
        before = gasleft();
        shapes.redeemBatch(ids);
        emit log_named_uint("redeemBatch(10) gas", before - gasleft());

        vm.prank(alice);
        before = gasleft();
        uint256 toFirst = shapes.mintBatchTo{value: 10 * (amount + feeOf(amount))}(amount, 10, bob);
        emit log_named_uint("mintBatchTo(10) gas", before - gasleft());
        for (uint256 i = 0; i < ids.length; ++i) {
            ids[i] = toFirst + i;
        }
        vm.prank(bob);
        before = gasleft();
        shapes.redeemBatchTo(ids, payable(bob));
        emit log_named_uint("redeemBatchTo(10) gas", before - gasleft());
    }

    /// @dev One legal composition at every ladder rung. The largest call burns four inputs;
    ///      10,000 dust origins therefore need 3,333 such calls, never one 9,999-input call.
    function test_Measure_BoundedComposeAndDecomposeAtEveryRung() public {
        for (uint256 oldIndex = 0; oldIndex < 8; ++oldIndex) {
            emit log_named_uint("rung old denomination index", oldIndex);
            _measureComposeAndDecomposeRung(oldIndex);
        }
    }

    function test_Measure_ComposeManyAndDecomposeMany() public {
        uint256 first = _mintBatch(0, 50);
        IShapes.ComposeCall[] memory calls = new IShapes.ComposeCall[](10);
        for (uint256 i = 0; i < calls.length; ++i) {
            uint256[] memory burns = new uint256[](4);
            uint256 start = first + 5 * i;
            for (uint256 j = 0; j < burns.length; ++j) {
                burns[j] = start + j + 1;
            }
            calls[i] = IShapes.ComposeCall({survivorId: start, burnIds: burns});
        }
        vm.prank(alice);
        uint256 before = gasleft();
        uint256[] memory survivors = shapes.composeMany(calls);
        emit log_named_uint("composeMany(10 x 5-to-1) gas", before - gasleft());

        vm.prank(alice);
        before = gasleft();
        shapes.decomposeMany(survivors);
        emit log_named_uint("decomposeMany(10 x 5-to-1) gas", before - gasleft());
    }

    /// @notice Builds a 10,000-origin apex through 3,333 legal, bounded compositions.
    /// @dev The per-rung measurements establish the worst individual call at 985,826 gas. This
    ///      test establishes that the exact tree reaches an apex Complete without relying on the
    ///      infeasible 9,999-input shortcut. `composeMany` may batch multiple tree calls, but the
    ///      tree's 3,333 call count is not a claim about a minimum transaction count.
    function test_Tiered10000DustApexUses3333BoundedComposes() public {
        uint256 first = _mintBatch(0, 10_000);
        uint256[] memory current = new uint256[](10_000);
        for (uint256 i = 0; i < current.length; ++i) {
            current[i] = first + i;
        }

        uint256 calls;
        for (uint256 oldIndex = 0; oldIndex < 8; ++oldIndex) {
            uint256 ratio = _ratio(oldIndex);
            uint256[] memory next = new uint256[](current.length / ratio);
            for (uint256 group = 0; group < next.length; ++group) {
                uint256 offset = group * ratio;
                uint256[] memory burns = new uint256[](ratio - 1);
                for (uint256 j = 0; j < burns.length; ++j) {
                    burns[j] = current[offset + j + 1];
                }
                vm.prank(alice);
                next[group] = shapes.compose(current[offset], burns);
                calls++;
            }
            current = next;
        }

        assertEq(calls, 3_333, "ladder operation count");
        assertEq(current.length, 1, "one apex survivor");
        assertEq(shapes.backingOf(current[0]), DENOMS[8], "apex backing");
        assertEq(shapes.originCountOf(current[0]), 10_000, "all dust origins survive");
        assertTrue(shapes.isComplete(current[0]), "apex is Complete");
    }

    function _measureSplit(uint256 parentDenom, uint256 children) internal {
        uint256 parent = _mint(alice, DENOMS[parentDenom]);
        uint8[] memory outs = new uint8[](children);
        vm.prank(alice);
        uint256 before = gasleft();
        shapes.split(parent, outs);
        emit log_named_uint("split-to-dust gas", before - gasleft());
    }

    /// @notice Preserved from `origin/preserve/split-gas-measure`, plus the 1,000-child point.
    function test_Measure_SplitWidth() public {
        _measureSplit(2, 10); // 0.1 -> 10 x 0.01
        _measureSplit(4, 100); // 1 -> 100 x 0.01
        _measureSplit(5, 500); // 5 -> 500 x 0.01
        _measureSplit(6, 1_000); // 10 -> 1,000 x 0.01
    }

    /// @notice A valid direct 10,000-child split cannot fit in the 30M-gas L1 ceiling.
    /// @dev Low-level call retains the test process after out-of-gas so this is an executable
    ///      ceiling check instead of an extrapolation.
    function test_Direct10000DustSplitExceeds30MGas() public {
        uint256 parent = _mint(alice, DENOMS[8]);
        uint8[] memory outs = new uint8[](10_000);
        vm.prank(alice);
        (bool ok,) =
            address(shapes).call{gas: MAINNET_BLOCK_GAS}(abi.encodeCall(shapes.split, (parent, outs)));
        assertFalse(ok, "direct 10,000-child split unexpectedly fit in 30M gas");
    }

    /// @notice The inverse is also not atomically usable after a 9,999-input compose.
    /// @dev The follow-on sacrifice measures its public entrypoint with a genuine apex Complete.
    function test_Direct10000InputDecomposeExceeds30MGas_AndMeasuresSacrifice() public {
        uint256 first = _mintBatch(0, 10_000);
        uint256[] memory burns = new uint256[](9_999);
        for (uint256 i = 0; i < burns.length; ++i) {
            burns[i] = first + i + 1;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burns);

        vm.prank(alice);
        (bool ok,) =
            address(shapes).call{gas: MAINNET_BLOCK_GAS}(abi.encodeCall(shapes.decompose, (survivor)));
        assertFalse(ok, "direct 10,000-input decompose unexpectedly fit in 30M gas");

        vm.prank(alice);
        uint256 before = gasleft();
        shapes.sacrifice(survivor);
        emit log_named_uint("sacrifice(apex Complete) gas", before - gasleft());
    }

    function test_Measure_SplitTo() public {
        uint256 parent = _mint(alice, DENOMS[1]);
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256 before = gasleft();
        shapes.splitTo(parent, outs, bob);
        emit log_named_uint("splitTo(5 children) gas", before - gasleft());
    }
}

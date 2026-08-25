// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapesBase} from "./Shapes.t.sol";

/// @notice Measures split gas at several child counts so the cost of the full-width child index
///         can be compared against the uint8 form it replaced.
contract SplitGasMeasureTest is ShapesBase {
    function _splitInto(uint256 parentDenom, uint8 childDenom, uint256 k) internal returns (uint256) {
        uint256 parent = _mint(alice, DENOMS[parentDenom]);
        uint8[] memory outs = new uint8[](k);
        for (uint256 i = 0; i < k; ++i) {
            outs[i] = childDenom;
        }
        vm.prank(alice);
        uint256 g = gasleft();
        shapes.split(parent, outs);
        return g - gasleft();
    }

    function test_Measure_Split_10() public {
        emit log_named_uint("split 10 children  gas", _splitInto(2, 0, 10));
    }

    function test_Measure_Split_100() public {
        emit log_named_uint("split 100 children gas", _splitInto(4, 0, 100));
    }

    function test_Measure_Split_500() public {
        emit log_named_uint("split 500 children gas", _splitInto(5, 0, 500));
    }
}

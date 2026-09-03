// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapesBase} from "./Shapes.t.sol";

/// @notice Small, bounded symbolic spike for D-09. `check_` is ignored by Forge and run by Halmos.
contract HalmosReserveTest is ShapesBase {
    function check_MintThenRedeemRestoresExactReserve(uint8 denominationIndex) public {
        vm.assume(denominationIndex < 9);
        uint256 amount = DENOMS[denominationIndex];
        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 balanceBefore = address(shapes).balance;

        uint256 fee = feeOf(amount);
        vm.prank(alice);
        uint256 id = shapes.mint{value: amount + fee}(amount);
        assertEq(shapes.redeemableBacking(), reserveBefore + amount);
        assertEq(address(shapes).balance, balanceBefore + amount + fee);

        vm.prank(alice);
        shapes.redeem(id);
        assertEq(shapes.redeemableBacking(), reserveBefore);
        assertEq(address(shapes).balance, balanceBefore + fee);
    }
}

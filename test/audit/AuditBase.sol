// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapesBase} from "../Shapes.t.sol";

/// @notice Shared harness for the independent audit's adversarial attempts. Keeps Shape #0 alive,
///         because the owner token is one of the assets the attempts target.
abstract contract AuditBase is ShapesBase {
    function _keepGenesisShape() internal pure override returns (bool) {
        return true;
    }

    /// @dev Mint `k` tokens of `amountWei` to `who` in one batch and return the first id.
    function _mintBatchTo(address who, uint256 amountWei, uint256 k) internal returns (uint256 first) {
        uint256 paid = k * (amountWei + feeOf(amountWei));
        vm.prank(who);
        first = shapes.mintBatch{value: paid}(amountWei, k);
    }

    /// @dev The reserve invariant in its full form.
    function _assertReserveInvariant() internal view {
        assertGe(
            address(shapes).balance,
            shapes.redeemableBacking() + shapes.pendingFees(),
            "balance < redeemableBacking + pendingFees"
        );
    }
}

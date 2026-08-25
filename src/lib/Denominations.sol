// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ladder} from "ladder/Ladder.sol";

/// @title Denominations
/// @notice The nine canonical Shape denominations and the grid each maps to.
/// @dev These are permanent protocol rules. Everything here is a small pure function over a fixed
///      table, so an unsupported amount is unrepresentable rather than merely rejected.
///
///      The backing amounts, their unit, and their labels come from `Ladder`, which the `ladder/`
///      remapping resolves per foundry profile: the default profile selects
///      `ladders/mainnet/Ladder.sol`, and `FOUNDRY_PROFILE=testnet` selects the 100x-smaller
///      `ladders/testnet/Ladder.sol`. Everything in this file is unit-relative and identical under
///      both. The table is mirrored in `preview/src/canonical/denominations.ts` and the two are
///      asserted equal by the parity suite.
library Denominations {
    uint256 internal constant COUNT = 9;

    error UnsupportedDenomination(uint256 amountWei);
    error DenominationIndexOutOfRange(uint256 index);

    /// @notice The minimum denomination, in wei. Every denomination is a whole multiple of it.
    uint256 internal constant UNIT = Ladder.UNIT;

    /// @notice Which ladder was compiled in, "mainnet" or "testnet".
    string internal constant LADDER_NAME = Ladder.NAME;

    /// @notice Backing amount for a denomination index.
    function amountAt(uint256 index) internal pure returns (uint256) {
        return Ladder.amountAt(index);
    }

    /// @notice Backing amount for a denomination index, in UNIT multiples.
    function unitsAt(uint256 index) internal pure returns (uint256) {
        return amountAt(index) / UNIT;
    }

    /// @notice Index of a supported denomination.
    /// @return index The denomination index, meaningful only when `ok` is true.
    /// @return ok Whether `amountWei` is one of the nine supported amounts.
    function indexOf(uint256 amountWei) internal pure returns (uint256 index, bool ok) {
        return Ladder.indexOf(amountWei);
    }

    function isSupported(uint256 amountWei) internal pure returns (bool ok) {
        (, ok) = indexOf(amountWei);
    }

    /// @notice Index of a supported denomination, reverting when unsupported.
    function requireIndexOf(uint256 amountWei) internal pure returns (uint256 index) {
        bool ok;
        (index, ok) = indexOf(amountWei);
        if (!ok) revert UnsupportedDenomination(amountWei);
    }

    /// @notice Grid for a denomination index. Higher value, fewer modules.
    function gridAt(uint256 index) internal pure returns (uint256 cols, uint256 rows) {
        if (index == 0) return (5, 5); // 25 modules
        if (index == 1) return (4, 5); // 20
        if (index == 2) return (4, 4); // 16
        if (index == 3) return (3, 4); // 12
        if (index == 4) return (3, 3); //  9
        if (index == 5) return (2, 3); //  6
        if (index == 6) return (2, 2); //  4
        if (index == 7) return (1, 2); //  2
        if (index == 8) return (1, 1); //  1
        revert DenominationIndexOutOfRange(index);
    }

    /// @notice Display string for a denomination index. No trailing zeros, by construction.
    function labelAt(uint256 index) internal pure returns (string memory) {
        return Ladder.labelAt(index);
    }
}

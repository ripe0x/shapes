// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Denominations
/// @notice The nine canonical Shape denominations and the grid each maps to.
/// @dev These are permanent protocol rules. The table is duplicated in
///      `preview/src/canonical/denominations.ts` and the two are asserted equal by the
///      parity suite. Everything here is a small pure function over a fixed table, so an
///      unsupported amount is unrepresentable rather than merely rejected.
///
///      TESTNET SCALE (sepolia-scaled branch): the ladder is scaled down 100x from the mainnet
///      values so the whole system, up to the apex, is exercisable with faucet ETH — top is 1 ETH,
///      not 100. Unit-relative logic (unit counts, density, formation, grids, compose math) is
///      unchanged; only the absolute wei and labels differ. RESTORE the mainnet ladder (0.01..100,
///      UNIT = 0.01 ether) before any mainnet deploy. Keep in lockstep with denominations.ts and
///      the site DENOMINATIONS.
library Denominations {
    uint256 internal constant COUNT = 9;

    error UnsupportedDenomination(uint256 amountWei);
    error DenominationIndexOutOfRange(uint256 index);

    /// @notice The minimum denomination, in wei. Every denomination is a whole multiple of it.
    uint256 internal constant UNIT = 0.0001 ether;

    /// @notice Backing amount for a denomination index.
    function amountAt(uint256 index) internal pure returns (uint256) {
        if (index == 0) return 0.0001 ether;
        if (index == 1) return 0.0005 ether;
        if (index == 2) return 0.001 ether;
        if (index == 3) return 0.005 ether;
        if (index == 4) return 0.01 ether;
        if (index == 5) return 0.05 ether;
        if (index == 6) return 0.1 ether;
        if (index == 7) return 0.5 ether;
        if (index == 8) return 1 ether;
        revert DenominationIndexOutOfRange(index);
    }

    /// @notice Backing amount for a denomination index, in UNIT (0.01 ETH) multiples.
    function unitsAt(uint256 index) internal pure returns (uint256) {
        return amountAt(index) / UNIT;
    }

    /// @notice Index of a supported denomination.
    /// @return index The denomination index, meaningful only when `ok` is true.
    /// @return ok Whether `amountWei` is one of the nine supported amounts.
    function indexOf(uint256 amountWei) internal pure returns (uint256 index, bool ok) {
        if (amountWei == 0.0001 ether) return (0, true);
        if (amountWei == 0.0005 ether) return (1, true);
        if (amountWei == 0.001 ether) return (2, true);
        if (amountWei == 0.005 ether) return (3, true);
        if (amountWei == 0.01 ether) return (4, true);
        if (amountWei == 0.05 ether) return (5, true);
        if (amountWei == 0.1 ether) return (6, true);
        if (amountWei == 0.5 ether) return (7, true);
        if (amountWei == 1 ether) return (8, true);
        return (0, false);
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
        if (index == 0) return "0.0001";
        if (index == 1) return "0.0005";
        if (index == 2) return "0.001";
        if (index == 3) return "0.005";
        if (index == 4) return "0.01";
        if (index == 5) return "0.05";
        if (index == 6) return "0.1";
        if (index == 7) return "0.5";
        if (index == 8) return "1";
        revert DenominationIndexOutOfRange(index);
    }
}

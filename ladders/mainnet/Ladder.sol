// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Ladder (mainnet)
/// @notice The nine backing amounts, their unit, and their display strings.
/// @dev Selected by the `ladder/` remapping, which the default foundry profile points here. The
///      testnet variant at `ladders/testnet/Ladder.sol` scales every amount down by 100 and is
///      selected by `FOUNDRY_PROFILE=testnet`. Only this table varies between the two: unit counts,
///      grids, density, formation, and compose math are all unit-relative and live in
///      `src/lib/Denominations.sol`. `test/Ladder.t.sol` asserts the default profile carries these
///      values, so a testnet table left here fails the suite rather than reaching a deploy.
library Ladder {
    error DenominationIndexOutOfRange(uint256 index);

    /// @notice Identifies which ladder was compiled in. Names the matching parity fixture file.
    string internal constant NAME = "mainnet";

    /// @notice The minimum denomination, in wei. Every denomination is a whole multiple of it.
    uint256 internal constant UNIT = 0.01 ether;

    /// @notice Backing amount for a denomination index.
    function amountAt(uint256 index) internal pure returns (uint256) {
        if (index == 0) return 0.01 ether;
        if (index == 1) return 0.05 ether;
        if (index == 2) return 0.1 ether;
        if (index == 3) return 0.5 ether;
        if (index == 4) return 1 ether;
        if (index == 5) return 5 ether;
        if (index == 6) return 10 ether;
        if (index == 7) return 50 ether;
        if (index == 8) return 100 ether;
        revert DenominationIndexOutOfRange(index);
    }

    /// @notice Index of a supported denomination.
    /// @return index The denomination index, meaningful only when `ok` is true.
    /// @return ok Whether `amountWei` is one of the nine supported amounts.
    function indexOf(uint256 amountWei) internal pure returns (uint256 index, bool ok) {
        if (amountWei == 0.01 ether) return (0, true);
        if (amountWei == 0.05 ether) return (1, true);
        if (amountWei == 0.1 ether) return (2, true);
        if (amountWei == 0.5 ether) return (3, true);
        if (amountWei == 1 ether) return (4, true);
        if (amountWei == 5 ether) return (5, true);
        if (amountWei == 10 ether) return (6, true);
        if (amountWei == 50 ether) return (7, true);
        if (amountWei == 100 ether) return (8, true);
        return (0, false);
    }

    /// @notice Display string for a denomination index. No trailing zeros, by construction.
    function labelAt(uint256 index) internal pure returns (string memory) {
        if (index == 0) return "0.01";
        if (index == 1) return "0.05";
        if (index == 2) return "0.1";
        if (index == 3) return "0.5";
        if (index == 4) return "1";
        if (index == 5) return "5";
        if (index == 6) return "10";
        if (index == 7) return "50";
        if (index == 8) return "100";
        revert DenominationIndexOutOfRange(index);
    }
}

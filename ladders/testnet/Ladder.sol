// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Ladder (testnet)
/// @notice The nine backing amounts, their unit, and their display strings, scaled down 100x.
/// @dev Selected by `FOUNDRY_PROFILE=testnet`, which points the `ladder/` remapping here. The
///      scale puts the apex within reach of faucet ETH, so the whole system is exercisable on a
///      public testnet. Only this table differs from `ladders/mainnet/Ladder.sol`: unit counts,
///      grids, density, formation, and compose math are unit-relative and shared.
library Ladder {
    error DenominationIndexOutOfRange(uint256 index);

    /// @notice Identifies which ladder was compiled in. Names the matching parity fixture file.
    string internal constant NAME = "testnet";

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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IContractTitle
/// @notice A collectible title to a contract, separate from administrative control.
/// @dev The title is the holder of Shape #0. It carries no permissions and may be zero while
///      Shape #0 is burned. ERC-721 Transfer events for token #0 are the title-transfer signal.
interface IContractTitle {
    function titleHolder() external view returns (address);
}

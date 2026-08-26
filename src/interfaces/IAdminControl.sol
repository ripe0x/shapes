// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAdminControl
/// @notice Explicit temporary administration, separate from the collectible contract title.
/// @dev The admin may configure only the value-inert surfaces documented by `Shapes`. The
///      title holder returned by `titleHolder()` receives none of these permissions.
interface IAdminControl {
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error AdminUnauthorizedAccount(address account);
    error AdminInvalidAdmin(address admin);

    function admin() external view returns (address);

    function transferAdmin(address newAdmin) external;

    function renounceAdmin() external;
}

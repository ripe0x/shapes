// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAdminControl
/// @notice Explicit temporary administration, separate from collectible contract ownership.
/// @dev The admin may configure presentation/discovery and redirect future mint fees. It cannot
///      change the fee rate or reach backing, redemption, token ownership or accrued funds. The
///      contract owner returned by `owner()` receives none of these permissions.
interface IAdminControl {
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    error AdminUnauthorizedAccount(address account);
    error AdminInvalidAdmin(address admin);
    error AdminInvalidFeeRecipient(address recipient);

    function admin() external view returns (address);

    function transferAdmin(address newAdmin) external;

    function renounceAdmin() external;

    /// @notice Redirect future mint fees. Already-paid fees and the reserve are unaffected.
    function setFeeRecipient(address newRecipient) external;
}

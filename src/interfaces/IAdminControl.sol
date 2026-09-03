// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAdminControl
/// @notice Explicit temporary administration, separate from collectible contract ownership.
/// @dev The admin may configure presentation, positions and market pointers, redirect future
///      mint fees, and adjust the mint fee amount within a compile-time cap. It cannot reach
///      backing, redemption, token ownership or accrued fees. The contract owner returned by
///      `owner()` receives none of these permissions.
interface IAdminControl {
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    /// @notice Emitted when the admin changes the mint fee.
    event MintFeeUpdated(uint256 previousFee, uint256 newFee);

    error AdminUnauthorizedAccount(address account);
    error AdminInvalidAdmin(address admin);
    error AdminInvalidFeeRecipient(address recipient);

    /// @notice Address allowed to perform administrative actions.
    /// @dev Independent of `owner()` and of ownership of any Shape.
    function admin() external view returns (address);

    function transferAdmin(address newAdmin) external;

    function renounceAdmin() external;

    /// @notice Redirect future mint fees. Already-accrued fees and the reserve are unaffected.
    function setFeeRecipient(address newRecipient) external;

    /// @notice Change the flat per-Shape mint fee. Takes effect for every later mint and for the
    ///         auction house's ETH-bid card minting, which reads the fee live. Reverts above the
    ///         cap, one denomination unit (`IShapes.unit`).
    function setMintFee(uint256 newFee) external;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IContractCollector
/// @notice Deferred binding of a contract to one ERC-721 token whose current owner is the
///         contract's collector.
/// @dev Provisional local interface. Not advertised through ERC-165. The collector relationship is
///      provenance only: implementers grant the collector no permissions.
///
///      Carries the state-owning surface only: the two mutators and one raw getter combining the
///      token pointer and lock state. The friendly read surface (separate getters, and current
///      owner resolution) is periphery-side; see `IShapeLens.contractCollectorToken`,
///      `IShapeLens.contractCollector` and `IShapeLens.contractCollectorBindingLocked`.
interface IContractCollector {
    /// @notice Emitted when the collector token pointer is set or replaced.
    event ContractCollectorTokenSet(
        address indexed previousTokenContract,
        uint256 previousTokenId,
        address indexed tokenContract,
        uint256 tokenId
    );

    /// @notice Emitted once, when the binding is locked.
    event ContractCollectorBindingLocked(address indexed tokenContract, uint256 indexed tokenId);

    /// @dev `setContractCollectorToken` and `lockContractCollectorBinding` revert once locked.
    error ContractCollectorBindingIsLocked();
    /// @dev The candidate token failed validation: no code at `tokenContract` (which is also what
    ///      an unset binding reads as, so `lockContractCollectorBinding` before any token is
    ///      configured lands here too), or `ownerOf(tokenId)` reverted, ran out of the capped gas,
    ///      returned malformed data, or resolved to the zero address.
    error InvalidContractCollectorToken(address tokenContract, uint256 tokenId);

    /// @notice The configured collector binding: token pointer and lock state in one read.
    ///         `(address(0), 0, false)` until set.
    function contractCollectorBinding()
        external
        view
        returns (address tokenContract, uint256 tokenId, bool locked);

    /// @notice Set or replace the collector token. Owner only, and only while unlocked.
    /// @dev Validates at call time: a gas-capped `ownerOf(tokenId)` read against `tokenContract`
    ///      must resolve to a nonzero address. This is a sanity check, not an ERC-721 conformance
    ///      check: it accepts any contract whose `ownerOf(uint256)` returns a nonzero address, and
    ///      it does not establish that the token is immutable, unburnable, non-upgradeable, or
    ///      free of administrative recovery. The issuer must evaluate the token contract's mint,
    ///      burn, upgrade, recovery and transfer behaviour before locking. Does not lock.
    function setContractCollectorToken(address tokenContract, uint256 tokenId) external;

    /// @notice Lock the collector token pointer permanently. Owner only.
    /// @dev Reverts when already locked. Revalidates that `ownerOf(tokenId)` currently resolves
    ///      to a nonzero owner, which also rejects locking before any token is configured (an
    ///      unset `tokenContract` is the zero address, which has no code). Locks only this
    ///      contract's pointer; the ERC-721 itself remains transferable under its own rules.
    ///      There is no unlock, reset, clear, or override.
    function lockContractCollectorBinding() external;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IContractCollector} from "../interfaces/IContractCollector.sol";

/// @title ContractCollectorOps
/// @notice State-mutating logic for `IContractCollector`, operating directly on the caller's
///         storage.
/// @dev Every function is `public` and `setToken`/`lock` take `Binding storage`, so calls execute
///      via `DELEGATECALL` into this library rather than being inlined: `Shapes` carries only the
///      thin `onlyOwner` wrapper functions in its own runtime bytecode, keeping it under the
///      EIP-170 limit. Under `DELEGATECALL`, `msg.sender` and the executing address stay the
///      caller's, so events emitted here are attributed to `Shapes` and writes to `b` land in
///      `Shapes`'s own storage slot; there is no separate state in this library.
library ContractCollectorOps {
    struct Binding {
        address tokenContract;
        uint256 tokenId;
        bool locked;
    }

    /// @dev Gas forwarded to the token contract's `ownerOf` read. Bounds a hostile token
    ///      contract's ability to consume the caller's stipend.
    uint256 internal constant OWNER_GAS_CAP = 100_000;

    /// @notice Set or replace the collector token. Reverts if `b.locked`, or if `ownerOf(tokenId)`
    ///         on `tokenContract` does not resolve to a nonzero address.
    function setToken(Binding storage b, address tokenContract, uint256 tokenId) public {
        if (b.locked) revert IContractCollector.ContractCollectorBindingIsLocked();
        if (ownerOfCapped(tokenContract, tokenId) == address(0)) {
            revert IContractCollector.InvalidContractCollectorToken(tokenContract, tokenId);
        }

        address previousTokenContract = b.tokenContract;
        uint256 previousTokenId = b.tokenId;
        b.tokenContract = tokenContract;
        b.tokenId = tokenId;

        emit IContractCollector.ContractCollectorTokenSet(
            previousTokenContract, previousTokenId, tokenContract, tokenId
        );
    }

    /// @notice Permanently lock `b`. Reverts if already locked, or if the configured token's
    ///         `ownerOf` no longer resolves. An unset binding reads as the zero address with no
    ///         code, which also reverts here.
    function lock(Binding storage b) public {
        if (b.locked) revert IContractCollector.ContractCollectorBindingIsLocked();
        address tokenContract = b.tokenContract;
        uint256 tokenId = b.tokenId;
        if (ownerOfCapped(tokenContract, tokenId) == address(0)) {
            revert IContractCollector.InvalidContractCollectorToken(tokenContract, tokenId);
        }

        b.locked = true;
        emit IContractCollector.ContractCollectorBindingLocked(tokenContract, tokenId);
    }

    /// @notice `IERC721(tokenContract).ownerOf(tokenId)` as a gas-capped staticcall. Zero on
    ///         revert, out-of-gas, or malformed return data, including a call to a target with no
    ///         code (which succeeds trivially with empty returndata).
    /// @dev A low-level call rather than try/catch so that a missing-code or bad-ABI failure lands
    ///      here instead of reverting the caller. The token contract is untrusted; its only power
    ///      over this read path is the address it returns.
    function ownerOfCapped(address tokenContract, uint256 tokenId) public view returns (address) {
        (bool ok, bytes memory data) = tokenContract.staticcall{gas: OWNER_GAS_CAP}(
            abi.encodeWithSelector(IERC721.ownerOf.selector, tokenId)
        );
        if (!ok || data.length != 32) return address(0);
        // Reject dirty upper bits rather than silently truncating to an address.
        uint256 raw = abi.decode(data, (uint256));
        if (raw > type(uint160).max) return address(0);
        return address(uint160(raw));
    }
}

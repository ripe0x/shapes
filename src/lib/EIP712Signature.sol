// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title EIP712Signature
/// @notice Stateless helpers for deployment-bound EIP-712 digests and EOA/ERC-1271 verification.
/// @dev Externally linked so contracts can store their own attestations without duplicating
///      cryptography code in size-constrained runtimes.
library EIP712Signature {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ATTRIBUTION_TYPEHASH =
        keccak256("ArtistAttribution(address shapes,address artist,bytes32 releaseHash)");
    bytes32 private constant ATTRIBUTION_NAME_HASH = keccak256("Shapes Artist Attribution");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @notice Build the Shapes artist digest, bound to the calling contract and current chain.
    function artistDigest(address artist, bytes32 releaseHash) external view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, ATTRIBUTION_NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(abi.encode(ATTRIBUTION_TYPEHASH, address(this), artist, releaseHash));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    /// @notice Check canonical ECDSA first, then ERC-1271 for contract wallets.
    /// @dev ECDSA-first keeps a delegated EIP-7702 EOA usable while its address has code.
    function isValidNow(address signer, bytes32 digest_, bytes calldata signature)
        external
        view
        returns (bool)
    {
        (address recovered,,) = ECDSA.tryRecoverCalldata(digest_, signature);
        return recovered == signer || SignatureChecker.isValidSignatureNow(signer, digest_, signature);
    }
}

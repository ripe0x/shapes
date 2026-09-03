// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {IAdminControl} from "../interfaces/IAdminControl.sol";
import {IShapes} from "../interfaces/IShapes.sol";
import {CopyValidation} from "./CopyValidation.sol";
import {Denominations} from "./Denominations.sol";
import {EIP712Signature} from "./EIP712Signature.sol";

/// @title AdminOps
/// @notice Cold-path bodies for Shapes' artist attestation, metadata copy and fee configuration.
/// @dev Public library called through DELEGATECALL, so storage stays in Shapes and events are
///      emitted from Shapes' context. Keeping these mutators out of the token's runtime preserves
///      EIP-170 headroom. Each caller in Shapes runs its own access check (`onlyAdmin`, or none
///      for `attestArtist`, which is permissionless) before delegating here; this library performs
///      no authorization of its own. Every mutator here takes a struct storage pointer and writes
///      through it directly, the same pattern `PointerOps` uses; each struct groups only the
///      fields that function moves, nothing else. A bare `string`/`bytes` storage-pointer
///      parameter cannot be fully reassigned from calldata or memory, since solc's copy codegen
///      does not support that for a standalone reference-type parameter. That is why these fields
///      are grouped into structs rather than passed individually; assigning through a struct
///      member reached via the pointer works because a struct is what the storage-location
///      restriction is designed for.
library AdminOps {
    /// @dev Mint fee and fee recipient, grouped only so `setFeeRecipient`/`setMintFee` below can
    ///      take one storage pointer. `pendingFees` and every other accounting field stay on
    ///      `Shapes` directly.
    struct FeeConfig {
        uint256 mintFee;
        address feeRecipient;
    }

    /// @dev The artist's release hash and EIP-712 signature, grouped so `attestArtist` below can
    ///      mutate both through one storage pointer.
    struct ArtistAttestation {
        bytes32 releaseHash;
        bytes signature;
    }

    /// @dev The token name prefix and shared description, grouped so `setMetadataCopy` below can
    ///      mutate both through one storage pointer.
    struct CopyConfig {
        string tokenNamePrefix;
        string description;
    }

    /// @dev Longest a name or name prefix may be, in bytes.
    uint256 internal constant MAX_NAME_BYTES = 64;
    /// @dev Longest a description may be, in bytes.
    uint256 internal constant MAX_DESCRIPTION_BYTES = 2048;
    /// @dev Cap on the mint fee, equal to `unit()`. Enforced here and by Shapes' constructor.
    uint256 internal constant MAX_MINT_FEE = Denominations.UNIT;

    /// @dev Body of `Shapes.attestArtist`.
    function attestArtist(
        ArtistAttestation storage attestation,
        address artist_,
        bytes32 releaseHash,
        bytes calldata signature_
    ) public {
        if (attestation.releaseHash != bytes32(0)) {
            revert IShapes.ArtistAlreadyAttested();
        }
        if (releaseHash == bytes32(0)) revert IShapes.InvalidArtistReleaseHash();
        bytes32 digest = EIP712Signature.artistDigest(artist_, releaseHash);
        if (!EIP712Signature.isValidNow(artist_, digest, signature_)) {
            revert IShapes.InvalidArtistSignature();
        }

        attestation.releaseHash = releaseHash;
        attestation.signature = signature_;
        emit IShapes.ArtistAttested(artist_, releaseHash, signature_);
    }

    /// @dev Body of `Shapes.setMetadataCopy`.
    function setMetadataCopy(
        CopyConfig storage copy,
        string calldata newTokenNamePrefix,
        string calldata newDescription,
        uint256 totalMinted
    ) public {
        CopyValidation.requireJsonSafe(newTokenNamePrefix, MAX_NAME_BYTES, 0);
        CopyValidation.requireJsonSafe(newDescription, MAX_DESCRIPTION_BYTES, 1);
        copy.tokenNamePrefix = newTokenNamePrefix;
        copy.description = newDescription;
        if (totalMinted != 0) emit IERC4906.BatchMetadataUpdate(0, totalMinted - 1);
        emit IShapes.ContractURIUpdated();
    }

    /// @dev Body of `Shapes.setFeeRecipient`.
    function setFeeRecipient(FeeConfig storage fees, address newRecipient) public {
        if (newRecipient == address(0)) revert IAdminControl.AdminInvalidFeeRecipient(address(0));
        address previousRecipient = fees.feeRecipient;
        fees.feeRecipient = newRecipient;
        emit IAdminControl.FeeRecipientUpdated(previousRecipient, newRecipient);
    }

    /// @dev Body of `Shapes.setMintFee`.
    function setMintFee(FeeConfig storage fees, uint256 newFee) public {
        if (newFee > MAX_MINT_FEE) revert IShapes.MintFeeAboveCap(newFee);
        uint256 previousFee = fees.mintFee;
        fees.mintFee = newFee;
        emit IAdminControl.MintFeeUpdated(previousFee, newFee);
    }
}

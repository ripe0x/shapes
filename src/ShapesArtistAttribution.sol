// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ShapesArtistAttribution
/// @notice Permanent creator attribution and one-time cryptographic approval for one Shapes deployment.
/// @dev Created by `Shapes` in its constructor. This contract has no administrative powers, fee rights,
///      ownership rights or other authority over Shapes. Anyone may relay the artist's signature.
contract ShapesArtistAttribution is EIP712 {
    /// @notice The exact Shapes deployment this attribution belongs to.
    address public immutable shapes;

    /// @notice The permanently attributed artist.
    address public immutable artist;

    /// @notice The release or artifact hash approved by the artist.
    /// @dev Zero until the one-time attestation is submitted.
    bytes32 public releaseHash;

    /// @notice The artist's stored EIP-712 signature.
    /// @dev Empty until attested. Once stored, it can never be replaced or removed.
    bytes public signature;

    /// @notice Whether the one permitted attestation has been stored.
    /// @dev Kept separately from `signature.length` because an ERC-1271 wallet may consider an
    ///      empty byte string valid.
    bool public attested;

    bytes32 public constant ATTRIBUTION_TYPEHASH =
        keccak256("ShapesArtistAttribution(address shapes,address artist,bytes32 releaseHash)");

    /// @notice Emitted once when the artist cryptographically approves this deployment and release.
    event ArtistAttested(address indexed artist, bytes32 indexed releaseHash, bytes signature);

    error ArtistAlreadyAttested();
    error InvalidArtistSignature();

    constructor(address artist_) EIP712("Shapes Artist Attribution", "1") {
        shapes = msg.sender;
        artist = artist_;
    }

    /// @notice EIP-712 digest the artist signs for `releaseHash_`.
    /// @dev Binds the chain, this attribution contract, the exact Shapes deployment and the artist.
    function attestationDigest(bytes32 releaseHash_) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ATTRIBUTION_TYPEHASH, shapes, artist, releaseHash_)));
    }

    /// @notice Permanently store the artist's approval of this Shapes deployment and release.
    /// @dev Anyone may relay the signature. Supports EOAs and ERC-1271 contract wallets.
    function attest(bytes32 releaseHash_, bytes calldata signature_) external {
        if (attested) revert ArtistAlreadyAttested();
        bytes32 digest = attestationDigest(releaseHash_);
        (address recovered,,) = ECDSA.tryRecoverCalldata(digest, signature_);

        // Try the artist's ECDSA key even when the address has code. That keeps a deployer EOA
        // able to attest while it carries an EIP-7702 delegation; ordinary contract wallets
        // fall through to ERC-1271.
        if (recovered != artist && !SignatureChecker.isValidSignatureNow(artist, digest, signature_)) {
            revert InvalidArtistSignature();
        }

        attested = true;
        releaseHash = releaseHash_;
        signature = signature_;
        emit ArtistAttested(artist, releaseHash_, signature_);
    }
}

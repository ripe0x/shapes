// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {IAdminControl} from "../interfaces/IAdminControl.sol";
import {IShapeAuctionHouse} from "../interfaces/IShapeAuctionHouse.sol";
import {IShapeCollection} from "../interfaces/IShapeCollection.sol";
import {IShapePositionResolver} from "../interfaces/IShapePositionResolver.sol";
import {IShapeRenderer} from "../interfaces/IShapeRenderer.sol";
import {IShapes} from "../interfaces/IShapes.sol";
import {CopyValidation} from "./CopyValidation.sol";
import {Denominations} from "./Denominations.sol";
import {EIP712Signature} from "./EIP712Signature.sol";

/// @title AdminOps
/// @notice Every configuration write path on `Shapes`: fee, metadata copy, presentation pointers,
///         the two discovery pointers, and the artist attestation.
/// @dev Public library called through `DELEGATECALL`, so storage stays in `Shapes` and events are
///      emitted from `Shapes`'s address. Each function is named after the `Shapes` entrypoint
///      whose body it holds.
///
///      No authorization happens here. Each caller in `Shapes` runs its own check first
///      (`onlyAdmin`, or none for `attestArtist`, which is permissionless by design). Nothing here
///      reaches token state, backing, redemption or the admin address itself: the admin address is
///      written only by `Shapes`, so no library can hand the role to anyone.
///
///      Every mutator takes a struct storage pointer and writes through it, so each reaches only
///      the fields its own function moves. A bare `string`/`bytes` storage-pointer parameter
///      cannot be reassigned from calldata or memory, since solc's copy codegen does not support
///      that for a standalone reference-type parameter; assigning through a struct member reached
///      via the pointer works, which is why these fields are grouped into structs.
library AdminOps {
    /// @dev Mint fee and fee recipient, grouped so `setFeeRecipient` and `setMintFee` take one
    ///      storage pointer. `pendingFees` and every other accounting field stay on `Shapes`.
    struct FeeConfig {
        uint256 mintFee;
        address feeRecipient;
    }

    /// @dev The artist's release hash and EIP-712 signature, grouped so `attestArtist` mutates
    ///      both through one storage pointer.
    struct ArtistAttestation {
        bytes32 releaseHash;
        bytes signature;
    }

    /// @dev The token name prefix and shared description, grouped so `setMetadataCopy` mutates
    ///      both through one storage pointer.
    struct CopyConfig {
        string tokenNamePrefix;
        string description;
    }

    /// @dev The two metadata contracts and the one lock that freezes them. `renderer` is read only
    ///      by `tokenURI`, `collection` only by `contractURI`, so nothing here can affect ETH,
    ///      backing, redemption or ownership. One lock, because presentation is one decision.
    struct Presentation {
        address renderer;
        address collection;
        bool locked;
    }

    /// @dev The two discovery pointers, each with its own permanent lock. No token or reserve
    ///      operation reads them.
    struct Pointers {
        address positions;
        bool positionsLocked;
        address market;
        bool marketLocked;
    }

    /// @dev Longest a name or name prefix may be, in bytes.
    uint256 internal constant MAX_NAME_BYTES = 64;
    /// @dev Longest a description may be, in bytes.
    uint256 internal constant MAX_DESCRIPTION_BYTES = 2048;
    /// @dev Cap on the mint fee, equal to `unit()`. Enforced here and by `Shapes`'s constructor.
    uint256 internal constant MAX_MINT_FEE = Denominations.UNIT;

    /* ---------------------------- presentation ---------------------------- */

    /// @notice Reverts unless `renderer` has code and answers ERC-165 for `IShapeRenderer`.
    /// @dev A zero address has no code, so the length check also rejects it. Shared with
    ///      `Shapes`'s constructor, which validates the same way before any storage is written.
    function requireRenderer(address renderer) internal view {
        if (renderer.code.length == 0 || !_supports(renderer, type(IShapeRenderer).interfaceId)) {
            revert IShapes.UnsupportedRenderer(renderer);
        }
    }

    /// @notice Reverts unless `collection` has code and answers ERC-165 for `IShapeCollection`.
    function requireCollection(address collection) internal view {
        if (collection.code.length == 0 || !_supports(collection, type(IShapeCollection).interfaceId)) {
            revert IShapes.UnsupportedCollection(collection);
        }
    }

    /// @dev Body of `Shapes.setRenderer`. A new renderer changes `tokenURI` for every existing
    ///      token, so ERC-4906 signals the refresh.
    function setRenderer(Presentation storage p, address newRenderer, uint256 totalMinted) public {
        _requireUnlocked(p);
        requireRenderer(newRenderer);
        p.renderer = newRenderer;
        emit IShapes.RendererUpdated(newRenderer);
        if (totalMinted != 0) emit IERC4906.BatchMetadataUpdate(0, totalMinted - 1);
    }

    /// @dev Body of `Shapes.setCollection`.
    function setCollection(Presentation storage p, address newCollection) public {
        _requireUnlocked(p);
        requireCollection(newCollection);
        p.collection = newCollection;
        emit IShapes.CollectionUpdated(newCollection);
    }

    /// @dev Body of `Shapes.lockPresentation`. One way: after this neither the renderer nor the
    ///      collection can change again.
    function lockPresentation(Presentation storage p) public {
        _requireUnlocked(p);
        p.locked = true;
        emit IShapes.PresentationLocked(p.renderer, p.collection);
    }

    function _requireUnlocked(Presentation storage p) private view {
        if (p.locked) revert IShapes.PresentationIsLocked();
    }

    /* -------------------------------- copy -------------------------------- */

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

    /* -------------------------------- fees -------------------------------- */

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

    /* ------------------------------ pointers ------------------------------ */

    /// @dev Body of `Shapes.setPointer`. A nonzero target must answer ERC-165 for the interface
    ///      its reader calls: `IShapePositionResolver` for positions, which `Shapes.positionOf`
    ///      staticcalls, and `IShapeAuctionHouse` for the market, which clients call directly.
    ///      Zero clears the pointer and is always accepted.
    function setPointer(Pointers storage p, uint8 pointer, address target) public {
        if (pointer == uint8(IShapes.Pointer.Positions)) {
            if (p.positionsLocked) revert IShapes.PointerIsLocked();
            _requireTarget(target, type(IShapePositionResolver).interfaceId);
            p.positions = target;
            emit IShapes.PositionsSet(target);
        } else if (pointer == uint8(IShapes.Pointer.Market)) {
            if (p.marketLocked) revert IShapes.PointerIsLocked();
            _requireTarget(target, type(IShapeAuctionHouse).interfaceId);
            p.market = target;
            emit IShapes.MarketSet(target);
        } else {
            revert IShapes.InvalidPointer();
        }
    }

    /// @dev Body of `Shapes.lockPointer`. May lock a pointer at zero, which is permanent.
    function lockPointer(Pointers storage p, uint8 pointer) public {
        if (pointer == uint8(IShapes.Pointer.Positions)) {
            if (p.positionsLocked) revert IShapes.PointerIsLocked();
            p.positionsLocked = true;
            emit IShapes.PositionsLocked(p.positions);
        } else if (pointer == uint8(IShapes.Pointer.Market)) {
            if (p.marketLocked) revert IShapes.PointerIsLocked();
            p.marketLocked = true;
            emit IShapes.MarketLocked(p.market);
        } else {
            revert IShapes.InvalidPointer();
        }
    }

    function _requireTarget(address target, bytes4 interfaceId) private view {
        if (target == address(0)) return;
        if (target.code.length == 0 || !_supports(target, interfaceId)) {
            revert IShapes.InvalidPointerTarget();
        }
    }

    /* ------------------------------- artist ------------------------------- */

    /// @dev Body of `Shapes.attestArtist`. Permissionless: anyone may relay the artist's
    ///      signature, and only the artist can produce one.
    function attestArtist(
        ArtistAttestation storage attestation,
        address artist,
        bytes32 releaseHash,
        bytes calldata signature
    ) public {
        if (attestation.releaseHash != bytes32(0)) {
            revert IShapes.ArtistAlreadyAttested();
        }
        if (releaseHash == bytes32(0)) revert IShapes.InvalidArtistReleaseHash();
        bytes32 digest = EIP712Signature.artistDigest(artist, releaseHash);
        if (!EIP712Signature.isValidNow(artist, digest, signature)) {
            revert IShapes.InvalidArtistSignature();
        }

        attestation.releaseHash = releaseHash;
        attestation.signature = signature;
        emit IShapes.ArtistAttested(artist, releaseHash, signature);
    }

    /// @dev Returns false on a revert as well as on a false return, so the caller's revert path is
    ///      the same however `target` failed the check.
    function _supports(address target, bytes4 interfaceId) private view returns (bool) {
        try IERC165(target).supportsInterface(interfaceId) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }
}

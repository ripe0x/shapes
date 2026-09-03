// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {IAdminControl} from "../interfaces/IAdminControl.sol";
import {IShapeAuctionHouse} from "../interfaces/IShapeAuctionHouse.sol";
import {IShapeCollection} from "../interfaces/IShapeCollection.sol";
import {IShapeGeometry} from "../interfaces/IShapeGeometry.sol";
import {IShapePositionResolver} from "../interfaces/IShapePositionResolver.sol";
import {IShapeRenderer} from "../interfaces/IShapeRenderer.sol";
import {IShapes} from "../interfaces/IShapes.sol";
import {Denominations} from "./Denominations.sol";
import {EIP712Signature} from "./EIP712Signature.sol";

/// @title AdminOps
/// @notice Every configuration write path on `Shapes`: fee, presentation pointers, the two
///         discovery pointers, and the artist attestation.
/// @dev Public library called through `DELEGATECALL`, so storage stays in `Shapes` and events are
///      emitted from `Shapes`'s address. Part of the trusted implementation: its address is linked
///      into `Shapes`'s bytecode at deploy time with no setter. Each function is named after the
///      `Shapes` entrypoint whose body it holds.
///
///      Authorization runs in `Shapes` before it delegates here: `onlyAdmin` on every setter, and
///      no gate on `attestArtist`, which is permissionless by design. The admin address is written
///      by `Shapes`. Each mutator here receives a pointer to the struct holding the fields it
///      writes.
///
///      Each such struct groups fields that one function writes together. A bare `string` or
///      `bytes` storage-pointer parameter cannot be assigned from calldata or memory, because
///      solc emits no copy for a standalone reference-type parameter. Assigning through a struct
///      member reached via the pointer works, which is why these fields live in structs.
library AdminOps {
    /// @dev Mint fee and fee recipient, grouped so `setFeeRecipient` and `setMintFee` take one
    ///      storage pointer. The per-recipient owed balances and their running total stay on
    ///      `Shapes`, since accrual happens in `_mintBatch`, not here.
    struct FeeConfig {
        uint256 mintFee;
        address feeRecipient;
    }

    /// @dev The artist's release hash and EIP-712 signature, grouped so `attestArtist` writes
    ///      both through one storage pointer.
    struct ArtistAttestation {
        bytes32 releaseHash;
        bytes signature;
    }

    /// @dev The two metadata contracts and the lock that freezes them. `tokenURI` reads
    ///      `renderer`, and `tokenURI` and `contractURI` read `collection`. One lock covers both,
    ///      and the collection reads it back to freeze its own metadata copy.
    struct Presentation {
        address renderer;
        address collection;
        bool locked;
    }

    /// @dev The two discovery pointers, each with its own permanent lock. Discovery only: no
    ///      token or reserve operation reads them.
    struct Pointers {
        address positions;
        bool positionsLocked;
        address market;
        bool marketLocked;
    }

    /// @dev Cap on the mint fee, equal to `unit()`. Enforced here and by `Shapes`'s constructor.
    uint256 internal constant MAX_MINT_FEE = Denominations.UNIT;

    /* ---------------------------- presentation ---------------------------- */

    /// @notice Reverts unless `renderer` has code and answers ERC-165 for both `IShapeRenderer`
    ///         and `IShapeGeometry`. `Shapes.geometryOf` and `Shapes.moduleAt` call the renderer
    ///         as `IShapeGeometry`, so both interfaces must be supported for every renderer that
    ///         installs.
    /// @dev A zero address has no code, so the length check rejects it. `Shapes`'s constructor
    ///      calls this before it writes the initial renderer.
    function requireRenderer(address renderer) internal view {
        if (
            renderer.code.length == 0 || !_supports(renderer, type(IShapeRenderer).interfaceId)
                || !_supports(renderer, type(IShapeGeometry).interfaceId)
        ) {
            revert IShapes.UnsupportedRenderer(renderer);
        }
    }

    /// @notice Reverts unless `collection` has code, answers ERC-165 for `IShapeCollection`, and
    ///         reports this token as the `Shapes` it is bound to.
    function requireCollection(address collection) internal view {
        if (collection.code.length == 0 || !_supports(collection, type(IShapeCollection).interfaceId)) {
            revert IShapes.UnsupportedCollection(collection);
        }
        if (IShapeCollection(collection).shapes() != address(this)) {
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

    /// @dev Body of `Shapes.setCollection`. The collection stores the metadata copy, so a new one
    ///      changes `tokenURI` for every existing token as well as `contractURI`; ERC-4906 and
    ///      ERC-7572 both signal the refresh.
    function setCollection(Presentation storage p, address newCollection, uint256 totalMinted) public {
        _requireUnlocked(p);
        requireCollection(newCollection);
        p.collection = newCollection;
        emit IShapes.CollectionUpdated(newCollection);
        if (totalMinted != 0) emit IERC4906.BatchMetadataUpdate(0, totalMinted - 1);
        emit IShapes.ContractURIUpdated();
    }

    /// @dev Body of `Shapes.lockPresentation`. One way. After this the renderer pointer, the
    ///      collection pointer and the collection's metadata copy are permanent. Requires a
    ///      collection to already be set, otherwise `tokenURI` and `contractURI` would be
    ///      permanently unreachable.
    function lockPresentation(Presentation storage p) public {
        _requireUnlocked(p);
        if (p.collection == address(0)) revert IShapes.CollectionNotSet();
        p.locked = true;
        emit IShapes.PresentationLocked(p.renderer, p.collection);
    }

    function _requireUnlocked(Presentation storage p) private view {
        if (p.locked) revert IShapes.PresentationIsLocked();
    }

    /* -------------------------------- fees -------------------------------- */

    /// @dev Body of `Shapes.setFeeRecipient`. Only points future accrual at `newRecipient`; fees
    ///      already credited to `previousRecipient` stay owed to it and are untouched here.
    ///      Rejects the zero address and `address(this)`, which in this delegatecall library is
    ///      `Shapes` itself: `Shapes` has no payable `receive`, so fees credited to its own address
    ///      could never be withdrawn.
    function setFeeRecipient(FeeConfig storage fees, address newRecipient) public {
        if (newRecipient == address(0) || newRecipient == address(this)) {
            revert IAdminControl.AdminInvalidFeeRecipient(newRecipient);
        }
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
    ///      Zero clears the pointer.
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

    /// @dev Body of `Shapes.lockPointer`. A pointer may be locked at zero, which is permanent.
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

    /// @dev Returns false when the call reverts and when it returns false, so the caller's revert
    ///      path is the same however `target` failed the check.
    function _supports(address target, bytes4 interfaceId) private view returns (bool) {
        try IERC165(target).supportsInterface(interfaceId) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }
}

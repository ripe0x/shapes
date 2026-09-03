// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuditBase} from "./AuditBase.sol";
import {AdminOps} from "../../src/lib/AdminOps.sol";
import {CopyValidation} from "../../src/lib/CopyValidation.sol";
import {EIP712Signature} from "../../src/lib/EIP712Signature.sol";
import {GeometrySampling} from "../../src/lib/GeometrySampling.sol";
import {InkGenes} from "../../src/lib/InkGenes.sol";
import {RecompositionOps} from "../../src/lib/RecompositionOps.sol";

/// @notice Required adversarial attempt 7: call every public function of every linked library at
///         the library's own address, with the storage-pointer argument crafted to name the slot
///         `Shapes` keeps that struct at, and confirm `Shapes` state is unchanged.
///
/// @dev Slots from `forge inspect Shapes storage-layout` at this commit: `_store` 6,
///      `_feeConfig` 16, `_artistAttestation` 20, `_presentation` 22, `_pointers` 24, `_admin` 26,
///      `_ownerToken` 27. Selectors are the library ABI's own, taken from
///      `forge inspect <lib> methodIdentifiers`; a storage-pointer parameter is ABI-encoded as the
///      slot number.
contract LibraryDirectCallTest is AuditBase {
    uint256 private constant SLOT_STORE = 6;
    uint256 private constant SLOT_FEE_CONFIG = 16;
    uint256 private constant SLOT_ARTIST = 20;
    uint256 private constant SLOT_PRESENTATION = 22;
    uint256 private constant SLOT_POINTERS = 24;
    uint256 private constant SLOT_ADMIN = 26;
    uint256 private constant SLOT_OWNER_TOKEN = 27;

    /// @dev Every protocol fact `Shapes` exposes through a getter, folded into one digest.
    function _snap() private view returns (bytes32) {
        bytes memory counters = abi.encode(
            shapes.totalSupply(),
            shapes.totalMinted(),
            shapes.redeemableBacking(),
            shapes.burnedBacking(),
            shapes.blackShapeCount(),
            shapes.pendingFees()
        );
        bytes memory config = abi.encode(
            shapes.mintFee(),
            shapes.feeRecipient(),
            shapes.renderer(),
            shapes.collection(),
            shapes.presentationLocked()
        );
        bytes memory roles = abi.encode(
            shapes.admin(), shapes.owner(), shapes.ownerToken(), shapes.artistReleaseHash(), shapes.ownerOf(0)
        );
        return keccak256(bytes.concat(counters, config, roles));
    }

    function _assertSame(bytes32 a) private view {
        assertEq(a, _snap(), "a direct library call moved Shapes state");
    }

    /// @dev Every raw slot `Shapes` uses, so a write landing anywhere in its layout is caught even
    ///      if no getter would show it.
    function _rawSlots() private view returns (bytes32[] memory out) {
        out = new bytes32[](30);
        for (uint256 i = 0; i < 30; ++i) {
            out[i] = vm.load(address(shapes), bytes32(i));
        }
    }

    function _assertRawSlotsSame(bytes32[] memory before) private view {
        bytes32[] memory now_ = _rawSlots();
        for (uint256 i = 0; i < before.length; ++i) {
            assertEq(now_[i], before[i], "a direct library call wrote a Shapes storage slot");
        }
    }

    /* --------------------------- RecompositionOps --------------------------- */

    /// @notice Every `RecompositionOps` entry, called at the library address with `_store`'s slot.
    function test_EveryRecompositionOpsEntryAtItsOwnAddressLeavesShapesUntouched() public {
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 3);
        uint256[] memory burnIds = new uint256[](1);
        burnIds[0] = survivor + 1;
        uint8[] memory outs = new uint8[](2);

        bytes32 before = _snap();
        bytes32[] memory raw = _rawSlots();

        // Mutators: solc's call protection rejects a direct CALL.
        _mustRevert(
            address(RecompositionOps),
            abi.encodeWithSelector(bytes4(0xa930f68d), SLOT_STORE, survivor, burnIds, uint96(0)),
            "compose"
        );
        _mustRevert(
            address(RecompositionOps),
            abi.encodeWithSelector(bytes4(0xe5c5df7f), SLOT_STORE, survivor),
            "decompose"
        );
        _mustRevert(
            address(RecompositionOps),
            abi.encodeWithSelector(bytes4(0x8ee2cc81), SLOT_STORE, survivor, outs),
            "split"
        );

        // Views and pures carry no guard, by design: they cannot write. Under a direct CALL the
        // storage pointer resolves against the library's own account, which holds nothing.
        _call(address(RecompositionOps), abi.encodeWithSelector(bytes4(0x22dadb29), SLOT_STORE, survivor));
        _call(address(RecompositionOps), abi.encodeWithSelector(bytes4(0x8e66ac36), SLOT_STORE, survivor, 0));
        _call(
            address(RecompositionOps),
            abi.encodeWithSelector(bytes4(0xfbd9b802), SLOT_STORE, survivor, burnIds)
        );
        _call(
            address(RecompositionOps), abi.encodeWithSelector(bytes4(0x723eef4c), SLOT_STORE, survivor, outs)
        );
        _call(address(RecompositionOps), abi.encodeWithSelector(bytes4(0x5f7cde24), burnIds));

        // The same calls aimed at every other slot in the token's layout.
        uint256[7] memory slots = [
            SLOT_STORE,
            SLOT_FEE_CONFIG,
            SLOT_ARTIST,
            SLOT_PRESENTATION,
            SLOT_POINTERS,
            SLOT_ADMIN,
            SLOT_OWNER_TOKEN
        ];
        for (uint256 i = 0; i < slots.length; ++i) {
            _call(
                address(RecompositionOps),
                abi.encodeWithSelector(bytes4(0xa930f68d), slots[i], survivor, burnIds, uint96(0))
            );
            _call(address(RecompositionOps), abi.encodeWithSelector(bytes4(0xe5c5df7f), slots[i], survivor));
            _call(
                address(RecompositionOps),
                abi.encodeWithSelector(bytes4(0x8ee2cc81), slots[i], survivor, outs)
            );
        }

        _assertSame(before);
        _assertRawSlotsSame(raw);
    }

    /// @notice The pure entry is genuinely dispatched, so the mutators' revert above is the call
    ///         protection rather than an unrecognised selector.
    function test_PureEntryIsDispatchedByADirectCall() public view {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 7;
        ids[1] = 9;
        (bool ok,) = address(RecompositionOps).staticcall(abi.encodeWithSelector(bytes4(0x5f7cde24), ids));
        assertTrue(ok, "the dispatcher did not run the pure body");

        ids[1] = 7;
        (ok,) = address(RecompositionOps).staticcall(abi.encodeWithSelector(bytes4(0x5f7cde24), ids));
        assertFalse(ok, "the pure body did not reject a repeat");
    }

    /* ------------------------------- AdminOps ------------------------------- */

    /// @notice Every `AdminOps` entry at the library address, each aimed at the slot `Shapes` keeps
    ///         the struct it writes at.
    function test_EveryAdminOpsEntryAtItsOwnAddressLeavesShapesUntouched() public {
        bytes32 before = _snap();
        bytes32[] memory raw = _rawSlots();

        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0xaefafe15), SLOT_PRESENTATION),
            "lockPresentation"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0x26679067), SLOT_PRESENTATION, address(renderer), uint256(1)),
            "setRenderer"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0x54e8c189), SLOT_PRESENTATION, address(collection), uint256(1)),
            "setCollection"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0xfdec4941), SLOT_FEE_CONFIG, uint256(0)),
            "setMintFee"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0x07115301), SLOT_FEE_CONFIG, address(0xBAD)),
            "setFeeRecipient"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0xa5b07693), SLOT_POINTERS, uint8(0), address(0)),
            "setPointer"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0xdb97eed6), SLOT_POINTERS, uint8(0)),
            "lockPointer"
        );
        _mustRevert(
            address(AdminOps),
            abi.encodeWithSelector(bytes4(0xd4897488), SLOT_ARTIST, address(this), keccak256("x"), bytes("")),
            "attestArtist"
        );

        // Aim the admin-adjacent writes at the admin slot and the owner-token slot too.
        _call(address(AdminOps), abi.encodeWithSelector(bytes4(0x07115301), SLOT_ADMIN, address(0xBAD)));
        _call(address(AdminOps), abi.encodeWithSelector(bytes4(0xfdec4941), SLOT_OWNER_TOKEN, uint256(99)));
        _call(address(AdminOps), abi.encodeWithSelector(bytes4(0xaefafe15), SLOT_ADMIN));

        _assertSame(before);
        _assertRawSlotsSame(raw);
        assertEq(shapes.admin(), address(this), "admin moved");
        assertEq(shapes.ownerToken(), 0, "owner token moved");
    }

    /* --------------------------- the other links --------------------------- */

    /// @notice The pure sampling and cryptography libraries carry no storage pointer at all, so a
    ///         direct call is a pure computation with nothing to aim at.
    function test_PureLinkedLibrariesCannotReachShapes() public {
        bytes32 before = _snap();
        bytes32[] memory raw = _rawSlots();

        _call(address(InkGenes), abi.encodeWithSelector(bytes4(0xfc3bfbab), keccak256("s"), uint8(0)));
        _call(
            address(InkGenes),
            abi.encodeWithSelector(
                bytes4(0x11bd920a),
                keccak256("s"),
                uint256(1),
                uint8(3),
                uint8(0),
                uint8(4),
                uint8(6),
                uint8(0),
                uint8(3)
            )
        );
        _call(
            address(GeometrySampling),
            abi.encodeWithSelector(bytes4(0xbe624cd3), keccak256("s"), uint8(0), uint8(3))
        );
        _call(
            address(GeometrySampling),
            abi.encodeWithSelector(bytes4(0xc03642d9), bytes(""), keccak256("s"), uint8(0), uint8(3))
        );
        _call(
            address(EIP712Signature),
            abi.encodeWithSelector(bytes4(0x20c50291), address(this), keccak256("r"))
        );
        _call(
            address(EIP712Signature),
            abi.encodeWithSelector(bytes4(0xf00ecd2c), address(this), keccak256("r"), bytes(""))
        );
        _call(
            address(CopyValidation),
            abi.encodeWithSelector(bytes4(0x5a4e4fdb), "hello", uint256(64), uint8(0))
        );

        _assertSame(before);
        _assertRawSlotsSame(raw);
    }

    /* ------------------ isolation without the call protection ------------------ */

    /// @notice Strip the compiler's guard out of the picture entirely: run the library's code at a
    ///         second address, where the guard's `address(this)` comparison does not fire. The body
    ///         executes and its write lands in that account's storage. `Shapes` is untouched, which
    ///         is the second, independent reason a direct call cannot reach the token.
    function test_LibraryCodeAtAnotherAddressWritesThatAccountNotShapes() public {
        address clone = address(0xC10E);
        vm.etch(clone, address(AdminOps).code);

        bytes32 before = _snap();
        bytes32[] memory raw = _rawSlots();

        // `Presentation` at slot 22: `collection` and `locked` share slot 23 (`collection` in the
        // low 160 bits, `locked` at byte 20). Since 887497c, `lockPresentation` reverts
        // `CollectionNotSet` while `collection` is zero; seed the clone's own copy of that field
        // so the call reaches the write this test is about, entirely within the clone's isolated
        // storage and independent of Shapes, which never had `setCollection` called on the clone.
        vm.store(clone, bytes32(uint256(23)), bytes32(uint256(uint160(address(0xC011)))));

        bytes32 cloneSlot23Before = vm.load(clone, bytes32(uint256(23)));
        (bool ok,) = clone.call(abi.encodeWithSelector(bytes4(0xaefafe15), SLOT_PRESENTATION));
        assertTrue(ok, "the library body did not run without the call protection");

        bytes32 cloneSlot23After = vm.load(clone, bytes32(uint256(23)));
        assertTrue(cloneSlot23Before != cloneSlot23After, "the write did not land anywhere");
        assertEq(
            uint256(cloneSlot23After) >> 160, 1, "the lock landed somewhere other than the clone's own slot"
        );

        assertFalse(shapes.presentationLocked(), "Shapes was locked from another account");
        _assertSame(before);
        _assertRawSlotsSame(raw);
    }

    /* ------------------------------- helpers ------------------------------- */

    function _mustRevert(address target, bytes memory data, string memory what) private {
        (bool ok,) = target.call(data);
        assertFalse(ok, string.concat("a direct CALL reached ", what));
    }

    function _call(address target, bytes memory data) private {
        (bool ok,) = target.call(data);
        ok; // the outcome is irrelevant; what matters is that Shapes did not move
    }
}

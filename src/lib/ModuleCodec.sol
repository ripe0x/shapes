// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ModuleCodec
/// @notice One-byte encoding for a module's intrinsic identity: kind, solid, rotation.
/// @dev Layout: bit 7 always 0, bits 6..5 rotation index (0..3, meaning `rotIndex * 90` degrees
///      clockwise), bit 4 solid, bits 3..0 kind (0..9, the consensus KIND_* ordering fixed in
///      `ShapeRenderer`). Position (cx, cy), size and weight are not encoded; they derive from
///      the token's own grid geometry and card constants.
///
///      `KIND_COUNT` and `rotCount` mirror `ShapeRenderer`'s KIND_* ordering and `_rotCount`.
///      Duplicated here rather than shared by reference because module sampling runs inside
///      `Shapes`, which must not depend on the mutable, admin-replaceable renderer address for a
///      consensus-critical state change.
library ModuleCodec {
    uint256 internal constant KIND_COUNT = 10;

    uint8 private constant SOLID_BIT = 0x10;
    uint8 private constant KIND_MASK = 0x0F;
    uint8 private constant SIGN_BIT = 0x80;
    uint256 private constant ROT_SHIFT = 5;

    /// @notice Distinct rotations a kind takes: 1 (circle, square, diamond, kinds 0, 1, 5), 2
    ///         (the diagonal line, kind 9), or 4 (every other kind). Mirrors
    ///         `ShapeRenderer._rotCount`.
    function rotCount(uint256 kind) internal pure returns (uint256) {
        if (kind == 0 || kind == 1 || kind == 5) return 1;
        if (kind == 9) return 2;
        return 4;
    }

    /// @notice Pack a module's identity into one byte.
    function encode(uint256 kind, bool solid, uint256 rotIndex) internal pure returns (bytes1) {
        return bytes1(uint8((rotIndex << ROT_SHIFT) | (solid ? SOLID_BIT : 0) | kind));
    }

    /// @notice Unpack an encoded byte. Does not validate; call `isValid` first when the byte
    ///         did not originate from `encode`.
    function decode(bytes1 b) internal pure returns (uint256 kind, bool solid, uint256 rotIndex) {
        uint8 v = uint8(b);
        kind = v & KIND_MASK;
        solid = (v & SOLID_BIT) != 0;
        rotIndex = v >> ROT_SHIFT;
    }

    /// @notice Valid iff bit 7 is clear, `kind < KIND_COUNT`, and `rotIndex < rotCount(kind)`.
    function isValid(bytes1 b) internal pure returns (bool) {
        if (uint8(b) & SIGN_BIT != 0) return false;
        (uint256 kind,, uint256 rotIndex) = decode(b);
        if (kind >= KIND_COUNT) return false;
        return rotIndex < rotCount(kind);
    }
}

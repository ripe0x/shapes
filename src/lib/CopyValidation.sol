// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CopyValidation
/// @notice UTF-8 and JSON-safety validation for the owner-editable copy fields
///         (`Shapes.setTokenCopy`, `Shapes.setCollectionCopy`).
/// @dev External library: forge deploys this separately and links its address into `Shapes` at
///      deploy time, the same mechanism as `GeometrySampling`. Not consensus-critical: this gates
///      owner-submitted copy strings and has no bearing on token geometry or gene assignment.
library CopyValidation {
    error InvalidCopy(uint8 field);

    /// @notice Requires `s` fit within `maxBytes` and consist only of JSON-safe, well-formed
    ///         UTF-8 bytes: no unescaped `"`, `\`, or C0 control character in the ASCII range,
    ///         and a full RFC 3629 walk above it — no lone continuation bytes, overlong
    ///         encodings, UTF-16 surrogates, code points above U+10FFFF, or truncated sequences.
    /// @param field Distinguishes the caller's two copy arguments in the revert (0 name/prefix,
    ///        1 description).
    function requireJsonSafe(string calldata s, uint256 maxBytes, uint8 field) public pure {
        bytes calldata b = bytes(s);
        if (b.length > maxBytes) revert InvalidCopy(field);
        uint256 i;
        while (i < b.length) {
            uint8 c = uint8(b[i]);
            if (c < 0x80) {
                if (c == 0x22 || c == 0x5C || c < 0x20) revert InvalidCopy(field);
                i += 1;
            } else if (c < 0xC2) {
                revert InvalidCopy(field); // lone continuation byte, or an overlong C0/C1 lead
            } else if (c < 0xE0) {
                _requireCont(b, i + 1, 0x80, 0xBF, field);
                i += 2;
            } else if (c < 0xF0) {
                // E0 bars an overlong three-byte form; ED bars the surrogate range U+D800..U+DFFF.
                _requireCont(b, i + 1, c == 0xE0 ? 0xA0 : 0x80, c == 0xED ? 0x9F : 0xBF, field);
                _requireCont(b, i + 2, 0x80, 0xBF, field);
                i += 3;
            } else if (c < 0xF5) {
                // F0 bars an overlong four-byte form; F4 caps the range at U+10FFFF.
                _requireCont(b, i + 1, c == 0xF0 ? 0x90 : 0x80, c == 0xF4 ? 0x8F : 0xBF, field);
                _requireCont(b, i + 2, 0x80, 0xBF, field);
                _requireCont(b, i + 3, 0x80, 0xBF, field);
                i += 4;
            } else {
                revert InvalidCopy(field); // lead byte encodes a code point above U+10FFFF
            }
        }
    }

    /// @dev One UTF-8 continuation byte at `idx`, required present and within `[lo, hi]`. The
    ///      lead byte narrows `lo`/`hi` on the first continuation to exclude overlongs and
    ///      surrogates.
    function _requireCont(bytes calldata b, uint256 idx, uint8 lo, uint8 hi, uint8 field) private pure {
        if (idx >= b.length) revert InvalidCopy(field);
        uint8 c = uint8(b[idx]);
        if (c < lo || c > hi) revert InvalidCopy(field);
    }
}

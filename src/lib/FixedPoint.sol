// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FixedPoint
/// @notice Canonical fixed-point arithmetic and decimal formatting for the Shapes renderer.
/// @dev This is a direct port of `preview/src/canonical/wad.ts`. Every operation must match
///      that file exactly, because SVG byte parity between the two implementations is an
///      acceptance requirement rather than a nicety. See SPEC.md D1 and D2.
library FixedPoint {
    /// @dev 1.0 in fixed point.
    uint256 internal constant WAD = 1e18;

    /// @dev One unit in the last emitted decimal place: 1e18 / 1e6.
    uint256 internal constant ULP = 1e12;

    /// @notice a * b / 1e18, flooring. Both operands are non-negative by construction.
    function mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / WAD;
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Decimal representation of an unsigned integer.
    function toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) {
            digits++;
        }
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }

    /// @dev Decimal representation of `v`, left-padded with zeros to `width` characters.
    function _padded(uint256 v, uint256 width) private pure returns (bytes memory buf) {
        buf = new bytes(width);
        for (uint256 i = width; i > 0; i--) {
            buf[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
    }

    /// @notice The canonical coordinate formatter.
    /// @dev Emits at most 6 fractional digits, rounds half away from zero, strips trailing
    ///      fractional zeros and never leaves a trailing decimal point. This is the single
    ///      point where geometry becomes text; it is what makes byte parity testable.
    function fmt(uint256 v) internal pure returns (string memory) {
        uint256 q = (v + ULP / 2) / ULP; // count of 1e-6 units, half-up
        uint256 ip = q / 1e6;
        uint256 fp = q % 1e6;
        if (fp == 0) return toString(ip);

        uint256 width = 6;
        while (fp % 10 == 0) {
            fp /= 10;
            width--;
        }
        return string(abi.encodePacked(toString(ip), ".", _padded(fp, width)));
    }
}

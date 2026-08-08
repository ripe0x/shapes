// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal standard-alphabet base64 decoder, used only by tests.
/// @dev Lets the suite prove that `tokenURI` really is decodable base64 containing real JSON
///      containing a real inline SVG, rather than asserting against the encoder that produced
///      it. Reverts on any character outside the alphabet, so malformed output fails loudly.
library Base64Decode {
    error InvalidBase64Length(uint256 length);
    error InvalidBase64Character(bytes1 c);

    function decode(string memory sIn) internal pure returns (bytes memory) {
        bytes memory s = bytes(sIn);
        if (s.length == 0) return "";
        if (s.length % 4 != 0) revert InvalidBase64Length(s.length);

        uint256 pad = 0;
        if (s[s.length - 1] == "=") pad++;
        if (s[s.length - 2] == "=") pad++;

        bytes memory out = new bytes((s.length / 4) * 3 - pad);
        uint256 o = 0;

        for (uint256 i = 0; i < s.length; i += 4) {
            uint256 chunk = (_v(s[i]) << 18) | (_v(s[i + 1]) << 12) | (_vp(s[i + 2]) << 6)
                | _vp(s[i + 3]);
            if (o < out.length) out[o++] = bytes1(uint8(chunk >> 16));
            if (o < out.length) out[o++] = bytes1(uint8((chunk >> 8) & 0xff));
            if (o < out.length) out[o++] = bytes1(uint8(chunk & 0xff));
        }
        return out;
    }

    function _v(bytes1 c) private pure returns (uint256) {
        uint8 x = uint8(c);
        if (x >= 65 && x <= 90) return x - 65; // A-Z
        if (x >= 97 && x <= 122) return x - 71; // a-z
        if (x >= 48 && x <= 57) return x + 4; // 0-9
        if (x == 43) return 62; // +
        if (x == 47) return 63; // /
        revert InvalidBase64Character(c);
    }

    /// @dev As `_v`, but tolerates the '=' padding character in the last two positions.
    function _vp(bytes1 c) private pure returns (uint256) {
        if (c == "=") return 0;
        return _v(c);
    }
}

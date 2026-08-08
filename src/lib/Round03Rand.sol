// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedPoint} from "./FixedPoint.sol";

/// @title Round03Rand
/// @notice The deterministic random stream of the Shapes Round 03 visual system.
/// @dev A direct port of `preview/src/canonical/rand.ts`, which is itself an exact-integer
///      transcription of the mulberry32 variant in the Round 03 design source:
///
///          let a = (seed * 1831565813 + 0x6D2B79F5) >>> 0;
///          () => {
///            a = (a + 0x6D2B79F5) >>> 0;
///            let x = Math.imul(a ^ (a >>> 15), 1 | a);
///            x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
///            return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
///          }
///
///      Two properties worth knowing, both documented in SPEC.md D3:
///
///      1. The state is 32 bits wide, so the artwork space is 2^32 compositions per
///         denomination. The token's full bytes32 seed is stored on chain regardless; only
///         its low 32 bits reach the stream.
///      2. The seeding multiplier and the per-draw increment are the same constant, so
///         a(seed, draw) = 0x6D2B79F5 * (seed + draw + 1). Every seed is a window into one
///         shared sequence. This is benign for keccak-derived token seeds and is inherent to
///         the preserved algorithm.
library Round03Rand {
    uint256 private constant M32 = 0xffffffff;
    uint256 private constant TWO32 = 0x100000000;
    uint256 private constant INC = 0x6d2b79f5;

    struct Stream {
        uint256 a;
    }

    /// @dev (a * b) mod 2^32 — the semantics of JavaScript's Math.imul.
    function _imul(uint256 a, uint256 b) private pure returns (uint256 r) {
        unchecked {
            r = (a * b) & M32;
        }
    }

    /// @notice Open a stream for a token seed. Only the low 32 bits participate.
    function init(bytes32 seed) internal pure returns (Stream memory s) {
        unchecked {
            s.a = ((uint256(seed) & M32) * 1831565813 + INC) & M32;
        }
    }

    /// @notice The next raw draw, a uniform uint32.
    function nextU32(Stream memory s) internal pure returns (uint256 x) {
        unchecked {
            s.a = (s.a + INC) & M32;
            uint256 a = s.a;
            x = _imul(a ^ (a >> 15), 1 | a);
            x = ((x + _imul(x ^ (x >> 7), 61 | x)) & M32) ^ x;
            x = (x ^ (x >> 14)) & M32;
        }
    }

    /// @notice The next draw as a WAD fraction in [0, 1). Equivalent to `u32 / 2^32`.
    function nextWad(Stream memory s) internal pure returns (uint256) {
        return (nextU32(s) * FixedPoint.WAD) / TWO32;
    }

    /// @notice The next draw reduced to [0, n). Equivalent to `floor(rand() * n)`, evaluated
    ///         on the uint32 so bucket edges are exact.
    function nextBelow(Stream memory s, uint256 n) internal pure returns (uint256) {
        return (nextU32(s) * n) / TWO32;
    }

    /// @notice Whether the next draw falls below `pWad` — an event of probability exactly `pWad`.
    /// @dev Stated this way round rather than as `rand() > threshold` so the endpoints are
    ///      exact: `p = 0` is never true and `p = 1` is always true, because a draw lies in
    ///      [0, 1). That matters once the probability is itself drawn per card and allowed to
    ///      reach 0 and 1 — a card that says "all solid" must contain no outlined mark at all.
    function nextBelowProbability(Stream memory s, uint256 pWad) internal pure returns (bool) {
        return nextU32(s) * FixedPoint.WAD < pWad * TWO32;
    }
}

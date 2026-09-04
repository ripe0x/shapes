// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Pins the compiled denomination ladder.
/// @dev Two jobs. The invariant tests cover the properties the rest of the protocol assumes: nine
///      amounts, strictly increasing, every one a whole multiple of UNIT. The pinning test asserts
///      the table matches the ladder it claims to be, so an edited table in
///      `ladders/mainnet/Ladder.sol` fails the suite instead of reaching a deploy.
contract LadderTest is Test {
    function test_LadderHasNineStrictlyIncreasingAmounts() public pure {
        assertEq(Denominations.COUNT, 9);
        for (uint256 i = 1; i < Denominations.COUNT; i++) {
            assertGt(Denominations.amountAt(i), Denominations.amountAt(i - 1));
        }
    }

    function test_EveryAmountIsAWholeMultipleOfUnit() public pure {
        assertEq(Denominations.amountAt(0), Denominations.UNIT);
        for (uint256 i = 0; i < Denominations.COUNT; i++) {
            assertEq(Denominations.amountAt(i) % Denominations.UNIT, 0);
            assertGt(Denominations.unitsAt(i), 0);
        }
    }

    function test_IndexOfRoundTripsEveryAmount() public pure {
        for (uint256 i = 0; i < Denominations.COUNT; i++) {
            (uint256 index, bool ok) = Denominations.indexOf(Denominations.amountAt(i));
            assertTrue(ok);
            assertEq(index, i);
        }
    }

    function test_LabelsAreDistinctAndNonEmpty() public pure {
        for (uint256 i = 0; i < Denominations.COUNT; i++) {
            bytes memory a = bytes(Denominations.labelAt(i));
            assertGt(a.length, 0);
            for (uint256 j = i + 1; j < Denominations.COUNT; j++) {
                assertTrue(keccak256(a) != keccak256(bytes(Denominations.labelAt(j))));
            }
        }
    }

    function test_AmountsOffTheLadderAreUnsupported() public pure {
        assertFalse(Denominations.isSupported(0));
        assertFalse(Denominations.isSupported(Denominations.UNIT - 1));
        assertFalse(Denominations.isSupported(Denominations.amountAt(0) + 1));
        assertFalse(Denominations.isSupported(Denominations.amountAt(8) * 2));
    }

    /// @dev Routed through external calls: expectRevert cannot observe an internal library call,
    ///      which runs at the cheatcode's own depth.
    function test_IndexOutOfRangeReverts() public {
        vm.expectRevert();
        this.amountAt(9);
        vm.expectRevert();
        this.labelAt(9);
        vm.expectRevert();
        this.gridAt(9);
    }

    function amountAt(uint256 i) external pure returns (uint256) {
        return Denominations.amountAt(i);
    }

    function labelAt(uint256 i) external pure returns (string memory) {
        return Denominations.labelAt(i);
    }

    function gridAt(uint256 i) external pure returns (uint256, uint256) {
        return Denominations.gridAt(i);
    }

    /// @dev The guard. The ladder names itself, and this asserts the table matches that name.
    function test_CompiledLadderMatchesItsName() public pure {
        assertEq(Denominations.LADDER_NAME, "mainnet");
        assertEq(Denominations.UNIT, 0.01 ether);
        assertEq(Denominations.amountAt(0), 0.01 ether);
        assertEq(Denominations.amountAt(4), 1 ether);
        assertEq(Denominations.amountAt(8), 100 ether);
        assertEq(Denominations.labelAt(8), "100");
    }

    /// @dev Unit counts of the compiled ladder.
    function test_UnitCountsArePinned() public pure {
        uint16[9] memory units = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000];
        for (uint256 i = 0; i < Denominations.COUNT; i++) {
            assertEq(Denominations.unitsAt(i), units[i]);
        }
    }
}

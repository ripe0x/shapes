// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {AuditBase} from "./AuditBase.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {IShapePositionResolver} from "../../src/interfaces/IShapePositionResolver.sol";

/// @notice Required adversarial attempt 2: install a hostile `positions` target and try to reach
///         past `Shapes.positionOf` with it. The target may revert, return malformed data, burn
///         unbounded gas, or reenter the token.
contract HostilePositionsTargetTest is AuditBase {
    function _install(address target) private {
        shapes.setPointer(uint8(IShapes.Pointer.Positions), target);
        assertEq(_positionsAddress(), target, "pointer not installed");
    }

    /// @notice A target that reverts resolves to zero rather than propagating.
    function test_RevertingTargetResolvesToZero() public {
        RevertingResolver r = new RevertingResolver();
        _install(address(r));
        assertEq(shapes.positionOf(0), address(0), "revert did not resolve to zero");
    }

    /// @notice Returns fewer than 32 bytes, more than 32 bytes, and empty. All resolve to zero.
    function test_MalformedReturnsResolveToZero() public {
        MalformedResolver short_ = new MalformedResolver(31);
        _install(address(short_));
        assertEq(shapes.positionOf(0), address(0), "31-byte return accepted");

        MalformedResolver long_ = new MalformedResolver(64);
        _install(address(long_));
        assertEq(shapes.positionOf(0), address(0), "64-byte return accepted");

        MalformedResolver huge = new MalformedResolver(4096);
        _install(address(huge));
        assertEq(shapes.positionOf(0), address(0), "4096-byte return accepted");

        MalformedResolver empty = new MalformedResolver(0);
        _install(address(empty));
        assertEq(shapes.positionOf(0), address(0), "empty return accepted");
    }

    /// @notice A word with bits set above the low 160 is rejected, so a caller can never be handed
    ///         a dirty address.
    function test_DirtyHighBitsRejected() public {
        DirtyResolver r = new DirtyResolver();
        _install(address(r));
        assertEq(shapes.positionOf(0), address(0), "dirty high bits accepted");
    }

    /// @notice An unbounded-gas target cannot drain the caller: the stipend caps what it burns and
    ///         the failure is swallowed.
    function test_GasBombIsCappedAndSwallowed() public {
        GasBombResolver r = new GasBombResolver();
        _install(address(r));

        uint256 before = gasleft();
        address got = shapes.positionOf(0);
        uint256 used = before - gasleft();

        assertEq(got, address(0), "gas bomb did not resolve to zero");
        // 50,000 forwarded plus the view's own frame. Well under a block.
        assertLt(used, 120_000, "positionOf burned more than the stipend allows");
    }

    /// @notice The target is reached by `staticcall`, so a reentrant write is impossible; a
    ///         reentrant read is possible and changes nothing.
    /// @dev The resolver aims at `withdrawFees`, armed here with a real pending balance, so it
    ///      would succeed outside a static frame. It reports the outcome through its return value,
    ///      since it cannot write its own storage either.
    function test_ReentrantTargetCannotWriteAndChangesNothing() public {
        _mint(alice, DENOMS[0]); // accrue a fee so `withdrawFees` would otherwise succeed
        assertGt(shapes.pendingFees(), 0, "no fee to steal");

        ReentrantResolver r = new ReentrantResolver(shapes);
        _install(address(r));

        uint256 supplyBefore = shapes.totalSupply();
        uint256 reserveBefore = shapes.redeemableBacking();
        uint256 mintedBefore = shapes.totalMinted();
        uint256 feesBefore = shapes.pendingFees();
        address adminBefore = shapes.admin();

        assertEq(
            shapes.positionOf(0),
            address(uint160(2)),
            "a state-changing reentrant call succeeded from inside positionOf"
        );

        assertEq(shapes.totalSupply(), supplyBefore, "supply moved");
        assertEq(shapes.redeemableBacking(), reserveBefore, "reserve moved");
        assertEq(shapes.totalMinted(), mintedBefore, "counter moved");
        assertEq(shapes.pendingFees(), feesBefore, "fees moved");
        assertEq(shapes.admin(), adminBefore, "admin moved");
        _assertReserveInvariant();
    }

    /// @notice A target that does not answer ERC-165 for `IShapePositionResolver` is refused at
    ///         install time. A target that does answer it may still lie about every position, and
    ///         the view repeats the lie: that is the whole of a hostile target's power.
    function test_TargetMustAnswerItsInterfaceAndMayStillLie() public {
        vm.expectRevert(IShapes.InvalidPointerTarget.selector);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(this));

        MalformedResolver liar = new MalformedResolver(32);
        shapes.setPointer(uint8(IShapes.Pointer.Positions), address(liar));
        assertEq(shapes.positionOf(0), address(1), "a clean 32-byte word is returned verbatim");
        assertEq(shapes.positionOf(12345), address(1), "the same lie for an id that does not exist");

        assertEq(shapes.ownerOf(0), address(this), "ownership moved");
        _assertReserveInvariant();
    }

    /// @notice No protocol path reads the pointer, so a hostile target cannot touch mint,
    ///         redemption or recomposition.
    function test_HostileTargetCannotAffectAnyValuePath() public {
        GasBombResolver r = new GasBombResolver();
        _install(address(r));

        uint256 id = _mint(alice, DENOMS[0]);
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, balBefore + DENOMS[0], "redemption paid the wrong amount");
        _assertReserveInvariant();
    }
}

contract RevertingResolver is IShapePositionResolver {
    error Nope();

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IShapePositionResolver).interfaceId || id == type(IERC165).interfaceId;
    }

    function positionOf(uint256) external pure returns (address) {
        revert Nope();
    }
}

/// @dev Answers ERC-165, then returns exactly `size` bytes for every other call.
contract MalformedResolver {
    uint256 private immutable size;

    constructor(uint256 size_) {
        size = size_;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IShapePositionResolver).interfaceId || id == type(IERC165).interfaceId;
    }

    fallback() external {
        uint256 n = size;
        assembly ("memory-safe") {
            mstore(0, 1)
            return(0, n)
        }
    }
}

contract DirtyResolver {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IShapePositionResolver).interfaceId || id == type(IERC165).interfaceId;
    }

    fallback() external {
        assembly ("memory-safe") {
            mstore(0, not(0))
            return(0, 32)
        }
    }
}

contract GasBombResolver is IShapePositionResolver {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IShapePositionResolver).interfaceId || id == type(IERC165).interfaceId;
    }

    function positionOf(uint256) external pure returns (address) {
        uint256 x;
        for (uint256 i = 0; i < 5_000_000; ++i) {
            x = uint256(keccak256(abi.encode(x, i)));
        }
        return address(uint160(x));
    }
}

/// @dev Tries to write to `Shapes` from inside the resolver call. The call arrives by
///      `staticcall`, so the write reverts with `StateChangeDuringStaticCall`; the resolver
///      reports which branch it took through its return value, because it cannot write its own
///      storage either. Anything more than one such attempt exhausts the 50,000-gas stipend, which
///      is a second bound on what a reentrant target can do.
contract ReentrantResolver {
    address private constant WRITE_SUCCEEDED = address(uint160(1));
    address private constant WRITE_FAILED = address(uint160(2));

    IShapes public immutable shapes;

    constructor(IShapes shapes_) {
        shapes = shapes_;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IShapePositionResolver).interfaceId || id == type(IERC165).interfaceId;
    }

    function positionOf(uint256) external returns (address) {
        (bool ok,) = address(shapes).call(abi.encodeCall(IShapes.withdrawFees, (shapes.feeRecipient())));
        return ok ? WRITE_SUCCEEDED : WRITE_FAILED;
    }
}

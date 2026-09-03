// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {AdminOps} from "../src/lib/AdminOps.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {RecompositionOps} from "../src/lib/RecompositionOps.sol";

/// @notice `RecompositionOps` and `AdminOps` are public libraries that `Shapes` reaches with
///         `DELEGATECALL`, so their bodies write the token's storage. Both are also deployed
///         contracts with their own addresses, and anyone may `CALL` them there with any
///         arguments, including a storage-pointer argument naming a slot `Shapes` uses. These
///         tests pin what such a call can reach: nothing on `Shapes`.
/// @dev The storage-pointer parameter of a public library function is ABI-encoded as the slot
///      number, so the calldata below is exactly what a caller aiming at `Shapes`'s own layout
///      would build: slot 6 is `_store`, slot 22 is `_presentation` (`forge inspect Shapes
///      storage-layout`).
contract LibraryIsolationTest is Test {
    uint256 internal constant STORE_SLOT = 6;
    uint256 internal constant PRESENTATION_SLOT = 22;

    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;

    address internal alice = makeAddr("alice");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
        vm.deal(alice, 1_000 ether);
    }

    /// @notice A direct `CALL` to `RecompositionOps.compose` at the library's own address, with the
    ///         storage pointer set to the slot `Shapes` keeps `_store` at, leaves `Shapes`
    ///         untouched.
    /// @dev Observed: the call REVERTS. solc emits call protection into every public library with a
    ///      non-view, non-pure external function: the runtime compares `address(this)` against the
    ///      library address written into its own code at deployment and reverts when they match,
    ///      which is exactly the direct-call case. Even without that guard the call could not reach
    ///      `Shapes`: a storage pointer resolves against the executing account, so slot 6 would
    ///      mean slot 6 of the library's own storage, which no contract reads.
    function test_DirectCallToRecompositionOpsCannotTouchShapes() public {
        uint256 survivorId = _mint(alice, 3);
        uint256 burnId = _mint(alice, 3);

        uint256[] memory burnIds = new uint256[](1);
        burnIds[0] = burnId;

        _State memory before = _snapshot();

        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("compose(ShapeStore storage,uint256,uint256[],uint96)")),
            STORE_SLOT,
            survivorId,
            burnIds,
            uint96(0)
        );

        vm.prank(alice);
        (bool ok,) = address(RecompositionOps).call(data);
        assertFalse(ok, "the compiler's library call protection should reject a direct CALL");

        _assertUnchanged(before);
    }

    /// @notice The revert above is the call protection, not an unrecognised selector: the library's
    ///         external dispatcher answers a direct `CALL` normally for a `public pure` function,
    ///         which the compiler leaves unguarded because it cannot write anything.
    function test_DirectCallDispatchesAPureLibraryFunction() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;

        (bool ok,) = address(RecompositionOps)
            .call(abi.encodeWithSelector(RecompositionOps.requireDistinctComposeInputs.selector, ids));
        assertTrue(ok, "a pure library function is reachable by direct CALL");

        ids[1] = 1;
        (ok,) = address(RecompositionOps)
            .call(abi.encodeWithSelector(RecompositionOps.requireDistinctComposeInputs.selector, ids));
        assertFalse(ok, "the same call rejects a repeated id, so the dispatcher ran the body");
    }

    /// @notice Same for the configuration library: a direct `CALL` to `AdminOps.lockPresentation`
    ///         with the slot `Shapes` keeps `_presentation` at cannot lock the token.
    /// @dev Observed: the call REVERTS, for the same call protection. `Shapes.presentationLocked()`
    ///      is still false afterwards, and the admin can still lock it through the token.
    function test_DirectCallToAdminOpsCannotTouchShapes() public {
        _State memory before = _snapshot();

        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("lockPresentation(AdminOps.Presentation storage)")), PRESENTATION_SLOT
        );

        (bool ok,) = address(AdminOps).call(data);
        assertFalse(ok, "the compiler's library call protection should reject a direct CALL");

        assertFalse(shapes.presentationLocked(), "presentation locked through the library address");
        _assertUnchanged(before);

        shapes.lockPresentation();
        assertTrue(shapes.presentationLocked(), "the token's own lock path still works");
    }

    /* ------------------------------- helpers ------------------------------- */

    struct _State {
        uint256 totalSupply;
        address ownerOfGenesis;
        uint256 backingOfGenesis;
        uint256 redeemableBacking;
        address renderer;
        address admin;
    }

    function _snapshot() private view returns (_State memory) {
        return _State({
            totalSupply: shapes.totalSupply(),
            ownerOfGenesis: shapes.ownerOf(0),
            backingOfGenesis: shapes.backingOf(0),
            redeemableBacking: shapes.redeemableBacking(),
            renderer: shapes.renderer(),
            admin: shapes.admin()
        });
    }

    function _assertUnchanged(_State memory before) private view {
        assertEq(shapes.totalSupply(), before.totalSupply, "totalSupply moved");
        assertEq(shapes.ownerOf(0), before.ownerOfGenesis, "ownerOf moved");
        assertEq(shapes.backingOf(0), before.backingOfGenesis, "backingOf moved");
        assertEq(shapes.redeemableBacking(), before.redeemableBacking, "redeemableBacking moved");
        assertEq(shapes.renderer(), before.renderer, "renderer moved");
        assertEq(shapes.admin(), before.admin, "admin moved");
    }

    function _mint(address to, uint8 denomIndex) private returns (uint256 id) {
        uint256 amount = Denominations.amountAt(denomIndex);
        uint256 value = amount + shapes.mintFee();
        vm.prank(to);
        id = shapes.mint{value: value}(amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {AuditBase} from "./AuditBase.sol";
import {Shapes} from "../../src/Shapes.sol";
import {ShapeCollection} from "../../src/ShapeCollection.sol";
import {ShapeRenderer} from "../../src/ShapeRenderer.sol";
import {IAdminControl} from "../../src/interfaces/IAdminControl.sol";
import {IShapeCollection} from "../../src/interfaces/IShapeCollection.sol";
import {IShapeRenderer, SplitProvenance} from "../../src/interfaces/IShapeRenderer.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice Required adversarial attempt 8: attack the presentation lock's ordering. Set a new
///         collection after locking, edit the copy after locking, and install a renderer that
///         reverts or returns oversized data.
contract PresentationLockOrderingTest is AuditBase {
    /// @notice After `lockPresentation`, both pointers and the collection's copy are frozen.
    function test_LockFreezesBothPointersAndTheCopy() public {
        ShapeRenderer other = new ShapeRenderer();
        ShapeCollection otherCollection = new ShapeCollection(other, shapes);

        shapes.lockPresentation();
        assertTrue(shapes.presentationLocked(), "lock did not take");

        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setRenderer(address(other));

        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setCollection(address(otherCollection));

        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        collection.setMetadataCopy("Hacked ", "hacked");

        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.lockPresentation();

        // The copy is read live from the collection, so the frozen values still render.
        assertEq(collection.tokenNamePrefix(), "Shape ", "the copy moved");
        assertGt(bytes(shapes.tokenURI(0)).length, 500, "metadata broke after the lock");
    }

    /// @notice The collection reads the lock live from `Shapes`, so it cannot be edited through a
    ///         stale cached flag, and a non-admin cannot edit it before the lock either.
    function test_CopyGateReadsTheLockLiveAndTheAdminLive() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice));
        collection.setMetadataCopy("Nope ", "nope");

        // Handing the admin role over moves the copy right with it, immediately.
        shapes.transferAdmin(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        collection.setMetadataCopy("Nope ", "nope");

        vm.prank(alice);
        collection.setMetadataCopy("Piece ", "a description");
        assertEq(collection.tokenNamePrefix(), "Piece ", "copy edit did not land");

        vm.prank(alice);
        shapes.lockPresentation();

        vm.prank(alice);
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        collection.setMetadataCopy("After ", "after");
    }

    /// @notice `setCollection` refuses a collection not bound to this token, so a rogue collection
    ///         whose copy is mutable by someone other than the token's admin can never be installed
    ///         in the first place, before or after the lock. Fixed at 887497c
    ///         (`AdminOps.requireCollection` checks `IShapeCollection(newCollection).shapes() ==
    ///         address(this)`).
    function test_SetCollectionRejectsACollectionBoundToADifferentShapes() public {
        RogueCollection rogue = new RogueCollection();

        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(rogue)));
        shapes.setCollection(address(rogue));

        // The canonical collection is unaffected and still installed.
        assertEq(shapes.collection(), address(collection), "collection pointer moved");

        // Backing, redemption and ownership are untouched by any of it.
        uint256 id = _mint(bob, DENOMS[1]);
        uint256 before = bob.balance;
        vm.prank(bob);
        shapes.redeem(id);
        assertEq(bob.balance, before + DENOMS[1], "presentation reached the reserve");
        _assertReserveInvariant();
    }

    /// @notice A renderer that reverts is installable (it answers ERC-165) and, once locked in,
    ///         breaks `tokenURI` permanently. Nothing about backing or ownership changes.
    function test_RevertingRendererBricksMetadataOnlyAndIsPermanentOnceLocked() public {
        RevertingRenderer bad = new RevertingRenderer();
        shapes.setRenderer(address(bad));

        vm.expectRevert();
        shapes.tokenURI(0);
        vm.expectRevert();
        shapes.unicodeCard(0);

        // Before the lock the admin can walk it back.
        shapes.setRenderer(address(renderer));
        assertGt(bytes(shapes.tokenURI(0)).length, 500, "recovery failed");

        // After the lock it cannot.
        shapes.setRenderer(address(bad));
        shapes.lockPresentation();
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setRenderer(address(renderer));
        vm.expectRevert();
        shapes.tokenURI(0);

        // Redemption still pays exactly the backing.
        uint256 id = _mint(alice, DENOMS[2]);
        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, before + DENOMS[2], "a broken renderer reached the reserve");
        _assertReserveInvariant();
    }

    /// @notice A renderer that returns an enormous string cannot be used to reach anything: it
    ///         costs the reader gas and nothing else.
    function test_OversizedRendererOutputCostsTheReaderOnly() public {
        HugeRenderer huge = new HugeRenderer();
        shapes.setRenderer(address(huge));

        uint256 len = bytes(shapes.tokenURI(0)).length;
        assertGt(len, 100_000, "the renderer did not return oversized output");

        uint256 id = _mint(alice, DENOMS[0]);
        uint256 before = alice.balance;
        vm.prank(alice);
        shapes.redeem(id);
        assertEq(alice.balance, before + DENOMS[0], "an oversized renderer reached the reserve");
        _assertReserveInvariant();
    }

    /// @notice `lockPresentation` does not require a collection, so locking before
    ///         `setCollection` freezes `tokenURI` and `contractURI` in their reverting state
    ///         permanently. Every value path keeps working.
    /// @notice `lockPresentation` itself refuses to run while the collection pointer is zero, so
    ///         metadata can no longer be bricked by locking before `setCollection`. Fixed at
    ///         887497c (`AdminOps.lockPresentation` reverts `CollectionNotSet` first).
    function test_LockingBeforeSetCollectionRevertsCollectionNotSet() public {
        ShapeRenderer r = new ShapeRenderer();
        Shapes fresh = new Shapes{value: Denominations.amountAt(0)}(0, feeRecipient, address(r), 0);
        ShapeCollection c = new ShapeCollection(r, fresh);

        assertEq(fresh.collection(), address(0), "collection should start empty");

        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.lockPresentation();
        assertFalse(fresh.presentationLocked(), "lock took despite the missing collection");

        // Metadata reverts, matching the still-unset collection, but the token remains lockable
        // and configurable once a collection is installed.
        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.tokenURI(0);
        vm.expectRevert(IShapes.CollectionNotSet.selector);
        fresh.contractURI();

        fresh.setCollection(address(c));
        assertGt(bytes(fresh.tokenURI(0)).length, 500, "metadata did not recover once collection was set");

        fresh.lockPresentation();
        assertTrue(fresh.presentationLocked(), "lock did not take once a collection was set");

        // Backing is untouched: the token still redeems for exactly its denomination.
        uint256 before = bob.balance;
        fresh.redeemTo(0, payable(bob));
        assertEq(bob.balance, before + Denominations.amountAt(0), "backing was affected");
        assertEq(fresh.redeemableBacking(), 0, "reserve wrong");
    }

    /// @notice A pointer target that is not a renderer or not a collection is refused, so the
    ///         admin cannot install an arbitrary address behind either.
    function test_UnsupportedPresentationTargetsAreRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(this)));
        shapes.setRenderer(address(this));
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(0)));
        shapes.setRenderer(address(0));

        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(this)));
        shapes.setCollection(address(this));
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedCollection.selector, address(0)));
        shapes.setCollection(address(0));
    }
}

/// @dev A collection that answers `IShapeCollection` but gates its copy on its own rule instead of
///      the token's lock.
contract RogueCollection is IERC165 {
    string private _prefix = "Rogue0 ";
    string private _description = "rogue";

    function setCopy(string calldata p, string calldata d) external {
        _prefix = p;
        _description = d;
    }

    /// @dev Bound to an unrelated address, never the `Shapes` under test, so `requireCollection`
    ///      rejects it.
    function shapes() external pure returns (address) {
        return address(0xBEEF);
    }

    function tokenNamePrefix() external view returns (string memory) {
        return _prefix;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function contractURI(string calldata, string calldata) external pure returns (string memory) {
        return "data:application/json;base64,e30=";
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IShapeCollection).interfaceId;
    }
}

/// @dev Answers ERC-165 for `IShapeRenderer` and reverts on every render call.
contract RevertingRenderer is IERC165 {
    error RendererIsHostile();

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IShapeRenderer).interfaceId;
    }

    fallback() external {
        revert RendererIsHostile();
    }
}

/// @dev Answers ERC-165 for `IShapeRenderer` and returns a very long string from every render
///      call.
contract HugeRenderer is IERC165 {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IShapeRenderer).interfaceId;
    }

    fallback() external {
        uint256 n = 200_000;
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, 0x20)
            mstore(add(free, 0x20), n)
            let end := add(add(free, 0x40), n)
            mstore(0x40, end)
            return(free, sub(end, free))
        }
    }
}

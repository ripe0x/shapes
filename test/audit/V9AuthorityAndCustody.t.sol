// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AuditBase} from "./AuditBase.sol";
import {IAdminControl} from "../../src/interfaces/IAdminControl.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {Shapes} from "../../src/Shapes.sol";
import {ShapeCollection} from "../../src/ShapeCollection.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice v9: authority separation, self-custody, the artist attestation, and the record reads
///         that skip `_requireOwned`.
contract V9AuthorityAndCustodyTest is AuditBase {
    /// @notice Holding the owner token grants nothing. Every admin entrypoint refuses its holder.
    function test_OwnerTokenGrantsNoAuthority() public {
        shapes.transferFrom(address(this), alice, 0);
        assertEq(shapes.owner(), alice);

        bytes memory err = abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        shapes.transferAdmin(alice);
        vm.expectRevert(err);
        shapes.renounceAdmin();
        vm.expectRevert(err);
        shapes.setFeeRecipient(alice);
        vm.expectRevert(err);
        shapes.setMintFee(0);
        vm.expectRevert(err);
        shapes.setRenderer(address(renderer));
        vm.expectRevert(err);
        shapes.setCollection(address(collection));
        vm.expectRevert(err);
        shapes.lockPresentation();
        vm.expectRevert(err);
        shapes.refreshMetadata();
        vm.expectRevert(err);
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(0));
        vm.expectRevert(err);
        shapes.lockPointer(uint8(IShapes.Pointer.Market));
        vm.expectRevert(err);
        collection.setMetadataCopy("a ", "b", "c");
        vm.stopPrank();

        // And the admin has no reach into backing or token ownership.
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, uint256(0), address(this)));
        shapes.redeem(0);
    }

    /// @notice No path leaves a Shape owned by `Shapes` itself, on the safe or the plain path.
    function test_SelfCustodyIsRefusedEverywhere() public {
        uint256 id = _mint(alice, DENOMS[1]);
        bytes memory err = abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, id);

        vm.prank(alice);
        vm.expectRevert(err);
        shapes.transferFrom(alice, address(shapes), id);

        vm.prank(alice);
        vm.expectRevert(err);
        shapes.safeTransferFrom(alice, address(shapes), id);

        // The mint path.
        bytes memory nextIdErr =
            abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, shapes.totalMinted());
        vm.prank(alice);
        vm.expectRevert(nextIdErr);
        shapes.mintTo{value: DENOMS[0] + MINT_FEE}(DENOMS[0], address(shapes));

        // The split path.
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        vm.expectRevert(nextIdErr);
        shapes.splitTo(id, outs, address(shapes));

        // The decompose path.
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, burnIds);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SelfCustodyRejected.selector, burnIds[0]));
        shapes.decomposeTo(survivor, address(shapes));

        _assertReserveInvariant();
    }

    /// @notice One attestation per contract, relayable by anyone, bound to this contract, never
    ///         replaceable.
    function test_ArtistAttestationIsOneShotAndBound() public {
        (address artistAddr, uint256 pk) = makeAddrAndKey("artist");
        Shapes token;
        Shapes twin;
        vm.startPrank(artistAddr);
        vm.deal(artistAddr, 10 ether);
        token = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(renderer), 0);
        twin = new Shapes{value: Denominations.amountAt(0)}(MINT_FEE, feeRecipient, address(renderer), 0);
        vm.stopPrank();

        bytes32 releaseHash = keccak256("release");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, token.artistAttestationDigest(releaseHash));
        bytes memory sig = abi.encodePacked(r, s, v);

        // A signature for one deployment does not carry to another.
        vm.prank(bob);
        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        twin.attestArtist(releaseHash, sig);

        // An unrelated hash is refused, and zero is refused.
        vm.prank(bob);
        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        token.attestArtist(keccak256("other"), sig);
        vm.prank(bob);
        vm.expectRevert(IShapes.InvalidArtistReleaseHash.selector);
        token.attestArtist(bytes32(0), sig);

        // Anyone may relay the artist's own signature, once.
        vm.prank(bob);
        token.attestArtist(releaseHash, sig);
        assertEq(token.artistReleaseHash(), releaseHash);
        assertEq(token.artistSignature(), sig);

        (v, r, s) = vm.sign(pk, token.artistAttestationDigest(keccak256("second")));
        vm.prank(bob);
        vm.expectRevert(IShapes.ArtistAlreadyAttested.selector);
        token.attestArtist(keccak256("second"), abi.encodePacked(r, s, v));
    }

    /// @notice `composeDepth`, `composeRecordAt` and `splitOriginOf` answer for ids that no longer
    ///         exist: they read the record stacks, not the token. Read-only and by design, but an
    ///         integrator must not treat a nonzero answer as proof the token is live.
    function test_RecordReadsAnswerForDeadIds() public {
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, burnIds);
        vm.prank(alice);
        shapes.redeem(survivor);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, survivor));
        shapes.ownerOf(survivor);

        assertEq(shapes.composeDepth(survivor), 1, "the record outlived the token");
        assertEq(shapes.composeRecordAt(survivor, 0).inputs.length, 4);
        _assertReserveInvariant();
    }

    /// @notice `renounceAdmin` before `lockPresentation` leaves presentation permanently unlocked
    ///         and permanently unchangeable, which is a different end state from a locked one.
    function test_RenounceAdminFreezesPresentationWithoutLockingIt() public {
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0));
        assertFalse(shapes.presentationLocked());

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.lockPresentation();
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        collection.setMetadataCopy("a ", "b", "c");
    }
}

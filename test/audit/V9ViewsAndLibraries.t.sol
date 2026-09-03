// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AuditBase} from "./AuditBase.sol";
import {IShapeGeometry} from "../../src/interfaces/IShapeGeometry.sol";
import {AdminOps} from "../../src/lib/AdminOps.sol";
import {CopyValidation} from "../../src/lib/CopyValidation.sol";
import {EIP712Signature} from "../../src/lib/EIP712Signature.sol";
import {GeometrySampling} from "../../src/lib/GeometrySampling.sol";
import {ModuleCodec} from "../../src/lib/ModuleCodec.sol";
import {RecompositionOps} from "../../src/lib/RecompositionOps.sol";

/// @notice v9: the five token-id render views, and attempt 7 (library isolation) extended to
///         every public library the deployment links, not just the two the earlier suite covers.
contract V9ViewsAndLibrariesTest is AuditBase {
    /* ------------------------------------------------------------------ */
    /*  the five token-id views                                            */
    /* ------------------------------------------------------------------ */

    /// @notice Every token-id view refuses an id that does not exist, which is the `_requireOwned`
    ///         gate. A burned id and a never-minted id are both covered.
    function test_EveryTokenIdViewRequiresTheTokenToExist() public {
        uint256 id = _mint(alice, DENOMS[0]);
        vm.prank(alice);
        shapes.redeem(id);

        uint256[2] memory gone = [id, uint256(999_999)];
        for (uint256 i = 0; i < 2; ++i) {
            uint256 t = gone[i];
            bytes memory err = abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, t);
            vm.expectRevert(err);
            shapes.svg(t);
            vm.expectRevert(err);
            shapes.metadataJSON(t);
            vm.expectRevert(err);
            shapes.geometryOf(t);
            vm.expectRevert(err);
            shapes.effectiveModulesOf(t);
            vm.expectRevert(err);
            shapes.moduleAt(t, 0);
            vm.expectRevert(err);
            shapes.tokenURI(t);
            vm.expectRevert(err);
            shapes.unicodeCard(t);
        }
    }

    /// @notice The views write nothing: a full state snapshot is identical across a call to each.
    function test_TokenIdViewsWriteNothing() public {
        uint256 id = _mint(alice, DENOMS[4]);
        bytes32 stateBefore = _stateFingerprint(id);

        shapes.svg(id);
        shapes.metadataJSON(id);
        shapes.geometryOf(id);
        shapes.effectiveModulesOf(id);
        shapes.moduleAt(id, 0);
        shapes.unicodeCard(id);
        string memory uriBefore = shapes.tokenURI(id);

        assertEq(_stateFingerprint(id), stateBefore, "a view moved state");
        assertEq(shapes.tokenURI(id), uriBefore, "tokenURI changed after the other views ran");
    }

    /// @notice `effectiveModulesOf` matches what the renderer actually draws, on both branches:
    ///         a seed-derived original mint and a materialized compose survivor.
    function test_EffectiveModulesMatchWhatTheRendererDraws() public {
        uint256 direct = _mint(alice, DENOMS[1]);
        _assertModulesMatchRenderer(direct, "grammar v1 branch");

        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, burnIds);
        assertGt(shapes.modulesOf(survivor).length, 0, "the survivor is materialized");
        _assertModulesMatchRenderer(survivor, "sampled branch");

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(survivor, outs);
        _assertModulesMatchRenderer(kids[0], "split child");
    }

    function _assertModulesMatchRenderer(uint256 id, string memory what) internal view {
        bytes memory effective = shapes.effectiveModulesOf(id);
        (,, uint256 moduleCount) = shapes.geometryOf(id);
        assertEq(effective.length, moduleCount, string.concat(what, ": module count"));

        for (uint256 i = 0; i < moduleCount; ++i) {
            (uint8 kind, bool solid, uint16 rotation,,,,) = shapes.moduleAt(id, i);
            (uint256 ck, bool cs, uint256 cr) = ModuleCodec.decode(effective[i]);
            assertEq(uint256(kind), ck, string.concat(what, ": kind"));
            assertEq(solid, cs, string.concat(what, ": solid"));
            assertEq(uint256(rotation), cr * 90, string.concat(what, ": rotation"));
        }
    }

    /// @notice `geometryOf` forwards to the renderer's `IShapeGeometry` face, and `setRenderer`
    ///         refuses a renderer that does not answer for that interface, so this view cannot be
    ///         left pointing at something that does not implement it.
    function test_SetRendererRequiresBothRendererAndGeometryInterfaces() public {
        LiarERC165 rendererOnly = new LiarERC165(true, false, address(shapes));
        vm.expectRevert();
        shapes.setRenderer(address(rendererOnly));

        LiarERC165 geometryOnly = new LiarERC165(false, true, address(shapes));
        vm.expectRevert();
        shapes.setRenderer(address(geometryOnly));
    }

    /* ------------------------------------------------------------------ */
    /*  attempt 7: library isolation, extended                             */
    /* ------------------------------------------------------------------ */

    /// @notice A direct `CALL` to every public function of every linked library, with a storage
    ///         pointer argument aimed at the slots `Shapes` uses, leaves `Shapes` untouched.
    /// @dev `GeometrySampling`, `CopyValidation` and `EIP712Signature` carry NO call protection:
    ///      solc emits it only for libraries with a non-view, non-pure external function. The
    ///      protection is therefore not what makes them safe. What makes them safe is that they
    ///      take no storage pointer and write nothing, so a direct call has nothing to reach.
    function test_Attempt7_DirectCallsToEveryLinkedLibrary() public {
        uint256 id = _mint(alice, DENOMS[1]);
        bytes32 before = _stateFingerprint(id);

        // GeometrySampling: every public function is pure and takes only value arguments.
        (bool ok,) = address(GeometrySampling)
            .call(
                abi.encodeWithSelector(
                    GeometrySampling.effectiveModulesOf.selector,
                    bytes(""),
                    bytes32(uint256(1)),
                    uint8(0),
                    uint8(0)
                )
            );
        assertTrue(ok, "a pure library function answers a direct CALL, as expected");

        // Aim the same call at slot numbers instead of values: an ABI decode of a `bytes` head
        // pointing at a storage slot number is meaningless here, and cannot reach Shapes.
        (ok,) = address(GeometrySampling)
            .call(abi.encodeWithSelector(GeometrySampling.sortDonorsById.selector, uint256(6)));
        assertFalse(ok, "a malformed direct call reverts in the decoder");

        (ok,) = address(CopyValidation)
            .call(abi.encodeWithSelector(CopyValidation.requireJsonSafe.selector, "x", uint256(64), uint8(0)));
        assertTrue(ok, "CopyValidation is pure and unprotected, and has nothing to reach");

        (ok,) = address(EIP712Signature)
            .call(
                abi.encodeWithSelector(
                    EIP712Signature.artistDigest.selector, address(this), bytes32(uint256(1))
                )
            );
        assertTrue(ok, "EIP712Signature is view and unprotected, and has nothing to reach");

        // The two libraries that DO write are call-protected.
        (ok,) = address(RecompositionOps)
            .call(
                abi.encodeWithSelector(
                    bytes4(keccak256("decompose(ShapeStore storage,uint256)")), uint256(6), id
                )
            );
        assertFalse(ok, "RecompositionOps.decompose answered a direct CALL");

        (ok,) = address(AdminOps)
            .call(
                abi.encodeWithSelector(
                    bytes4(keccak256("setMintFee(AdminOps.FeeConfig storage,uint256)")),
                    uint256(16),
                    uint256(0)
                )
            );
        assertFalse(ok, "AdminOps.setMintFee answered a direct CALL");

        assertEq(_stateFingerprint(id), before, "a direct library call moved Shapes state");
        _assertReserveInvariant();
    }

    /// @notice The EIP-712 digest is bound to the token address even though `EIP712Signature` is
    ///         an externally linked library: solc reaches a linked library with `DELEGATECALL`
    ///         even from a `view` caller, so `address(this)` inside it is `Shapes`.
    function test_ArtistDigestIsBoundToTheTokenNotTheLibrary() public view {
        bytes32 h = keccak256("release-v9");
        bytes32 fromToken = shapes.artistAttestationDigest(h);
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Shapes Artist Attribution"),
                keccak256("1"),
                block.chainid,
                address(shapes)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ArtistAttribution(address shapes,address artist,bytes32 releaseHash)"),
                address(shapes),
                shapes.artist(),
                h
            )
        );
        assertEq(
            fromToken,
            keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash)),
            "the digest is not bound to the token address"
        );
    }

    /* ------------------------------ helpers ------------------------------ */

    function _stateFingerprint(uint256 id) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                shapes.totalSupply(),
                shapes.totalMinted(),
                shapes.redeemableBacking(),
                shapes.burnedBacking(),
                shapes.blackShapeCount(),
                shapes.pendingFees(),
                shapes.admin(),
                shapes.renderer(),
                shapes.collection(),
                shapes.presentationLocked(),
                shapes.mintFee(),
                shapes.feeRecipient(),
                shapes.owner(),
                shapes.ownerOf(id),
                shapes.seedOf(id),
                shapes.denomIndexOf(id),
                shapes.originCountOf(id),
                shapes.inkGeneOf(id),
                shapes.modulesOf(id),
                address(shapes).balance
            )
        );
    }
}

/// @notice Answers ERC-165 selectively, so `setRenderer`'s two-interface requirement can be
///         probed one interface at a time.
contract LiarERC165 {
    bool private immutable _renderer;
    bool private immutable _geometry;
    address private immutable _shapes;

    constructor(bool renderer_, bool geometry_, address shapes_) {
        _renderer = renderer_;
        _geometry = geometry_;
        _shapes = shapes_;
    }

    function shapes() external view returns (address) {
        return _shapes;
    }

    function supportsInterface(bytes4 id) external view returns (bool) {
        if (id == type(IShapeGeometry).interfaceId) return _geometry;
        return _renderer;
    }
}

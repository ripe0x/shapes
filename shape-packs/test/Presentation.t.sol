// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

import {IShapes} from "shapes/interfaces/IShapes.sol";
import {IERC721Value} from "shapes/interfaces/IERC721Value.sol";
import {FixedPoint} from "shapes/lib/FixedPoint.sol";

import {ShapePacks} from "../src/ShapePacks.sol";
import {ShapePackRenderer} from "../src/ShapePackRenderer.sol";
import {IShapePacks} from "../src/interfaces/IShapePacks.sol";
import {IShapePackRenderer, PackRenderInput} from "../src/interfaces/IShapePackRenderer.sol";
import {MetadataHelpers} from "./Metadata.t.sol";

/// @dev A minimal renderer that answers ERC-165 and returns strings built from the input it is
///      handed, to prove `ShapePacks` routes `tokenURI` and `contractURI` through whatever
///      renderer is set, and passes the input it gathers.
contract StubPackRenderer is IShapePackRenderer, IERC165 {
    function shapes() external pure returns (address) {
        return address(0);
    }

    function tokenURI(PackRenderInput calldata input) external pure returns (string memory) {
        return string.concat(
            "stub:",
            FixedPoint.toString(input.packId),
            ":",
            FixedPoint.toString(input.shapeCount),
            ":",
            FixedPoint.toString(input.valueWei),
            ":",
            input.tokenNamePrefix,
            ":",
            input.description
        );
    }

    function metadataJSON(PackRenderInput calldata) external pure returns (string memory) {
        return "stub-json";
    }

    function image(PackRenderInput calldata) external pure returns (string memory) {
        return "stub-image";
    }

    function contractURI(string calldata name, string calldata description, bytes32)
        external
        pure
        returns (string memory)
    {
        return string.concat("stub-contract:", name, ":", description);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IShapePackRenderer).interfaceId;
    }
}

/// @dev Answers ERC-165 but claims nothing.
contract FalseSupport is IERC165 {
    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
}

/// @dev Answers `true` to every interface id. The renderer check is only as strong as the answer,
///      so this is accepted: the guard stops typos, it does not prove a contract is a renderer.
contract PermissiveSupport is IERC165 {
    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @dev A contract with code whose fallback succeeds with no return data.
contract SilentContract {
    fallback() external {}
}

contract PresentationTest is MetadataHelpers {
    StubPackRenderer internal stub;

    function setUp() public override {
        super.setUp();
        stub = new StubPackRenderer();
    }

    /* ---------------------------- helpers ---------------------------- */

    function _repeat(bytes1 c, uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            b[i] = c;
        }
        return string(b);
    }

    function _bytes(bytes1 c) internal pure returns (string memory) {
        return string(abi.encodePacked(c));
    }

    function _pack() internal returns (uint256) {
        return createFor(alice, noIds(), mintsOf(0, 3));
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(packs) && logs[i].topics.length > 0 && logs[i].topics[0] == topic0)
            {
                ++n;
            }
        }
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IShapePacks.AdminUnauthorizedAccount.selector, who);
    }

    function _invalidCopy(uint8 field) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IShapePacks.InvalidCopy.selector, field);
    }

    /// @dev Every admin function, called by `who`; each must revert with `err`.
    function _everyAdminFunctionReverts(address who, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(who);
        packs.transferAdmin(bob);

        vm.expectRevert(err);
        vm.prank(who);
        packs.renounceAdmin();

        vm.expectRevert(err);
        vm.prank(who);
        packs.setRenderer(address(stub));

        vm.expectRevert(err);
        vm.prank(who);
        packs.setMetadataCopy("x", "y");

        vm.expectRevert(err);
        vm.prank(who);
        packs.lockPresentation();
    }

    /* ------------------------------ defaults ------------------------------ */

    function test_Defaults() public view {
        assertEq(packs.admin(), admin);
        assertEq(packs.renderer(), address(packRenderer));
        assertEq(packs.shapes(), address(shapes));
        assertFalse(packs.presentationLocked());
        assertEq(packs.name(), "Shape Packs");
        assertEq(packs.symbol(), "PACK");
        assertEq(packs.tokenNamePrefix(), "Shape Pack ");
        assertGt(bytes(packs.description()).length, 0);
        assertEq(packs.totalMinted(), 0);
        assertEq(packs.totalSupply(), 0);
    }

    function test_SupportsInterface() public view {
        assertTrue(packs.supportsInterface(type(IERC165).interfaceId));
        assertTrue(packs.supportsInterface(type(IERC721).interfaceId));
        assertTrue(packs.supportsInterface(type(IERC721Metadata).interfaceId));
        assertTrue(packs.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(packs.supportsInterface(bytes4(0x49064906)), "ERC-4906");
        assertTrue(packs.supportsInterface(type(IERC721Value).interfaceId));
        assertTrue(packs.supportsInterface(type(IShapePacks).interfaceId));
        assertFalse(packs.supportsInterface(0xffffffff));
        assertFalse(packs.supportsInterface(0x12345678));
        assertFalse(packs.supportsInterface(type(IShapePackRenderer).interfaceId));
    }

    function test_RoyaltyIsZero() public {
        uint256 packId = _pack();
        (address receiver, uint256 amount) = packs.royaltyInfo(packId, 1 ether);
        assertEq(receiver, address(0));
        assertEq(amount, 0);
    }

    /* ------------------------------ constructor ------------------------------ */

    function test_ConstructorEmitsAdminTransferred() public {
        vm.expectEmit(true, true, false, false);
        emit IShapePacks.AdminTransferred(address(0), admin);
        ShapePacks fresh = new ShapePacks(address(shapes), address(packRenderer), admin);
        assertEq(fresh.admin(), admin);
    }

    function test_ConstructorRejectsZeroAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.AdminInvalidAdmin.selector, address(0)));
        new ShapePacks(address(shapes), address(packRenderer), address(0));
    }

    function test_ConstructorRejectsRendererWithoutCode() public {
        address eoa = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, eoa));
        new ShapePacks(address(shapes), eoa, admin);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(0)));
        new ShapePacks(address(shapes), address(0), admin);
    }

    function test_ConstructorRejectsRendererThatDoesNotAnswerErc165() public {
        // The test contract has code and no `supportsInterface`.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(this)));
        new ShapePacks(address(shapes), address(this), admin);

        // A real ERC-165 contract that is not a pack renderer.
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(shapes)));
        new ShapePacks(address(shapes), address(shapes), admin);

        FalseSupport no = new FalseSupport();
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(no)));
        new ShapePacks(address(shapes), address(no), admin);
    }

    function test_ConstructorRejectsShapesWithoutCode() public {
        address eoa = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(ShapePacks.UnsupportedShapes.selector, eoa));
        new ShapePacks(eoa, address(packRenderer), admin);

        vm.expectRevert(abi.encodeWithSelector(ShapePacks.UnsupportedShapes.selector, address(0)));
        new ShapePacks(address(0), address(packRenderer), admin);
    }

    function test_ConstructorRejectsShapesThatIsNotShapes() public {
        // No ERC-165 at all.
        vm.expectRevert(abi.encodeWithSelector(ShapePacks.UnsupportedShapes.selector, address(this)));
        new ShapePacks(address(this), address(packRenderer), admin);

        // ERC-165 that does not claim `IShapes`: the pack renderer, and the stub.
        vm.expectRevert(abi.encodeWithSelector(ShapePacks.UnsupportedShapes.selector, address(packRenderer)));
        new ShapePacks(address(packRenderer), address(packRenderer), admin);

        FalseSupport no = new FalseSupport();
        vm.expectRevert(abi.encodeWithSelector(ShapePacks.UnsupportedShapes.selector, address(no)));
        new ShapePacks(address(no), address(packRenderer), admin);
    }

    function test_ConstructorChecksShapesBeforeRendererBeforeAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(ShapePacks.UnsupportedShapes.selector, address(0xBEEF)));
        new ShapePacks(address(0xBEEF), address(0xCAFE), address(0));

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(0xCAFE)));
        new ShapePacks(address(shapes), address(0xCAFE), address(0));
    }

    function test_MinPackValueIsThreeUnits() public {
        assertEq(packs.MIN_PACK_VALUE(), 3 * shapes.unit());
        assertEq(packs.MIN_PACK_VALUE(), 3 * unit());
        if (unit() == 0.01 ether) assertEq(packs.MIN_PACK_VALUE(), 0.03 ether);
        // Read from Shapes at construction, so a fresh deployment agrees.
        ShapePacks fresh = new ShapePacks(address(shapes), address(packRenderer), admin);
        assertEq(fresh.MIN_PACK_VALUE(), 3 * IShapes(address(shapes)).unit());
    }

    /* ------------------------------ admin transfer ------------------------------ */

    function test_TransferAdminOnlyAdmin() public {
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.transferAdmin(bob);

        // The test contract (Shapes' admin) has no authority here either.
        vm.expectRevert(_unauthorized(address(this)));
        packs.transferAdmin(bob);
        assertEq(packs.admin(), admin);
    }

    function test_TransferAdminRejectsZero() public {
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.AdminInvalidAdmin.selector, address(0)));
        vm.prank(admin);
        packs.transferAdmin(address(0));
        assertEq(packs.admin(), admin);
    }

    function test_TransferAdminEmitsAndMovesAuthority() public {
        vm.expectEmit(true, true, false, false, address(packs));
        emit IShapePacks.AdminTransferred(admin, bob);
        vm.prank(admin);
        packs.transferAdmin(bob);
        assertEq(packs.admin(), bob);

        // The previous admin is out; the new one is in.
        _everyAdminFunctionReverts(admin, _unauthorized(admin));
        vm.prank(bob);
        packs.setMetadataCopy("Bob Pack ", "Bob's copy.");
        assertEq(packs.tokenNamePrefix(), "Bob Pack ");
    }

    function test_TransferAdminToSelfIsAllowed() public {
        vm.expectEmit(true, true, false, false, address(packs));
        emit IShapePacks.AdminTransferred(admin, admin);
        vm.prank(admin);
        packs.transferAdmin(admin);
        assertEq(packs.admin(), admin);
    }

    function test_RenounceAdmin() public {
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.renounceAdmin();

        vm.expectEmit(true, true, false, false, address(packs));
        emit IShapePacks.AdminTransferred(admin, address(0));
        vm.prank(admin);
        packs.renounceAdmin();
        assertEq(packs.admin(), address(0));

        // Every admin function is dead, for the former admin and everyone else.
        _everyAdminFunctionReverts(admin, _unauthorized(admin));
        _everyAdminFunctionReverts(bob, _unauthorized(bob));

        // Presentation as it stood keeps working.
        uint256 packId = _pack();
        assertTrue(startsWith(packs.tokenURI(packId), JSON_PREFIX));
        assertGt(bytes(packs.contractURI()).length, 0);
    }

    function test_RenounceAfterLockStillWorks() public {
        vm.startPrank(admin);
        packs.lockPresentation();
        packs.renounceAdmin();
        vm.stopPrank();
        assertEq(packs.admin(), address(0));
        assertTrue(packs.presentationLocked());
    }

    /* ------------------------------ setRenderer ------------------------------ */

    function test_SetRendererNonAdminReverts() public {
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.setRenderer(address(stub));
        assertEq(packs.renderer(), address(packRenderer));
    }

    function test_SetRendererRejectsEoa() public {
        address eoa = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, eoa));
        vm.prank(admin);
        packs.setRenderer(eoa);

        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(0)));
        vm.prank(admin);
        packs.setRenderer(address(0));
        assertEq(packs.renderer(), address(packRenderer));
    }

    function test_SetRendererRejectsContractsThatDoNotClaimTheInterface() public {
        FalseSupport no = new FalseSupport();
        address[4] memory bad = [address(this), address(shapes), address(no), address(packs)];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, bad[i]));
            vm.prank(admin);
            packs.setRenderer(bad[i]);
        }
        assertEq(packs.renderer(), address(packRenderer));
    }

    function test_SetRendererRejectsContractThatReturnsNothing() public {
        // A fallback that succeeds with no data cannot answer ERC-165. The call reverts (the ABI
        // decode of an empty return fails), so the renderer is never replaced.
        SilentContract silent = new SilentContract();
        vm.expectRevert();
        vm.prank(admin);
        packs.setRenderer(address(silent));
        assertEq(packs.renderer(), address(packRenderer));
    }

    function test_SetRendererAcceptsFreshRendererAndSignals() public {
        _pack();
        _pack();
        assertEq(packs.totalMinted(), 2);

        ShapePackRenderer fresh = new ShapePackRenderer(address(shapes));

        vm.expectEmit(true, false, false, false, address(packs));
        emit IShapePacks.RendererUpdated(address(fresh));
        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.BatchMetadataUpdate(1, 2);
        vm.expectEmit(false, false, false, false, address(packs));
        emit IShapePacks.ContractURIUpdated();
        vm.prank(admin);
        packs.setRenderer(address(fresh));

        assertEq(packs.renderer(), address(fresh));
        // Same code, same art: the swap changes nothing observable here but still works.
        assertTrue(startsWith(packs.tokenURI(1), JSON_PREFIX));
    }

    function test_SetRendererSignalsOnlyWhatExists() public {
        // No packs: RendererUpdated and ContractURIUpdated, but no ERC-4906 batch (a range
        // `1..0` would be nonsense).
        ShapePackRenderer fresh = new ShapePackRenderer(address(shapes));
        vm.recordLogs();
        vm.prank(admin);
        packs.setRenderer(address(fresh));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, IShapePacks.RendererUpdated.selector), 1, "RendererUpdated");
        assertEq(_count(logs, IShapePacks.ContractURIUpdated.selector), 1, "ContractURIUpdated");
        assertEq(_count(logs, IShapePacks.BatchMetadataUpdate.selector), 0, "no batch update when no packs");
    }

    function test_SetRendererBatchRangeCoversEveryPackEverCreated() public {
        // The range is 1..totalMinted, not 1..totalSupply: ids are never reissued, so burned ids
        // stay inside it and a marketplace re-reads every id it ever indexed.
        uint256 a = _pack();
        _pack();
        _pack();
        vm.prank(alice);
        packs.redeem(a);
        assertEq(packs.totalSupply(), 2);
        assertEq(packs.totalMinted(), 3);

        ShapePackRenderer fresh = new ShapePackRenderer(address(shapes));
        vm.expectEmit(true, false, false, false, address(packs));
        emit IShapePacks.RendererUpdated(address(fresh));
        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.BatchMetadataUpdate(1, 3);
        vm.prank(admin);
        packs.setRenderer(address(fresh));
    }

    function test_SetRendererBatchEmittedEvenWhenEveryPackIsGone() public {
        uint256 a = _pack();
        vm.prank(alice);
        packs.redeem(a);
        assertEq(packs.totalSupply(), 0);
        assertEq(packs.totalMinted(), 1);
        vm.recordLogs();
        vm.prank(admin);
        packs.setRenderer(address(stub));
        assertEq(_count(vm.getRecordedLogs(), IShapePacks.BatchMetadataUpdate.selector), 1);
    }

    function test_TokenUriGoesThroughTheNewRenderer() public {
        uint256 packId = _pack();
        string memory before_ = packs.tokenURI(packId);
        assertTrue(startsWith(before_, JSON_PREFIX));

        vm.prank(admin);
        packs.setRenderer(address(stub));
        assertEq(packs.renderer(), address(stub));

        // The stub echoes what ShapePacks handed it: id, count, value, and the stored copy.
        string memory expected = string.concat(
            "stub:1:3:", FixedPoint.toString(3 * amountAt(0)), ":Shape Pack :", packs.description()
        );
        assertEq(packs.tokenURI(packId), expected);
        assertEq(packs.contractURI(), string.concat("stub-contract:Shape Packs:", packs.description()));

        // And back again.
        vm.prank(admin);
        packs.setRenderer(address(packRenderer));
        assertEq(packs.tokenURI(packId), before_);
    }

    function test_SetRendererRefusesAnAnswerThatLies() public {
        // A contract that answers `true` to every interface id, 0xffffffff included, is not
        // ERC-165 compliant, and `ERC165Checker` refuses it. The check is still only a typo
        // guard: a compliant renderer that renders badly is accepted, and the admin can replace it
        // until the lock, which is why the lock is the last step.
        PermissiveSupport liar = new PermissiveSupport();
        uint256 packId = _pack();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IShapePacks.UnsupportedRenderer.selector, address(liar)));
        packs.setRenderer(address(liar));
        assertEq(packs.renderer(), address(packRenderer));
        assertGt(bytes(packs.tokenURI(packId)).length, 0);
    }

    /* ------------------------------ setMetadataCopy ------------------------------ */

    function test_SetMetadataCopyNonAdminReverts() public {
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.setMetadataCopy("a", "b");
        assertEq(packs.tokenNamePrefix(), "Shape Pack ");
    }

    function test_SetMetadataCopyShowsInTokenUriAndViews() public {
        uint256 packId = _pack();
        string memory prefix = "Pack No. ";
        string memory desc = "A fresh description, with punctuation: (1) 'two' & <three> 100% ~!";

        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.MetadataCopySet(prefix, desc);
        vm.expectEmit(false, false, false, true, address(packs));
        emit IShapePacks.BatchMetadataUpdate(1, 1);
        vm.expectEmit(false, false, false, false, address(packs));
        emit IShapePacks.ContractURIUpdated();
        vm.prank(admin);
        packs.setMetadataCopy(prefix, desc);

        assertEq(packs.tokenNamePrefix(), prefix);
        assertEq(packs.description(), desc);

        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, '"name":"Pack No. 1"'), "name");
        assertTrue(
            contains(json, string.concat('"description":"', desc, " ", entry(3, 0), ". ")),
            "description then makeup"
        );
        assertFalse(contains(json, "Shape Pack 1"), "old name gone");

        string memory collectionJson = decodeJson(packs.contractURI());
        assertTrue(contains(collectionJson, string.concat('"description":"', desc, '"')));
        // The collection name is the ERC-721 name, not the token prefix.
        assertTrue(contains(collectionJson, '"name":"Shape Packs"'));
    }

    function test_SetMetadataCopyEmitsSignalsWithoutPacks() public {
        vm.recordLogs();
        vm.prank(admin);
        packs.setMetadataCopy("P ", "D");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, IShapePacks.MetadataCopySet.selector), 1);
        assertEq(_count(logs, IShapePacks.ContractURIUpdated.selector), 1);
        assertEq(_count(logs, IShapePacks.BatchMetadataUpdate.selector), 0);
    }

    function test_SetMetadataCopyAcceptsEmptyPrefix() public {
        uint256 packId = _pack();
        vm.prank(admin);
        packs.setMetadataCopy("", "Only a description.");
        assertEq(packs.tokenNamePrefix(), "");
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, '"name":"1"'), "name is just the id");
    }

    function test_SetMetadataCopyAcceptsEmptyDescription() public {
        uint256 packId = _pack();
        vm.prank(admin);
        packs.setMetadataCopy("Pack ", "");
        assertEq(packs.description(), "");
        string memory json = decodeJson(packs.tokenURI(packId));
        // The makeup follows an empty description after one separating space.
        assertTrue(contains(json, string.concat('"description":" ', entry(3, 0), ". ")));
    }

    function test_SetMetadataCopyBoundaryLengths() public {
        string memory p64 = _repeat("a", 64);
        string memory d2048 = _repeat("b", 2048);
        vm.prank(admin);
        packs.setMetadataCopy(p64, d2048);
        assertEq(bytes(packs.tokenNamePrefix()).length, 64);
        assertEq(bytes(packs.description()).length, 2048);

        // A pack still renders with the largest copy.
        uint256 packId = _pack();
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, string.concat('"name":"', p64, "1")));
        assertTrue(startsWith(svgOfJson(json), "<svg"));
    }

    function test_SetMetadataCopyPrefixTooLong() public {
        vm.expectRevert(_invalidCopy(0));
        vm.prank(admin);
        packs.setMetadataCopy(_repeat("a", 65), "ok");
    }

    function test_SetMetadataCopyDescriptionTooLong() public {
        vm.expectRevert(_invalidCopy(1));
        vm.prank(admin);
        packs.setMetadataCopy("ok", _repeat("b", 2049));
    }

    function test_SetMetadataCopyQuoteInPrefix() public {
        vm.expectRevert(_invalidCopy(0));
        vm.prank(admin);
        packs.setMetadataCopy('Pack "', "ok");
    }

    function test_SetMetadataCopyBackslashInPrefix() public {
        vm.expectRevert(_invalidCopy(0));
        vm.prank(admin);
        packs.setMetadataCopy("Pack \\", "ok");
    }

    function test_SetMetadataCopyQuoteInDescription() public {
        vm.expectRevert(_invalidCopy(1));
        vm.prank(admin);
        packs.setMetadataCopy("ok", 'say "hi"');
    }

    function test_SetMetadataCopyBackslashInDescription() public {
        vm.expectRevert(_invalidCopy(1));
        vm.prank(admin);
        packs.setMetadataCopy("ok", "a \\n b");
    }

    function test_SetMetadataCopyDelInEitherField() public {
        string memory del = string.concat("a", _bytes(0x7F), "b");
        vm.expectRevert(_invalidCopy(0));
        vm.prank(admin);
        packs.setMetadataCopy(del, "ok");

        vm.expectRevert(_invalidCopy(1));
        vm.prank(admin);
        packs.setMetadataCopy("ok", del);
    }

    function test_SetMetadataCopyControlByteInEitherField() public {
        // 0x19 is the highest control byte below the printable range; 0x00, 0x0A and 0x1F too.
        bytes1[4] memory controls = [bytes1(0x19), 0x00, 0x0A, 0x1F];
        for (uint256 i = 0; i < controls.length; ++i) {
            string memory bad = string.concat("a", _bytes(controls[i]), "b");
            vm.expectRevert(_invalidCopy(0));
            vm.prank(admin);
            packs.setMetadataCopy(bad, "ok");

            vm.expectRevert(_invalidCopy(1));
            vm.prank(admin);
            packs.setMetadataCopy("ok", bad);
        }
    }

    function test_SetMetadataCopyMultibyteUtf8InEitherField() public {
        // U+00E9 (2 bytes), U+20AC (3 bytes), U+263A (3 bytes): every byte is above 0x7E.
        string[3] memory wide = [unicode"café", unicode"€5", unicode"☺"];
        for (uint256 i = 0; i < wide.length; ++i) {
            vm.expectRevert(_invalidCopy(0));
            vm.prank(admin);
            packs.setMetadataCopy(wide[i], "ok");

            vm.expectRevert(_invalidCopy(1));
            vm.prank(admin);
            packs.setMetadataCopy("ok", wide[i]);
        }
    }

    function test_SetMetadataCopyAcceptsEveryPrintableByteExceptQuoteAndBackslash() public {
        bytes memory all = new bytes(0x7E - 0x20 + 1 - 2);
        uint256 n;
        for (uint256 c = 0x20; c <= 0x7E; ++c) {
            if (c == 0x22 || c == 0x5C) continue;
            all[n++] = bytes1(uint8(c));
        }
        bytes memory prefix = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            prefix[i] = all[i];
        }
        vm.prank(admin);
        packs.setMetadataCopy(string(prefix), string(all));

        // The JSON stays parseable around it: the document still decodes and still closes.
        uint256 packId = _pack();
        string memory json = decodeJson(packs.tokenURI(packId));
        assertTrue(contains(json, string.concat('"name":"', string(prefix), "1")));
        assertTrue(contains(json, string.concat('"description":"', string(all), " ")));
        assertTrue(endsWith(json, "]}"));
    }

    function test_SetMetadataCopyReportsPrefixFirstWhenBothInvalid() public {
        vm.expectRevert(_invalidCopy(0));
        vm.prank(admin);
        packs.setMetadataCopy('"', '"');
    }

    function test_SetMetadataCopyRejectionLeavesCopyUntouched() public {
        string memory prefix = packs.tokenNamePrefix();
        string memory desc = packs.description();
        vm.expectRevert(_invalidCopy(1));
        vm.prank(admin);
        packs.setMetadataCopy("new ", '"');
        assertEq(packs.tokenNamePrefix(), prefix);
        assertEq(packs.description(), desc);
    }

    /* ------------------------------ lockPresentation ------------------------------ */

    function test_LockNonAdminReverts() public {
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.lockPresentation();
        assertFalse(packs.presentationLocked());
    }

    function test_LockEmitsAndFreezesEverything() public {
        uint256 packId = _pack();
        string memory uriBefore = packs.tokenURI(packId);

        vm.expectEmit(true, false, false, false, address(packs));
        emit IShapePacks.PresentationLocked(address(packRenderer));
        vm.prank(admin);
        packs.lockPresentation();
        assertTrue(packs.presentationLocked());

        vm.startPrank(admin);
        vm.expectRevert(IShapePacks.PresentationIsLocked.selector);
        packs.setRenderer(address(stub));
        vm.expectRevert(IShapePacks.PresentationIsLocked.selector);
        packs.setMetadataCopy("x", "y");
        vm.expectRevert(IShapePacks.PresentationIsLocked.selector);
        packs.lockPresentation();
        vm.stopPrank();

        // Nothing changed, and presentation keeps rendering.
        assertEq(packs.renderer(), address(packRenderer));
        assertEq(packs.tokenNamePrefix(), "Shape Pack ");
        assertEq(packs.tokenURI(packId), uriBefore);
    }

    function test_LockEmitsTheCurrentRenderer() public {
        vm.prank(admin);
        packs.setRenderer(address(stub));
        vm.expectEmit(true, false, false, false, address(packs));
        emit IShapePacks.PresentationLocked(address(stub));
        vm.prank(admin);
        packs.lockPresentation();
    }

    function test_LockEmitsExactlyOnce() public {
        vm.recordLogs();
        vm.prank(admin);
        packs.lockPresentation();
        assertEq(_count(vm.getRecordedLogs(), IShapePacks.PresentationLocked.selector), 1);

        vm.recordLogs();
        vm.prank(admin);
        vm.expectRevert(IShapePacks.PresentationIsLocked.selector);
        packs.lockPresentation();
        assertEq(_count(vm.getRecordedLogs(), IShapePacks.PresentationLocked.selector), 0);
    }

    function test_AuthorizationIsCheckedBeforeLock() public {
        vm.prank(admin);
        packs.lockPresentation();
        // A stranger is told they are unauthorized, not that the presentation is locked.
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.setRenderer(address(stub));
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.setMetadataCopy("x", "y");
        vm.expectRevert(_unauthorized(bob));
        vm.prank(bob);
        packs.lockPresentation();
    }

    function test_TransferAdminStillWorksAfterLock() public {
        vm.prank(admin);
        packs.lockPresentation();

        vm.expectEmit(true, true, false, false, address(packs));
        emit IShapePacks.AdminTransferred(admin, bob);
        vm.prank(admin);
        packs.transferAdmin(bob);
        assertEq(packs.admin(), bob);

        // The new admin inherits the lock.
        vm.expectRevert(IShapePacks.PresentationIsLocked.selector);
        vm.prank(bob);
        packs.setMetadataCopy("x", "y");
    }

    function test_LockedPresentationLeavesCustodyAlone() public {
        uint256 packId = _pack();
        vm.prank(admin);
        packs.lockPresentation();
        // Locking reaches presentation only: the pack still opens and redeems.
        vm.prank(alice);
        packs.redeem(packId);
        assertEq(packs.totalSupply(), 0);
    }
}

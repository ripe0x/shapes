// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {
    IShapeProvenance,
    IShapeRecomposition,
    IShapeSimulation,
    IShapeValue,
    ShapeChildPreview,
    ShapeFormation,
    ShapeState
} from "../src/interfaces/IShapeCapabilities.sol";
import {IShapeGeometry} from "../src/interfaces/IShapeGeometry.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";

contract ComposableReceiver is IERC721Receiver {
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract ComposabilityTest is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ComposableReceiver internal receiver;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes(100, feeRecipient, address(renderer));
        receiver = new ComposableReceiver();
        vm.deal(alice, 1_000 ether);
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return amount / 100;
    }

    function _mint(address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(to);
        id = shapes.mint{value: amount + _fee(amount)}(amount, to);
    }

    function _mintDust(uint256 count) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: count * (0.01 ether + _fee(0.01 ether))}(0.01 ether, count, alice);
    }

    function test_AdvertisesGranularCapabilities() public view {
        assertTrue(shapes.supportsInterface(type(IShapeValue).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeRecomposition).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeProvenance).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeSimulation).interfaceId));

        assertTrue(renderer.supportsInterface(type(IERC165).interfaceId));
        assertTrue(renderer.supportsInterface(type(IShapeRenderer).interfaceId));
        assertTrue(renderer.supportsInterface(type(IShapeGeometry).interfaceId));
        assertFalse(renderer.supportsInterface(0xffffffff));
    }

    function test_RendererMustAdvertiseTheStableRendererCapability() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(receiver)));
        shapes.setRenderer(address(receiver));
    }

    function test_CanonicalStateAndDenominationReads() public {
        uint256 id = _mint(alice, 1 ether);
        ShapeState memory state = shapes.shapeState(id);

        assertEq(state.seed, shapes.seedOf(id));
        assertEq(state.denominationIndex, 4);
        assertEq(state.originCount, 1);
        assertEq(state.inkGene, shapes.inkGeneOf(id));
        assertFalse(state.isBlack);
        assertEq(uint8(state.formation), uint8(ShapeFormation.Direct));
        assertEq(state.faceValueWei, 1 ether);
        assertEq(state.redeemableValueWei, 1 ether);
        assertEq(uint8(shapes.formationOf(id)), uint8(ShapeFormation.Direct));

        assertEq(shapes.denominationCount(), 9);
        assertEq(shapes.unit(), 0.01 ether);
        assertEq(shapes.denominationAt(0), 0.01 ether);
        assertEq(shapes.denominationAt(8), 100 ether);
    }

    function test_PreviewComposeReturnsCompleteResultAndMatchesExecution() public {
        uint256 first = _mintDust(5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + i + 1;
        }

        ShapeState memory preview = shapes.previewCompose(first, burnIds);
        assertEq(preview.seed, shapes.seedOf(first));
        assertEq(preview.denominationIndex, 1);
        assertEq(preview.originCount, 5);
        assertEq(uint8(preview.formation), uint8(ShapeFormation.Complete));
        assertEq(preview.faceValueWei, 0.05 ether);
        assertEq(preview.redeemableValueWei, 0.05 ether);

        vm.prank(alice);
        shapes.compose(first, burnIds);
        ShapeState memory actual = shapes.shapeState(first);
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(preview)));
    }

    function test_PreviewDecomposeReturnsExactChildren() public {
        uint256 parent = _mint(alice, 0.1 ether);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        ShapeChildPreview[] memory preview = shapes.previewDecompose(parent, outs);
        assertEq(preview.length, 2);
        assertEq(preview[0].seed, shapes.childSeed(parentSeed, 0));
        assertEq(preview[1].seed, shapes.childSeed(parentSeed, 1));
        assertEq(preview[0].originCount, 1);
        assertEq(preview[1].originCount, 0);
        assertEq(preview[0].faceValueWei, 0.05 ether);

        vm.prank(alice);
        uint256[] memory children = shapes.decompose(parent, outs);
        for (uint256 i = 0; i < children.length; ++i) {
            ShapeState memory actual = shapes.shapeState(children[i]);
            assertEq(actual.seed, preview[i].seed);
            assertEq(actual.denominationIndex, preview[i].denominationIndex);
            assertEq(actual.originCount, preview[i].originCount);
            assertEq(actual.inkGene, preview[i].inkGene);
        }
    }

    function test_PreviewRestoreReturnsExactState() public {
        uint256 parent = _mint(alice, 0.1 ether);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        vm.prank(alice);
        uint256[] memory children = shapes.decompose(parent, outs);
        ShapeState memory preview = shapes.previewRestore(parentSeed, children);

        vm.prank(alice);
        uint256 restored = shapes.restore(parentSeed, children);
        ShapeState memory actual = shapes.shapeState(restored);
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(preview)));
    }

    function test_RedeemToPaysRecipientWithoutRequiringItToOwnToken() public {
        uint256 id = _mint(alice, 1 ether);
        uint256 before = bob.balance;

        vm.prank(alice);
        shapes.redeemTo(id, payable(bob));
        assertEq(bob.balance - before, 1 ether);
    }

    function test_RedeemBatchToPaysRecipientOnce() public {
        uint256 first = _mintDust(2);
        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = first + 1;
        uint256 before = bob.balance;

        vm.prank(alice);
        uint256 paid = shapes.redeemBatchTo(ids, payable(bob));
        assertEq(paid, 0.02 ether);
        assertEq(bob.balance - before, 0.02 ether);
    }

    function test_DecomposeToMintsChildrenDirectlyToRecipient() public {
        uint256 parent = _mint(alice, 0.1 ether);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        vm.prank(alice);
        uint256[] memory children = shapes.decomposeTo(parent, outs, address(receiver));
        assertEq(shapes.ownerOf(children[0]), address(receiver));
        assertEq(shapes.ownerOf(children[1]), address(receiver));
    }

    function test_RestoreToMintsRestoredShapeDirectlyToRecipient() public {
        uint256 parent = _mint(alice, 0.1 ether);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        vm.prank(alice);
        uint256[] memory children = shapes.decompose(parent, outs);
        vm.prank(alice);
        uint256 restored = shapes.restoreTo(parentSeed, children, address(receiver));
        assertEq(shapes.ownerOf(restored), address(receiver));
    }

    function test_FilterableLifecycleEdgesAreEmittedPerParticipant() public {
        uint256 first = _mintDust(5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + i + 1;
        }

        vm.recordLogs();
        vm.prank(alice);
        shapes.compose(first, burnIds);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 signature = keccak256("ShapeAbsorbed(uint256,uint256)");
        uint256 found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == signature) {
                assertEq(logs[i].topics.length, 3);
                assertEq(uint256(logs[i].topics[1]), first);
                ++found;
            }
        }
        assertEq(found, 4);
    }

    function test_StructuredGeometryMatchesCanonicalCard() public view {
        bytes32 seed = keccak256("geometry-test");
        uint8 gene = 3;
        ShapeRenderer.Card memory card = renderer.compose(seed, 1 ether, gene);

        (
            uint8 denominationIndex,
            uint256 cols,
            uint256 rows,
            uint256 cell,
            uint256 target,
            uint256 weight,
            uint256 solidProbability,
            uint256 moduleCount
        ) = renderer.cardGeometry(seed, 1 ether, gene);

        assertEq(denominationIndex, card.denomIndex);
        assertEq(cols, card.cols);
        assertEq(rows, card.rows);
        assertEq(cell, card.cell);
        assertEq(target, card.target);
        assertEq(weight, card.weight);
        assertEq(solidProbability, card.solidProbability);
        assertEq(moduleCount, card.modules.length);

        (uint8 kind, bool solid, uint16 rotation, uint256 cx, uint256 cy, uint256 size, uint256 w) =
            renderer.moduleAt(seed, 1 ether, gene, 0);
        ShapeRenderer.Module memory module = card.modules[0];
        assertEq(kind, module.kind);
        assertEq(solid, module.solid);
        assertEq(rotation, module.rot);
        assertEq(cx, module.cx);
        assertEq(cy, module.cy);
        assertEq(size, module.size);
        assertEq(w, module.weight);
        assertEq(renderer.grammarVersion(), 1);
        assertTrue(renderer.grammarHash() != bytes32(0));
    }

    function test_ModuleAtRejectsOutOfRangeIndex() public {
        vm.expectRevert(abi.encodeWithSelector(IShapeGeometry.ModuleIndexOutOfRange.selector, 9, 9));
        renderer.moduleAt(bytes32(0), 1 ether, 3, 9);
    }
}

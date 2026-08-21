// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {
    IShapeProvenance,
    IShapeRecomposition,
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
    /// @dev Default collection copy Shapes seeds at construction, for direct collection calls.
    string internal constant COLLECTION_NAME = "Shapes";
    string internal constant COLLECTION_DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";

    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ShapeLens internal lens;
    ComposableReceiver internal receiver;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
        lens = new ShapeLens(address(shapes));
        receiver = new ComposableReceiver();
        vm.deal(alice, 1_000 ether);
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return amount / 100;
    }

    function _mint(address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(to);
        id = shapes.mint{value: amount + _fee(amount)}(amount);
    }

    function _mintDust(uint256 count) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: count * (0.01 ether + _fee(0.01 ether))}(0.01 ether, count);
    }

    /// @notice The deterministic-preview capability (previewCompose/previewSplit) moved off
    ///         `Shapes` onto `ShapeLens`; `Shapes` no longer advertises it.
    function test_AdvertisesGranularCapabilities() public view {
        assertTrue(shapes.supportsInterface(type(IShapeValue).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeRecomposition).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeProvenance).interfaceId));

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
        ShapeState memory state = lens.shapeState(id);

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

    function test_TokenUnicodeCardMatchesCanonicalRenderer() public {
        uint256 id = _mint(alice, 1 ether);
        ShapeState memory state = lens.shapeState(id);
        assertEq(lens.unicodeCard(id), renderer.renderUnicode(state.seed, state.faceValueWei, state.inkGene));
    }

    function test_PreviewComposeReturnsCompleteResultAndMatchesExecution() public {
        uint256 first = _mintDust(5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + i + 1;
        }

        ShapeState memory preview = lens.previewCompose(first, burnIds);
        assertEq(preview.seed, shapes.seedOf(first));
        assertEq(preview.denominationIndex, 1);
        assertEq(preview.originCount, 5);
        assertEq(uint8(preview.formation), uint8(ShapeFormation.Complete));
        assertEq(preview.faceValueWei, 0.05 ether);
        assertEq(preview.redeemableValueWei, 0.05 ether);

        vm.prank(alice);
        shapes.compose(first, burnIds);
        ShapeState memory actual = lens.shapeState(first);
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(preview)));
    }

    function test_PreviewSplitReturnsExactChildren() public {
        uint256 parent = _mint(alice, 0.1 ether);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        ShapeChildPreview[] memory preview = lens.previewSplit(parent, outs);
        assertEq(preview.length, 2);
        assertEq(preview[0].seed, shapes.childSeed(parentSeed, 0));
        assertEq(preview[1].seed, shapes.childSeed(parentSeed, 1));
        assertEq(preview[0].originCount, 1);
        assertEq(preview[1].originCount, 0);
        assertEq(preview[0].faceValueWei, 0.05 ether);

        vm.prank(alice);
        uint256[] memory children = shapes.split(parent, outs);
        for (uint256 i = 0; i < children.length; ++i) {
            ShapeState memory actual = lens.shapeState(children[i]);
            assertEq(actual.seed, preview[i].seed);
            assertEq(actual.denominationIndex, preview[i].denominationIndex);
            assertEq(actual.originCount, preview[i].originCount);
            assertEq(actual.inkGene, preview[i].inkGene);
        }
    }

    function test_RedeemToPaysRecipientWithoutRequiringItToOwnToken() public {
        uint256 id = _mint(alice, 1 ether);
        uint256 before = bob.balance;

        vm.prank(alice);
        shapes.redeemTo(id, payable(bob));
        assertEq(bob.balance - before, 1 ether);
    }

    /// @notice `redeemTo`/`redeemBatchTo` reject the zero address, so the payout can never be burned
    ///         by an accidental zero recipient. The token survives the revert.
    function test_RedeemToRejectsZeroRecipient() public {
        uint256 id = _mint(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidRecipient.selector, address(0)));
        shapes.redeemTo(id, payable(address(0)));
        assertEq(shapes.ownerOf(id), alice, "token survives the rejected redemption");

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.InvalidRecipient.selector, address(0)));
        shapes.redeemBatchTo(ids, payable(address(0)));
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

    function test_SplitToMintsChildrenDirectlyToRecipient() public {
        uint256 parent = _mint(alice, 0.1 ether);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        vm.prank(alice);
        uint256[] memory children = shapes.splitTo(parent, outs, address(receiver));
        assertEq(shapes.ownerOf(children[0]), address(receiver));
        assertEq(shapes.ownerOf(children[1]), address(receiver));
    }

    function test_DecomposeToMintsRevivedInputsToRecipient() public {
        // Compose five 0.01 into a 0.05 survivor, then reverse it, sending the revived inputs to a
        // different recipient. The survivor stays with its owner; only the inputs are redirected.
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);

        vm.prank(alice);
        uint256[] memory revived = shapes.decomposeTo(survivor, address(receiver));

        assertEq(shapes.ownerOf(survivor), alice, "survivor stays with its owner");
        assertEq(revived.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(first + 1 + i), address(receiver), "revived input to recipient");
        }
    }

    function test_DecomposeToRejectsNonReceiverAtomically() public {
        // A recipient that is not an ERC721 receiver makes `_safeMint` revert, rolling back the whole
        // decompose: the survivor stays merged and its compose record is intact.
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn);

        address nonReceiver = address(this); // ComposabilityTest is not an IERC721Receiver
        vm.prank(alice);
        vm.expectRevert();
        shapes.decomposeTo(survivor, nonReceiver);

        assertEq(shapes.backingOf(survivor), 0.05 ether, "survivor unchanged");
        assertEq(shapes.composeDepth(survivor), 1, "record intact after atomic revert");
    }

    function test_DecomposeManyToMintsAllRevivedInputsToRecipient() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        uint256 survivor = shapes.compose(first, burn); // depth 1

        uint256[] memory ids = new uint256[](1);
        ids[0] = survivor;
        vm.prank(alice);
        shapes.decomposeManyTo(ids, address(receiver));

        for (uint256 i = 0; i < 4; ++i) {
            assertEq(shapes.ownerOf(first + 1 + i), address(receiver));
        }
        assertEq(shapes.composeDepth(survivor), 0);
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
        assertEq(renderer.grammarVersion(), 2);
        assertTrue(renderer.grammarHash() != bytes32(0));
    }

    function test_ModuleAtRejectsOutOfRangeIndex() public {
        vm.expectRevert(abi.encodeWithSelector(IShapeGeometry.ModuleIndexOutOfRange.selector, 9, 9));
        renderer.moduleAt(bytes32(0), 1 ether, 3, 9);
    }

    /// @notice `contractURI` is the collection contract's metadata, served unchanged by the token.
    function test_ContractUriIsTheCollectionsMetadata() public view {
        string memory uri = shapes.contractURI();
        assertEq(
            uri,
            collection.contractURI(COLLECTION_NAME, COLLECTION_DESCRIPTION),
            "token diverged from collection"
        );

        string memory prefix = "data:application/json;base64,";
        assertEq(_head(uri, bytes(prefix).length), prefix, "not a json data uri");

        string memory json = collection.json(COLLECTION_NAME, COLLECTION_DESCRIPTION);
        assertTrue(_contains(json, '"name":"Shapes"'), "no collection name");
        assertTrue(_contains(json, '"description":"'), "no collection description");
        assertTrue(_contains(json, '"image":"data:image/svg+xml;base64,'), "no inline image");
    }

    /// @notice The collection image is a filmstrip: one `<g>` per frame, stepped one frame at a time.
    function test_CollectionImageIsASteppedFilmstrip() public view {
        string memory svg = collection.image();

        // 9 denominations x 2 variants, 250ms each.
        assertTrue(_contains(svg, "steps(18)"), "wrong step count");
        assertTrue(_contains(svg, "animation:r 4500ms"), "wrong cycle duration");
        assertTrue(_contains(svg, "translateX(-36000px)"), "wrong strip travel");
        // Every frame is placed at its own multiple of the frame width, first and last included.
        assertTrue(_contains(svg, '<g transform="translate(0,0)">'), "no first frame");
        assertTrue(_contains(svg, '<g transform="translate(34000,0)">'), "no last frame");

        // Square white canvas, the card inset with rounded corners, an even shadow behind it.
        assertTrue(_contains(svg, 'viewBox="0 0 3840 3840"'), "canvas is not square");
        assertTrue(_contains(svg, '<rect width="3840" height="3840" fill="#fff"/>'), "no white ground");
        assertTrue(
            _contains(svg, '<rect x="920" y="520" width="2000" height="2800" rx="40" fill="#000"'),
            "card is not inset and rounded"
        );
        assertTrue(_contains(svg, 'dx="0" dy="0"'), "shadow is offset, not even");
        assertTrue(_contains(svg, "clip-path=\"url(#c)\""), "strip is not clipped to the card");
    }

    function test_ContractUriFollowsTheCollection() public {
        ShapeCollection next = new ShapeCollection(address(renderer));
        shapes.setCollection(address(next));
        assertEq(
            shapes.contractURI(),
            next.contractURI(COLLECTION_NAME, COLLECTION_DESCRIPTION),
            "did not follow the new collection"
        );
    }

    function test_PresentationLockFreezesTheCollectionToo() public {
        shapes.lockRenderer();
        ShapeCollection next = new ShapeCollection(address(renderer));
        vm.expectRevert(IShapes.RendererIsLocked.selector);
        shapes.setCollection(address(next));
    }

    /// @notice EIP-2981 is answered, at zero, rather than left to a marketplace default.
    function test_RoyaltyIsDeclaredAndZero() public view {
        assertTrue(shapes.supportsInterface(type(IERC2981).interfaceId), "2981 not advertised");
        (address royaltyTo, uint256 amount) = shapes.royaltyInfo(1, 100 ether);
        assertEq(royaltyTo, address(0));
        assertEq(amount, 0);
    }

    function _head(string memory s, uint256 n) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }

    function _contains(string memory haystack, string memory needle) private pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}

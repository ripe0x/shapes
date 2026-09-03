// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapes, IShapeProvenance, IShapeRecomposition, IShapeValue} from "../src/interfaces/IShapes.sol";
import {ShapeChildPreview, ShapeFormation, ShapeState} from "../src/ShapeTypes.sol";
import {IShapeGeometry} from "../src/interfaces/IShapeGeometry.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";

contract ComposableReceiver is IERC721Receiver {
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract ComposabilityTest is Test {
    uint256[9] internal DENOMS = [
        Denominations.amountAt(0),
        Denominations.amountAt(1),
        Denominations.amountAt(2),
        Denominations.amountAt(3),
        Denominations.amountAt(4),
        Denominations.amountAt(5),
        Denominations.amountAt(6),
        Denominations.amountAt(7),
        Denominations.amountAt(8)
    ];
    /// @dev Default collection copy Shapes seeds at construction, for direct collection calls.
    string internal constant COLLECTION_NAME = "Shapes";
    string internal constant COLLECTION_DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";

    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    ComposableReceiver internal receiver;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, feeRecipient, address(renderer), 0
        );
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));
        receiver = new ComposableReceiver();
        vm.deal(alice, 1_000 ether);
    }

    function _fee(uint256) internal pure returns (uint256) {
        return Denominations.UNIT / 10;
    }

    function _mint(address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(to);
        id = shapes.mint{value: amount + _fee(amount)}(amount);
    }

    function _mintDust(uint256 count) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: count * (DENOMS[0] + _fee(DENOMS[0]))}(DENOMS[0], count);
    }

    /// @notice The three capability ids `Shapes` advertises, pinned so a member added to or
    ///         removed from one of them cannot change an id unnoticed.
    function test_AdvertisesGranularCapabilities() public view {
        assertEq(type(IShapeValue).interfaceId, bytes4(0xd07d718a), "IShapeValue id changed");
        assertTrue(shapes.supportsInterface(type(IShapeValue).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeRecomposition).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeProvenance).interfaceId));

        assertTrue(renderer.supportsInterface(type(IERC165).interfaceId));
        assertTrue(renderer.supportsInterface(type(IShapeRenderer).interfaceId));
        assertTrue(renderer.supportsInterface(type(IShapeGeometry).interfaceId));
        assertFalse(renderer.supportsInterface(0xffffffff));
    }

    /// @notice Regression for a review finding: relocating view/pure functions off `Shapes` (issue
    ///         #21, size recovery) left `supportsInterface` advertising `IShapeValue` and
    ///         `IShapeProvenance` while some of their members lived on a separate contract, so a
    ///         caller that gates on ERC-165 and then calls the missing selector would revert. An
    ///         advertised capability must never contain an unimplemented selector: this exercises
    ///         every view/pure member of each capability interface through a handle typed to that
    ///         interface and bound to `Shapes`, not just the interface id.
    function test_CapabilityInterfacesImplementEveryMember() public {
        uint256 id = _mint(alice, DENOMS[1]);

        assertTrue(shapes.supportsInterface(type(IShapeValue).interfaceId));
        IShapeValue value = IShapeValue(address(shapes));
        assertEq(value.backingOf(id), DENOMS[1]);
        assertEq(value.denomIndexOf(id), 1);
        assertEq(value.denominationAt(0), DENOMS[0]);
        assertEq(value.denominationCount(), 9);
        assertEq(value.unit(), DENOMS[0]);

        assertTrue(shapes.supportsInterface(type(IShapeRecomposition).interfaceId));
        // IShapeRecomposition declares only state-changing members (compose/decompose/split/
        // burnBacking); nothing view/pure to exercise beyond the interface id itself.

        assertTrue(shapes.supportsInterface(type(IShapeProvenance).interfaceId));
        IShapeProvenance provenance = IShapeProvenance(address(shapes));
        assertEq(provenance.seedOf(id), shapes.seedOf(id));
        assertEq(provenance.originCountOf(id), 1);
        assertEq(provenance.inkGeneOf(id), shapes.inkGeneOf(id));
        assertFalse(provenance.isComplete(id));
        assertEq(uint8(provenance.formationOf(id)), uint8(ShapeFormation.Direct));
        assertEq(provenance.childSeed(provenance.seedOf(id), 0), shapes.childSeed(shapes.seedOf(id), 0));
    }

    function test_RendererMustAdvertiseTheStableRendererCapability() public {
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(receiver)));
        shapes.setRenderer(address(receiver));
    }

    function test_CanonicalStateAndDenominationReads() public {
        uint256 id = _mint(alice, DENOMS[4]);
        ShapeState memory state = shapes.shapeState(id);

        assertEq(state.seed, shapes.seedOf(id));
        assertEq(state.denominationIndex, 4);
        assertEq(state.originCount, 1);
        assertEq(state.inkGene, shapes.inkGeneOf(id));
        assertFalse(state.isBlack);
        assertEq(uint8(state.formation), uint8(ShapeFormation.Direct));
        assertEq(state.faceValueWei, DENOMS[4]);
        assertEq(state.redeemableValueWei, DENOMS[4]);
        assertEq(uint8(shapes.formationOf(id)), uint8(ShapeFormation.Direct));

        assertEq(shapes.denominationCount(), 9);
        assertEq(shapes.unit(), DENOMS[0]);
        assertEq(shapes.denominationAt(0), DENOMS[0]);
        assertEq(shapes.denominationAt(8), DENOMS[8]);
    }

    function test_TokenUnicodeCardMatchesCanonicalRenderer() public {
        uint256 id = _mint(alice, DENOMS[4]);
        ShapeState memory state = shapes.shapeState(id);
        assertEq(
            shapes.unicodeCard(id), renderer.renderUnicode(state.seed, state.faceValueWei, state.inkGene)
        );
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
        assertEq(preview.faceValueWei, DENOMS[1]);
        assertEq(preview.redeemableValueWei, DENOMS[1]);

        vm.prank(alice);
        shapes.compose(first, burnIds);
        ShapeState memory actual = shapes.shapeState(first);
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(preview)));
    }

    function test_PreviewSplitReturnsExactChildren() public {
        uint256 parent = _mint(alice, DENOMS[2]);
        bytes32 parentSeed = shapes.seedOf(parent);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        ShapeChildPreview[] memory preview = shapes.previewSplit(parent, outs);
        assertEq(preview.length, 2);
        assertEq(preview[0].seed, shapes.childSeed(parentSeed, 0));
        assertEq(preview[1].seed, shapes.childSeed(parentSeed, 1));
        assertEq(preview[0].originCount, 1);
        assertEq(preview[1].originCount, 0);
        assertEq(preview[0].faceValueWei, DENOMS[1]);

        vm.prank(alice);
        uint256[] memory children = shapes.split(parent, outs);
        for (uint256 i = 0; i < children.length; ++i) {
            ShapeState memory actual = shapes.shapeState(children[i]);
            assertEq(actual.seed, preview[i].seed);
            assertEq(actual.denominationIndex, preview[i].denominationIndex);
            assertEq(actual.originCount, preview[i].originCount);
            assertEq(actual.inkGene, preview[i].inkGene);
            assertEq(
                preview[i].modules,
                shapes.modulesOf(children[i]),
                "preview modules match stored child modules"
            );
        }
    }

    /* ------------------------- preview validation ------------------------- */

    /// @notice The previews do not apply the ownership gate. Alice holds the inputs, bob's
    ///         execution is refused `NotShapeOwner`, and both previews answer regardless of who
    ///         asks or who holds them.
    function test_PreviewsAnswerWithoutTheOwnershipGate() public {
        uint256 first = _mintDust(5);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, first, bob));
        shapes.compose(first, burn);
        vm.prank(bob);
        ShapeState memory composed = shapes.previewCompose(first, burn);
        assertEq(composed.denominationIndex, 1, "compose preview refused a non-holder");

        uint256 parent = _mint(alice, DENOMS[2]);
        uint8[] memory outs = new uint8[](2);
        outs[0] = 1;
        outs[1] = 1;

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NotShapeOwner.selector, parent, bob));
        shapes.split(parent, outs);
        vm.prank(bob);
        ShapeChildPreview[] memory children = shapes.previewSplit(parent, outs);
        assertEq(children.length, 2, "split preview refused a non-holder");

        // The holder's own preview answers the same way.
        assertEq(shapes.previewSplit(parent, outs).length, 2, "the holder's preview disagreed");
    }

    /// @notice A token can only be burned into the survivor once. Compose and its preview report
    ///         that with the same error and the same id.
    function test_ComposeAndPreviewRejectARepeatedInputAlike() public {
        uint256 first = _mintDust(3);
        uint256[] memory burn = new uint256[](2);
        burn[0] = first + 1;
        burn[1] = first + 1;

        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, first + 1));
        shapes.previewCompose(first, burn);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.DuplicateComposeInput.selector, first + 1));
        shapes.compose(first, burn);

        assertEq(shapes.ownerOf(first + 1), alice, "the rejected compose moved nothing");
        assertEq(shapes.composeDepth(first), 0, "the rejected compose recorded nothing");
    }

    /// @notice `previewCompose` applies `Shapes`'s own validation before computing anything, so
    ///         a preview reports exactly the rejection the execution would.
    function test_PreviewComposeRejectsWhatComposeRejects() public {
        uint256 first = _mintDust(6);

        vm.expectRevert(IShapes.NoComposeInputs.selector);
        shapes.previewCompose(first, new uint256[](0));
        vm.prank(alice);
        vm.expectRevert(IShapes.NoComposeInputs.selector);
        shapes.compose(first, new uint256[](0));

        uint256[] memory self = new uint256[](1);
        self[0] = first;
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, first));
        shapes.previewCompose(first, self);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.CannotComposeWithSelf.selector, first));
        shapes.compose(first, self);
    }

    /// @notice `previewSplit` applies the same two structural checks `split` does: a split needs
    ///         at least two outputs, and they must sum to the parent's backing exactly.
    function test_PreviewSplitRejectsWhatSplitRejects() public {
        uint256 parent = _mint(alice, DENOMS[2]);

        uint8[] memory single = new uint8[](1);
        single[0] = 2; // the parent's own denomination
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitTooFewOutputs.selector));
        shapes.previewSplit(parent, single);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.SplitTooFewOutputs.selector));
        shapes.split(parent, single);

        uint8[] memory shortfall = new uint8[](2);
        shortfall[0] = 1; // 0.05
        shortfall[1] = 0; // 0.01, so 0.06 against a 0.1 parent
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.SplitSumMismatch.selector, DENOMS[2], DENOMS[0] + DENOMS[1])
        );
        shapes.previewSplit(parent, shortfall);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IShapes.SplitSumMismatch.selector, DENOMS[2], DENOMS[0] + DENOMS[1])
        );
        shapes.split(parent, shortfall);
    }

    /// @notice The pool's worst gene is folded from the burn side, not merely seeded from the
    ///         survivor. Composing under a survivor that already holds the pool's best gene is
    ///         the case that only reaches `worst` through an input.
    function test_PreviewComposeFoldsAWorseGeneFromTheBurnSide() public {
        uint256 first = _mintDust(24);

        uint256 hi = first;
        uint256 lo = first;
        for (uint256 i = 1; i < 24; ++i) {
            uint256 id = first + i;
            if (shapes.inkGeneOf(id) > shapes.inkGeneOf(hi)) hi = id;
            if (shapes.inkGeneOf(id) < shapes.inkGeneOf(lo)) lo = id;
        }
        assertLt(shapes.inkGeneOf(lo), shapes.inkGeneOf(hi), "no gene spread to fold");

        // Survivor carries the best gene, so `best` never moves and only `lo` can lower `worst`.
        uint256[] memory burnIds = new uint256[](4);
        burnIds[0] = lo;
        uint256 filled = 1;
        for (uint256 i = 0; filled < 4; ++i) {
            uint256 id = first + i;
            if (id != hi && id != lo) burnIds[filled++] = id;
        }

        ShapeState memory preview = shapes.previewCompose(hi, burnIds);
        vm.prank(alice);
        shapes.compose(hi, burnIds);
        assertEq(
            keccak256(abi.encode(shapes.shapeState(hi))),
            keccak256(abi.encode(preview)),
            "preview diverged from execution"
        );
    }

    /// @notice Once a token carries materialized geometry its card renders from those modules,
    ///         not from its seed. `Shapes.tokenURI` makes the same split on the same condition.
    function test_UnicodeCardUsesStoredModulesOnceMaterialized() public {
        uint256 first = _mintDust(5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + i + 1;
        }
        vm.prank(alice);
        shapes.compose(first, burnIds);

        ShapeState memory state = shapes.shapeState(first);
        assertGt(state.modules.length, 0, "a compose survivor is materialized");
        assertEq(
            shapes.unicodeCard(first),
            renderer.renderUnicodeSampled(state.modules, state.faceValueWei, state.inkGene),
            "card must come from the stored modules"
        );
        assertTrue(
            keccak256(bytes(shapes.unicodeCard(first)))
                != keccak256(bytes(renderer.renderUnicode(state.seed, state.faceValueWei, state.inkGene))),
            "the seed path would have rendered a different card"
        );
    }

    function test_RedeemToPaysRecipientWithoutRequiringItToOwnToken() public {
        uint256 id = _mint(alice, DENOMS[4]);
        uint256 before = bob.balance;

        vm.prank(alice);
        shapes.redeemTo(id, payable(bob));
        assertEq(bob.balance - before, DENOMS[4]);
    }

    /// @notice `redeemTo`/`redeemBatchTo` reject the zero address, so the payout can never be burned
    ///         by an accidental zero recipient. The token survives the revert.
    function test_RedeemToRejectsZeroRecipient() public {
        uint256 id = _mint(alice, DENOMS[4]);
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
        assertEq(paid, DENOMS[0] * 2);
        assertEq(bob.balance - before, DENOMS[0] * 2);
    }

    function test_SplitToMintsChildrenDirectlyToRecipient() public {
        uint256 parent = _mint(alice, DENOMS[2]);
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

        assertEq(shapes.backingOf(survivor), DENOMS[1], "survivor unchanged");
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
        ShapeRenderer.Card memory card = renderer.compose(seed, DENOMS[4], gene);

        (
            uint8 denominationIndex,
            uint256 cols,
            uint256 rows,
            uint256 cell,
            uint256 target,
            uint256 weight,
            uint256 solidProbability,
            uint256 moduleCount
        ) = renderer.cardGeometry(seed, DENOMS[4], gene);

        assertEq(denominationIndex, card.denomIndex);
        assertEq(cols, card.cols);
        assertEq(rows, card.rows);
        assertEq(cell, card.cell);
        assertEq(target, card.target);
        assertEq(weight, card.weight);
        assertEq(solidProbability, card.solidProbability);
        assertEq(moduleCount, card.modules.length);

        (uint8 kind, bool solid, uint16 rotation, uint256 cx, uint256 cy, uint256 size, uint256 w) =
            renderer.moduleAt(seed, DENOMS[4], gene, 0);
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
        renderer.moduleAt(bytes32(0), DENOMS[4], 3, 9);
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
        ShapeCollection next = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(next));
        assertEq(
            shapes.contractURI(),
            next.contractURI(COLLECTION_NAME, COLLECTION_DESCRIPTION),
            "did not follow the new collection"
        );
    }

    function test_PresentationLockFreezesTheCollectionToo() public {
        shapes.lockPresentation();
        ShapeCollection next = new ShapeCollection(renderer, shapes);
        vm.expectRevert(IShapes.PresentationIsLocked.selector);
        shapes.setCollection(address(next));
    }

    /// @notice EIP-2981 is answered, at zero, rather than left to a marketplace default.
    function test_RoyaltyIsDeclaredAndZero() public view {
        assertTrue(shapes.supportsInterface(type(IERC2981).interfaceId), "2981 not advertised");
        (address royaltyTo, uint256 amount) = shapes.royaltyInfo(1, DENOMS[8]);
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

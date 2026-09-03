// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AuditBase} from "./AuditBase.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {ShapeState} from "../../src/ShapeTypes.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @notice v9 attempt 1: reentrancy from an ERC-721 receiver during `decomposeTo` and `splitTo`,
///         aimed at the owner token pointer, the reserve and the record stacks. Plus the
///         decompose round-trip claim, pushed against nested records, split children as compose
///         inputs, the owner token and Black inputs.
contract V9RecompositionTest is AuditBase {
    /* ---------------------------------------------------------------- */
    /*  attempt 1: receiver reentrancy during decomposeTo and splitTo    */
    /* ---------------------------------------------------------------- */

    /// @notice A receiver that reenters every mutating entrypoint from inside `onERC721Received`
    ///         during a decompose, and records what the views report mid-flight.
    function test_Attempt1_ReentrantReceiverDuringDecompose() public {
        V9Spy spy = new V9Spy(shapes);
        vm.deal(address(spy), 100 ether);

        // Two 0.01 tokens composed into a 0.02? not on the ladder. Use 5 x 0.01 -> 0.05.
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, burnIds);
        assertEq(shapes.backingOf(survivor), DENOMS[1], "composed to 0.05");

        vm.prank(alice);
        shapes.transferFrom(alice, address(spy), survivor);

        uint256 backingBefore = shapes.redeemableBacking();
        uint256 balanceBefore = address(shapes).balance;

        spy.armDecompose();
        vm.prank(address(spy));
        shapes.decomposeTo(survivor, address(spy));

        assertEq(shapes.redeemableBacking(), backingBefore, "decompose moved backing");
        assertEq(address(shapes).balance, balanceBefore, "decompose moved ETH");
        _assertReserveInvariant();

        // Every reentrant mutator attempt was refused by the guard.
        assertEq(spy.callbacks(), 4, "one callback per restored input");
        assertEq(spy.reentrantFailures(), spy.reentrantAttempts(), "a reentrant mutator succeeded");
        assertGt(spy.reentrantAttempts(), 0, "no reentrancy was actually attempted");

        // The owner token is Shape #0 and was never involved; it must not have moved.
        assertEq(shapes.ownerToken(), 0, "owner token moved");
        assertEq(shapes.owner(), shapes.ownerOf(0), "owner() diverged from the owner token holder");
    }

    /// @notice The same spy during `splitTo`, with the owner token as the parent. The property
    ///         under test is that no callback ever observes `ownerToken()` naming an id that does
    ///         not exist.
    function test_Attempt1_ReentrantReceiverDuringSplitOfOwnerToken() public {
        V9Spy spy = new V9Spy(shapes);
        vm.deal(address(spy), 100 ether);

        // Grow Shape #0 (the owner token) to 0.05 so it can be split into five 0.01 children.
        shapes.transferFrom(address(this), alice, 0);
        uint256 first = _mintBatchTo(alice, DENOMS[0], 4);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = first + i;
        }
        vm.prank(alice);
        shapes.compose(0, burnIds);
        assertEq(shapes.ownerToken(), 0, "owner token is still Shape #0");

        vm.prank(alice);
        shapes.transferFrom(alice, address(spy), 0);
        assertEq(shapes.owner(), address(spy), "owner follows the token");

        uint8[] memory outs = new uint8[](5); // five 0.01 outputs sum to 0.05

        uint256 backingBefore = shapes.redeemableBacking();
        spy.armSplit();
        vm.prank(address(spy));
        uint256[] memory kids = shapes.splitTo(0, outs, address(spy));

        assertEq(shapes.redeemableBacking(), backingBefore, "split moved backing");
        _assertReserveInvariant();
        assertEq(shapes.ownerToken(), kids[0], "owner token did not land on the first child");
        assertEq(shapes.owner(), address(spy));
        assertEq(spy.ownerTokenAlwaysExisted(), true, "a callback saw ownerToken() naming a dead id");
        assertEq(spy.callbacks(), 5, "one callback per child");
        assertEq(spy.reentrantFailures(), spy.reentrantAttempts(), "a reentrant mutator succeeded");
    }

    /* ---------------------------------------------------------------- */
    /*  decompose round trip: every observable fact                     */
    /* ---------------------------------------------------------------- */

    struct Facts {
        address holder;
        bytes32 seed;
        uint8 denomIndex;
        uint256 originCount;
        uint8 inkGene;
        bool isBlack;
        uint256 backing;
        uint256 composeDepth;
        bytes modules;
        bytes effectiveModules;
        string tokenURI;
        bool isSplitChild;
        uint256 splitParentId;
    }

    function _facts(uint256 id) internal view returns (Facts memory f) {
        f.holder = shapes.ownerOf(id);
        f.seed = shapes.seedOf(id);
        f.denomIndex = shapes.denomIndexOf(id);
        f.originCount = shapes.originCountOf(id);
        f.inkGene = shapes.inkGeneOf(id);
        f.isBlack = shapes.isBlackShape(id);
        f.backing = shapes.backingOf(id);
        f.composeDepth = shapes.composeDepth(id);
        f.modules = shapes.modulesOf(id);
        f.effectiveModules = shapes.effectiveModulesOf(id);
        f.tokenURI = shapes.tokenURI(id);
        try shapes.splitOriginOf(id) returns (
            bytes32, uint256 parentId, uint8, uint8, uint8, bytes memory, uint256
        ) {
            f.isSplitChild = true;
            f.splitParentId = parentId;
        } catch {
            f.isSplitChild = false;
        }
    }

    function _assertSameFacts(Facts memory a, Facts memory b, string memory what) internal pure {
        assertEq(a.holder, b.holder, string.concat(what, ": holder"));
        assertEq(a.seed, b.seed, string.concat(what, ": seed"));
        assertEq(a.denomIndex, b.denomIndex, string.concat(what, ": denomIndex"));
        assertEq(a.originCount, b.originCount, string.concat(what, ": originCount"));
        assertEq(a.inkGene, b.inkGene, string.concat(what, ": inkGene"));
        assertEq(a.isBlack, b.isBlack, string.concat(what, ": isBlack"));
        assertEq(a.backing, b.backing, string.concat(what, ": backing"));
        assertEq(a.composeDepth, b.composeDepth, string.concat(what, ": composeDepth"));
        assertEq(a.modules, b.modules, string.concat(what, ": modules"));
        assertEq(a.effectiveModules, b.effectiveModules, string.concat(what, ": effectiveModules"));
        assertEq(a.tokenURI, b.tokenURI, string.concat(what, ": tokenURI"));
        assertEq(a.isSplitChild, b.isSplitChild, string.concat(what, ": isSplitChild"));
        assertEq(a.splitParentId, b.splitParentId, string.concat(what, ": splitParentId"));
    }

    /// @notice Round trip with split children as compose inputs, a nested record underneath, and
    ///         the owner token sitting on one of the inputs.
    function test_RoundTrip_SplitChildrenAndOwnerTokenAsInputs() public {
        // Shape #0 (owner token) grows to 0.05, then splits into five 0.01 children.
        shapes.transferFrom(address(this), alice, 0);
        uint256 first = _mintBatchTo(alice, DENOMS[0], 4);
        uint256[] memory grow = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            grow[i] = first + i;
        }
        vm.prank(alice);
        shapes.compose(0, grow);

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(0, outs);
        assertEq(shapes.ownerToken(), kids[0], "owner token on the first child");

        Facts[5] memory before;
        for (uint256 i = 0; i < 5; ++i) {
            before[i] = _facts(kids[i]);
        }
        uint256 supplyBefore = shapes.totalSupply();
        uint256 mintedBefore = shapes.totalMinted();
        uint256 backingBefore = shapes.redeemableBacking();
        uint256 ownerTokenBefore = shapes.ownerToken();

        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = kids[i + 1];
        }
        vm.prank(alice);
        shapes.compose(kids[0], burnIds);
        assertEq(shapes.ownerToken(), kids[0], "owner token stayed on the survivor");

        vm.prank(alice);
        shapes.decompose(kids[0]);

        for (uint256 i = 0; i < 5; ++i) {
            _assertSameFacts(before[i], _facts(kids[i]), "round trip");
        }
        assertEq(shapes.totalSupply(), supplyBefore, "totalSupply");
        assertEq(shapes.totalMinted(), mintedBefore, "totalMinted");
        assertEq(shapes.redeemableBacking(), backingBefore, "redeemableBacking");
        assertEq(shapes.ownerToken(), ownerTokenBefore, "owner token");
        _assertReserveInvariant();
    }

    /// @notice The owner token as a burned input, not the survivor: decompose must hand it back to
    ///         exactly the input it came from, and only after every restored id exists.
    function test_RoundTrip_OwnerTokenAsBurnedInput() public {
        // Move the owner token (#0) to alice, mint four more 0.01 to alice, compose with a
        // non-owner-token survivor so #0 is a burned input.
        shapes.transferFrom(address(this), alice, 0);
        uint256 first = _mintBatchTo(alice, DENOMS[0], 4);

        uint256[] memory burnIds = new uint256[](4);
        burnIds[0] = 0;
        for (uint256 i = 1; i < 4; ++i) {
            burnIds[i] = first + i;
        }
        Facts memory ownerTokenBefore = _facts(0);

        vm.prank(alice);
        shapes.compose(first, burnIds);
        assertEq(shapes.ownerToken(), first, "compose moved ownership to the survivor");

        vm.prank(alice);
        shapes.decompose(first);

        assertEq(shapes.ownerToken(), 0, "decompose returned ownership to the recorded input");
        _assertSameFacts(ownerTokenBefore, _facts(0), "owner token round trip");
        assertEq(shapes.owner(), shapes.ownerOf(0));
        _assertReserveInvariant();
    }

    /// @notice A Black Shape can be neither a compose input nor a compose survivor nor a split
    ///         parent, so no record can ever hold one and `decompose`'s unconditional
    ///         `isBlack: false` restore cannot be wrong.
    function test_BlackShapeCannotEnterAnyRecord() public {
        uint256 apex = _apexComplete(alice);
        vm.prank(alice);
        shapes.burnBacking(apex);
        assertTrue(shapes.isBlackShape(apex));

        uint256 other = _mint(alice, DENOMS[0]);

        uint256[] memory ids = new uint256[](1);
        ids[0] = apex;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, apex));
        shapes.compose(other, ids);

        ids[0] = other;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, apex));
        shapes.compose(apex, ids);

        uint8[] memory outs = new uint8[](2);
        outs[0] = 7;
        outs[1] = 7;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, apex));
        shapes.split(apex, outs);
    }

    /// @notice A survivor that becomes Black after a compose can never be decomposed, so its
    ///         record is inert and the burned inputs are gone for good. Documented, and the ETH
    ///         accounting still balances.
    function test_BlackSurvivorFreezesItsRecord() public {
        uint256 apex = _apexComplete(alice);
        assertGt(shapes.composeDepth(apex), 0, "the apex carries a compose record");
        vm.prank(alice);
        shapes.burnBacking(apex);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.TokenIsBlack.selector, apex));
        shapes.decompose(apex);

        assertEq(shapes.backingOf(apex), 0, "a Black Shape has no redeemable backing");
        _assertReserveInvariant();
    }

    /// @notice Stacked records unwind newest first and each pop restores exactly one compose.
    function test_NestedRecordsUnwindLIFO() public {
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 10);
        // 1st compose: survivor + 4 -> 0.05
        uint256[] memory a = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            a[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, a);
        assertEq(shapes.composeDepth(survivor), 1);

        // 2nd compose: 0.05 survivor + 5 x 0.01 -> 0.1
        uint256[] memory b = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            b[i] = survivor + 5 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, b);
        assertEq(shapes.composeDepth(survivor), 2);
        assertEq(shapes.backingOf(survivor), DENOMS[2]);

        vm.prank(alice);
        uint256[] memory restored = shapes.decompose(survivor);
        assertEq(restored.length, 5, "the newest record popped first");
        assertEq(shapes.backingOf(survivor), DENOMS[1]);
        assertEq(shapes.composeDepth(survivor), 1);

        vm.prank(alice);
        restored = shapes.decompose(survivor);
        assertEq(restored.length, 4);
        assertEq(shapes.backingOf(survivor), DENOMS[0]);
        assertEq(shapes.composeDepth(survivor), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IShapes.NoComposeRecord.selector, survivor));
        shapes.decompose(survivor);
        _assertReserveInvariant();
    }

    /// @notice A split parent that carried a compose record keeps that record after it is burned.
    ///         The id is dead and no path re-issues it, so the stale stack is unreachable. This
    ///         pins the claim rather than assuming it.
    function test_SplitLeavesTheParentsComposeStackBehind() public {
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory a = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            a[i] = survivor + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(survivor, a);
        assertEq(shapes.composeDepth(survivor), 1);

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(survivor, outs);

        // The parent is burned but its stack is still readable.
        assertEq(shapes.composeDepth(survivor), 1, "split kept the parent's compose stack");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, survivor));
        shapes.ownerOf(survivor);

        // No path re-issues the parent id: every new id comes from totalMinted, which is already
        // past it, and only a compose record can revive an old id.
        assertGt(shapes.totalMinted(), survivor, "totalMinted is past the dead parent id");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, survivor));
        shapes.decompose(survivor);

        // The children are real and the reserve is intact.
        assertEq(kids.length, 5);
        _assertReserveInvariant();
    }

    /// @notice `previewCompose` and `previewSplit` take no account and gate on everything but
    ///         ownership: a non-holder gets the same answer the holder's mutation produces.
    function test_PreviewsMatchTheMutatorsForTheHolder() public {
        uint256 survivor = _mintBatchTo(alice, DENOMS[0], 5);
        uint256[] memory burnIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burnIds[i] = survivor + 1 + i;
        }

        // bob owns nothing here yet still gets a preview.
        vm.prank(bob);
        ShapeState memory preview = shapes.previewCompose(survivor, burnIds);

        vm.prank(alice);
        shapes.compose(survivor, burnIds);
        ShapeState memory actual = shapes.shapeState(survivor);

        assertEq(preview.seed, actual.seed);
        assertEq(preview.denominationIndex, actual.denominationIndex);
        assertEq(preview.originCount, actual.originCount);
        assertEq(preview.inkGene, actual.inkGene);
        assertEq(preview.modules, actual.modules);
        assertEq(preview.faceValueWei, actual.faceValueWei);
    }

    /* ------------------------------ helpers ------------------------------ */

    /// @dev A 100 ETH apex Complete: 10000 origins is out of reach in a test, so build the apex
    ///      from two 50 ETH Complete halves, each from ten 5 ETH, each from five 1 ETH. That is
    ///      Composed, not Complete, so use the cheaper route: one 100 ETH direct mint is Direct,
    ///      which `burnBacking` refuses. Build Complete by composing 10000 units.
    function _apexComplete(address who) internal returns (uint256 id) {
        // Compose upward in stages so the origin count reaches unitsAt(8) == 10000.
        // Stage 1: 100 x 0.01 -> 1 ETH Complete (100 origins).
        // Repeated 100 times, then compose the hundred 1 ETH into one 100 ETH.
        uint256[] memory ones = new uint256[](100);
        for (uint256 j = 0; j < 100; ++j) {
            uint256 first = _mintBatchTo(who, DENOMS[0], 100);
            uint256[] memory burnIds = new uint256[](99);
            for (uint256 i = 0; i < 99; ++i) {
                burnIds[i] = first + 1 + i;
            }
            vm.prank(who);
            shapes.compose(first, burnIds);
            ones[j] = first;
        }
        uint256[] memory rest = new uint256[](99);
        for (uint256 i = 0; i < 99; ++i) {
            rest[i] = ones[i + 1];
        }
        vm.prank(who);
        shapes.compose(ones[0], rest);
        id = ones[0];
        assertEq(shapes.originCountOf(id), 10_000, "apex is Complete");
    }
}

/// @notice A receiver that reenters every mutating `Shapes` entrypoint from inside
///         `onERC721Received` and records what the views said mid-flight.
contract V9Spy is IERC721Receiver {
    IShapes private immutable _shapes;

    uint256 public callbacks;
    uint256 public reentrantAttempts;
    uint256 public reentrantFailures;
    bool public ownerTokenAlwaysExisted = true;

    bool private _armed;

    constructor(IShapes shapes_) {
        _shapes = shapes_;
    }

    function armDecompose() external {
        _armed = true;
    }

    function armSplit() external {
        _armed = true;
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (_armed) {
            callbacks += 1;
            _observe();
            _try(abi.encodeWithSignature("redeem(uint256)", uint256(0)));
            _try(abi.encodeWithSignature("burn(uint256)", uint256(0)));
            _try(abi.encodeWithSignature("decompose(uint256)", uint256(0)));
            _try(abi.encodeWithSignature("burnBacking(uint256)", uint256(0)));
            _try(abi.encodeWithSignature("withdrawFees(address)", address(this)));
            _try(abi.encodeWithSignature("mint(uint256)", uint256(0)));
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    function _observe() private {
        try _shapes.ownerToken() returns (uint256 id) {
            if (IERC721(address(_shapes)).ownerOf(id) == address(0)) {
                ownerTokenAlwaysExisted = false;
            }
        } catch {
            // no owner token is a consistent state
        }
    }

    function _try(bytes memory data) private {
        reentrantAttempts += 1;
        (bool ok,) = address(_shapes).call(data);
        if (!ok) reentrantFailures += 1;
    }
}

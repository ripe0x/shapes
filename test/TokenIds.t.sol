// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ShapesBase} from "./Shapes.t.sol";

/// @notice The id allocator, in one place.
///
/// @dev Ids are issued from 0. `totalMinted` counts ids issued, so the highest id ever issued is
///      `totalMinted - 1` and the next fresh id is `totalMinted` itself. `decompose` is the one
///      path that re-mints an already-issued id, and it deliberately does not advance the
///      counter.
///
///      The property everything rests on: a fresh mint can never reproduce a revived id. A
///      revived id was issued in the past, so it is at most `totalMinted - 1`, while a fresh mint
///      takes `totalMinted`. A collision would not silently corrupt state — OpenZeppelin's
///      `_mint` reverts on an existing token — it would brick `decompose` or minting outright,
///      which is why every path that touches the counter is pinned here.
contract TokenIdAllocationTest is ShapesBase {
    function _keepGenesisShape() internal pure override returns (bool) {
        return true;
    }

    function _mintDust(uint256 k) internal returns (uint256 first) {
        vm.prank(alice);
        first = shapes.mintBatch{value: k * (DENOMS[0] + feeOf(DENOMS[0]))}(DENOMS[0], k);
    }

    function _composeDust(uint256 first, uint256 k) internal returns (uint256 survivor) {
        uint256[] memory burn = new uint256[](k - 1);
        for (uint256 i = 0; i < k - 1; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        survivor = shapes.compose(first, burn);
    }

    /* --------------------------- the base case --------------------------- */

    function test_GenesisIsZeroAndPublicIdsBeginAtOne() public {
        assertEq(shapes.totalMinted(), 1, "genesis #0 issued in construction");
        assertEq(_mint(alice, DENOMS[4]), 1, "the first public Shape is #1");
        assertEq(shapes.totalMinted(), 2, "two ids issued, highest is 1");
        assertEq(_mint(alice, DENOMS[4]), 2, "the next fresh id is totalMinted");
        assertEq(shapes.totalMinted(), 3);
    }

    /// @notice #0 is an ordinary token on every path, not a sentinel.
    function test_TokenZeroBehavesLikeAnyOther() public {
        assertEq(shapes.ownerOf(0), address(this));
        assertEq(shapes.backingOf(0), DENOMS[0]);
        assertTrue(shapes.seedOf(0) != bytes32(0), "#0 has a seed");

        shapes.transferFrom(address(this), bob, 0);
        assertEq(shapes.ownerOf(0), bob, "#0 transfers");

        vm.prank(bob);
        shapes.redeem(0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 0));
        shapes.ownerOf(0);
        _assertSolvent();
    }

    function test_TokenZeroComposesSplitsAndDecomposes() public {
        shapes.transferFrom(address(this), alice, 0);
        uint256 first = _mintDust(4);
        assertEq(first, 1, "public dust follows genesis");

        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = i + 1;
        }
        vm.prank(alice);
        shapes.compose(0, burn);
        assertEq(shapes.backingOf(0), DENOMS[1], "#0 survived the compose and grew");

        vm.prank(alice);
        uint256[] memory revived = shapes.decompose(0);
        assertEq(revived.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(revived[i], i + 1, "originals came back");
        }
        assertEq(shapes.backingOf(0), DENOMS[0], "#0 reverted");

        vm.prank(alice);
        shapes.compose(0, burn);
        assertEq(shapes.backingOf(0), DENOMS[1], "#0 grew again before split");

        uint256 backingBefore = shapes.redeemableBacking();
        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory children = shapes.split(0, outs);

        assertEq(shapes.owner(), address(0), "split must clear ownership until #0 is revived");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 0));
        shapes.ownerOf(0);
        assertEq(children.length, 5);
        for (uint256 i = 0; i < children.length; ++i) {
            assertEq(children[i], 5 + i, "split ids continue after the original batch");
            assertEq(shapes.ownerOf(children[i]), alice, "split child went to another owner");
            assertEq(shapes.backingOf(children[i]), DENOMS[0], "split child backing changed");
        }
        assertEq(shapes.redeemableBacking(), backingBefore, "split changed aggregate backing");
        assertEq(shapes.totalSupply(), 5, "split burns one parent and mints five children");
        _assertSolvent();
    }

    /* ------------------------- fresh ids never repeat ------------------------ */

    /// @notice mint, mintBatch and split all draw from the same counter, contiguously and in
    ///         order, and `totalMinted` tracks exactly how many ids they have issued.
    function test_FreshIdsAreContiguousAcrossEveryMintingPath() public {
        uint256 a = _mint(alice, DENOMS[4]);
        assertEq(a, 1);
        assertEq(shapes.totalMinted(), 2);

        uint256 b = _mintDust(6);
        assertEq(b, 2, "batch continues from the counter");
        assertEq(shapes.totalMinted(), 8);

        // A split burns its input and issues k fresh ids from the counter.
        uint256 parent = _mint(alice, DENOMS[1]);
        assertEq(parent, 8);
        assertEq(shapes.totalMinted(), 9);

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(parent, outs);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(kids[i], 9 + i, "split ids continue the sequence");
        }
        assertEq(shapes.totalMinted(), 14, "counter advanced by the child count");
    }

    /// @notice Across a long mixed history, every fresh id is strictly greater than every id
    ///         issued before it, and the counter never runs backwards.
    function test_CounterIsMonotonicAcrossAMixedHistory() public {
        uint256 highestSeen;
        uint256 previousCounter = shapes.totalMinted();

        for (uint256 round = 0; round < 6; ++round) {
            uint256 first = _mintDust(5);
            assertGe(first, previousCounter, "a fresh id reused an issued id");
            assertEq(first, previousCounter, "fresh ids start exactly at the counter");
            highestSeen = first + 4;
            previousCounter = shapes.totalMinted();
            assertEq(previousCounter, highestSeen + 1, "counter is one past the highest id");

            uint256 survivor = _composeDust(first, 5);
            assertEq(shapes.totalMinted(), previousCounter, "compose issues no ids");

            vm.prank(alice);
            shapes.decompose(survivor);
            assertEq(shapes.totalMinted(), previousCounter, "decompose issues no ids");
        }
        _assertSolvent();
    }

    /* --------------------------- revived ids --------------------------- */

    /// @notice The property the whole scheme rests on: after a decompose has put previously
    ///         burned ids back into circulation, the next fresh mint still lands above all of
    ///         them.
    function test_FreshMintNeverCollidesWithARevivedId() public {
        uint256 first = _mintDust(5); // ids 0..4
        uint256 survivor = _composeDust(first, 5); // burns 1..4

        uint256 counterBefore = shapes.totalMinted();
        vm.prank(alice);
        uint256[] memory revived = shapes.decompose(survivor);
        assertEq(shapes.totalMinted(), counterBefore, "decompose must not advance the counter");

        uint256 fresh = _mint(alice, DENOMS[4]);
        assertEq(fresh, counterBefore, "a fresh mint takes the counter");
        for (uint256 i = 0; i < revived.length; ++i) {
            assertLt(revived[i], fresh, "a revived id must sit below every fresh id");
        }
    }

    /// @notice The tight boundary: revive the highest id the counter ever handed out, then mint.
    ///         An off-by-one in either direction shows up here and nowhere else.
    function test_RevivingTheHighestIssuedIdStillLeavesRoom() public {
        uint256 first = _mintDust(5); // ids 0..4; #4 is the highest issued
        _composeDust(first, 5); // burns 1..4, including the high-water id

        assertEq(shapes.totalMinted(), 6, "counter unchanged by compose");

        vm.prank(alice);
        uint256[] memory revived = shapes.decompose(first);
        assertEq(revived[3], 5, "the high-water id came back");
        assertEq(shapes.totalMinted(), 6, "counter still unchanged");

        uint256 fresh = _mint(alice, DENOMS[4]);
        assertEq(fresh, 6, "the next id is one past the revived high-water id");
        assertEq(shapes.ownerOf(5), alice, "the revived token is untouched by the fresh mint");
        _assertSolvent();
    }

    /// @notice Repeated compose/decompose cycles on one survivor keep handing back the same ids.
    function test_RepeatedCyclesReviveTheSameIds() public {
        uint256 first = _mintDust(5);

        for (uint256 cycle = 0; cycle < 4; ++cycle) {
            _composeDust(first, 5);
            vm.prank(alice);
            uint256[] memory revived = shapes.decompose(first);
            assertEq(revived.length, 4);
            for (uint256 i = 0; i < 4; ++i) {
                assertEq(revived[i], first + 1 + i, "same ids every cycle");
            }
            assertEq(shapes.totalMinted(), 6, "no cycle ever advances the counter");
        }
        _assertSolvent();
    }

    /// @notice Stacked composes unwind newest first, and every id returns exactly once.
    function test_NestedCompositionRevivesEveryIdExactlyOnce() public {
        uint256 first = _mintDust(10); // ids 0..9

        // Inner: #0 absorbs 1..4, reaching 0.05. Outer: #0 absorbs 5..9, reaching 0.1.
        uint256[] memory inner = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            inner[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first, inner);

        uint256[] memory outer = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            outer[i] = first + 5 + i;
        }
        vm.prank(alice);
        shapes.compose(first, outer);

        assertEq(shapes.backingOf(first), DENOMS[2]);
        assertEq(shapes.composeDepth(first), 2, "two stacked records");

        vm.prank(alice);
        uint256[] memory back1 = shapes.decompose(first);
        assertEq(back1.length, 5);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(back1[i], first + 5 + i, "newest record first");
        }

        vm.prank(alice);
        uint256[] memory back2 = shapes.decompose(first);
        assertEq(back2.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(back2[i], first + 1 + i);
        }

        assertEq(shapes.totalMinted(), 11, "genesis plus ten public ids issued");
        for (uint256 id = first; id < first + 10; ++id) {
            assertEq(shapes.ownerOf(id), alice, "every id is live again, exactly once");
        }
        _assertSolvent();
    }

    /// @notice A revived id can be burned again by a later compose, into a different survivor,
    ///         and revived again. It is never confused for a fresh id at any point.
    function test_RevivedIdCanBeReComposedAndRevivedAgain() public {
        uint256 first = _mintDust(10); // ids 0..9

        _composeDust(first, 5); // #0 absorbs 1..4
        vm.prank(alice);
        shapes.decompose(first); // 1..4 revived

        // Burn the revived 1..4 into a different survivor, #5.
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burn[i] = first + 1 + i;
        }
        vm.prank(alice);
        shapes.compose(first + 5, burn);
        assertEq(shapes.totalMinted(), 11, "genesis plus ten public ids issued");

        vm.prank(alice);
        uint256[] memory again = shapes.decompose(first + 5);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(again[i], first + 1 + i, "the same ids came back from a different survivor");
            assertEq(shapes.ownerOf(first + 1 + i), alice);
        }
        assertEq(shapes.totalMinted(), 11);
        _assertSolvent();
    }

    /// @notice Burned ids are not a free pool. A split issues fresh ids from the counter even
    ///         when lower ids are sitting burned and unused, because only `decompose` may put an
    ///         issued id back, and only the one that burned it.
    function test_SplitIssuesFreshIdsEvenWhileBurnedIdsExist() public {
        uint256 first = _mintDust(5); // ids 0..4
        _composeDust(first, 5); // burns 1..4; #0 becomes 0.05

        assertEq(shapes.totalMinted(), 6, "compose issued nothing");

        uint8[] memory outs = new uint8[](5);
        vm.prank(alice);
        uint256[] memory kids = shapes.split(first, outs);

        for (uint256 i = 0; i < 5; ++i) {
            assertEq(kids[i], 6 + i, "split took fresh ids, not the burned inputs");
        }
        assertEq(shapes.totalMinted(), 11);
        _assertSolvent();
    }

    /* ------------------------- counter-derived events ------------------------ */

    /// @notice `setRenderer` refreshes the whole issued range, `0 .. totalMinted - 1`, and emits
    ///         genesis means the issued range is never empty.
    function test_RendererRefreshSpansTheIssuedRangeFromGenesis() public {
        vm.recordLogs();
        shapes.setRenderer(address(renderer));
        assertEq(vm.getRecordedLogs().length, 2, "renderer update plus genesis refresh");

        _mintDust(3);
        vm.expectEmit(false, false, false, true, address(shapes));
        emit IERC4906Like.BatchMetadataUpdate(0, 3);
        shapes.setRenderer(address(renderer));
    }
}

/// @dev The ERC-4906 event, declared locally so the test can expect it without importing the
///      interface into the shared base.
interface IERC4906Like {
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
}

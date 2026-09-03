// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShapesBase} from "./Shapes.t.sol";
import {AuctionBase} from "./AuctionHouse.t.sol";

import {IAdminControl} from "../src/interfaces/IAdminControl.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {IShapeGeometry} from "../src/interfaces/IShapeGeometry.sol";
import {IShapeRenderer, SplitProvenance} from "../src/interfaces/IShapeRenderer.sol";
import {ModuleCodec} from "../src/lib/ModuleCodec.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/* ==================================================================== *
 *  1. transferAdmin(address(0)) / renounceAdmin -> onlyAdmin
 * ==================================================================== */

contract CoverageGapsAdminTest is ShapesBase {
    function test_TransferAdminToZeroReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IAdminControl.AdminInvalidAdmin.selector, address(0)));
        shapes.transferAdmin(address(0));
    }

    function test_RenounceThenOnlyAdminCallReverts() public {
        shapes.renounceAdmin();
        assertEq(shapes.admin(), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminUnauthorizedAccount.selector, address(this))
        );
        shapes.setMintFee(0);
    }
}

/* ==================================================================== *
 *  2. ShapeAuctionHouse.auctions(uint256) getter
 * ==================================================================== */

contract CoverageGapsAuctionGetterTest is AuctionBase {
    function test_AuctionGetterFieldsBeforeAndAfterFirstBid() public {
        uint256 id = _open();

        ShapeAuctionHouse.Auction memory a = house.auctions(id);
        assertEq(a.nft, address(shapes), "nft");
        assertEq(a.tokenId, lotId, "tokenId");
        assertEq(a.seller, seller, "seller");
        assertEq(a.duration, DURATION, "duration");
        assertEq(a.reserveUnits, RESERVE_UNITS, "reserveUnits");
        assertEq(a.minIncrementBps, INCREMENT_BPS, "minIncrementBps");
        assertEq(a.extensionWindow, EXTENSION, "extensionWindow");
        assertEq(a.endTime, 0, "endTime unset before first bid");
        assertEq(a.highestUnits, 0, "highestUnits");
        assertEq(a.highestBidder, address(0), "highestBidder");
        assertFalse(a.settled, "settled");
        assertFalse(a.lotClaimed, "lotClaimed");

        uint256 card = _mintCard(alice, DENOMS[4]);
        vm.prank(alice);
        house.bid(id, _one(card), 0);

        ShapeAuctionHouse.Auction memory afterBid = house.auctions(id);
        assertGt(afterBid.endTime, 0, "endTime set by first bid");
    }
}

/* ==================================================================== *
 *  3. ModuleCodec invalid-byte branches, reached through the renderer's
 *     public *Sampled surface.
 * ==================================================================== */

contract CoverageGapsInvalidModuleTest is ShapesBase {
    // Denominations.amountAt(8) is the 1-cell grid: one byte is the whole module array, so each
    // crafted byte below exercises exactly the `ModuleCodec.isValid` branch it targets.
    uint256 internal constant ONE_CELL_AMOUNT_INDEX = 8;

    function _amount() internal pure returns (uint256) {
        return Denominations.amountAt(ONE_CELL_AMOUNT_INDEX);
    }

    function _splitInfo() internal pure returns (SplitProvenance memory) {
        return SplitProvenance({isSplitChild: false, parentDenomIndex: 0, originDenomIndex: 0});
    }

    /// @dev bit 7 (the sign bit) is reserved and must be clear; kind 0 rotation 0 is otherwise
    ///      valid, so setting it isolates the sign-bit branch in `ModuleCodec.isValid`.
    function _signBitSetByte() internal pure returns (bytes1) {
        return bytes1(uint8(0x80));
    }

    /// @dev kind 10 is one past `ModuleCodec.KIND_COUNT` (10), with rotation 0 and the sign bit
    ///      clear, isolating the out-of-range-kind branch.
    function _outOfRangeKindByte() internal pure returns (bytes1) {
        return ModuleCodec.encode(10, false, 0);
    }

    /// @dev Kind 0 (circle) takes exactly one rotation (`rotCount == 1`), so rotation index 1 is
    ///      out of range for its kind while the byte is otherwise well formed, isolating the
    ///      invalid-rotation branch.
    function _invalidRotationByte() internal pure returns (bytes1) {
        return bytes1(uint8((1 << 5) | 0)); // rotIndex = 1, solid = false, kind = 0
    }

    function test_ModuleCodecAgreesEachCraftedByteIsInvalid() public pure {
        assertFalse(ModuleCodec.isValid(_signBitSetByte()), "sign bit");
        assertFalse(ModuleCodec.isValid(_outOfRangeKindByte()), "out-of-range kind");
        assertFalse(ModuleCodec.isValid(_invalidRotationByte()), "invalid rotation");
    }

    function test_RenderSVGSampledRevertsOnEachInvalidByte() public {
        bytes1[3] memory bad = [_signBitSetByte(), _outOfRangeKindByte(), _invalidRotationByte()];
        for (uint256 i = 0; i < bad.length; ++i) {
            bytes memory modules = new bytes(1);
            modules[0] = bad[i];
            vm.expectRevert(abi.encodeWithSelector(IShapeGeometry.InvalidModuleByte.selector, 0, bad[i]));
            IShapeRenderer(address(renderer)).renderSVGSampled(modules, _amount(), false, 0);
        }
    }

    function test_ModuleAtSampledRevertsOnInvalidByte() public {
        bytes memory modules = new bytes(1);
        modules[0] = _outOfRangeKindByte();
        vm.expectRevert(
            abi.encodeWithSelector(IShapeGeometry.InvalidModuleByte.selector, 0, _outOfRangeKindByte())
        );
        IShapeGeometry(address(renderer)).moduleAtSampled(modules, _amount(), 0, 0);
    }

    function test_MetadataJSONSampledRevertsOnInvalidByte() public {
        bytes memory modules = new bytes(1);
        modules[0] = _invalidRotationByte();
        vm.expectRevert(
            abi.encodeWithSelector(IShapeGeometry.InvalidModuleByte.selector, 0, _invalidRotationByte())
        );
        IShapeRenderer(address(renderer))
            .metadataJSONSampled(modules, _amount(), 1, 1, false, 0, 0, "Shape #", "", _splitInfo(), false);
    }

    /// @dev `composeSampled` requires `modules.length` to equal the grid's cell count; a 1-cell
    ///      grid fed zero bytes exercises `InvalidModuleLength` on the same `*Sampled` surface.
    function test_ModuleAtSampledRevertsOnWrongLength() public {
        bytes memory modules = new bytes(0);
        vm.expectRevert(abi.encodeWithSelector(IShapeGeometry.InvalidModuleLength.selector, 1, 0));
        IShapeGeometry(address(renderer)).moduleAtSampled(modules, _amount(), 0, 0);
    }
}

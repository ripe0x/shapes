// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console, Vm} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {
    IShapeProvenance, IShapeRecomposition, IShapeSimulation, IShapeValue
} from "../src/interfaces/IShapeCapabilities.sol";
import {IShapePositionResolver} from "../src/interfaces/IShapePositionResolver.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @dev A resolver that burns everything it is given.
contract GasBurningResolver is IShapePositionResolver {
    function positionOf(uint256) external view returns (address) {
        uint256 i;
        while (gasleft() > 5000) {
            i++;
        }
        return address(uint160(i));
    }
}

contract AuditPoC2 is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
        vm.deal(address(this), 100_000 ether);
    }

    /* ------------- I: advertised interface ids are implemented ------------- */

    function _has(bytes4 sel) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(shapes).staticcall(abi.encodePacked(sel));
        // A missing function hits no dispatch entry; present ones revert on decode instead.
        if (ok) return true;
        return ret.length != 0 || _selectorPresentInCode(sel);
    }

    function _selectorPresentInCode(bytes4 sel) internal view returns (bool) {
        bytes memory code = address(shapes).code;
        for (uint256 i = 0; i + 4 <= code.length; ++i) {
            if (
                code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) return true;
        }
        return false;
    }

    function test_AdvertisedInterfacesAreImplemented() public view {
        assertTrue(shapes.supportsInterface(type(IShapes).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeValue).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeRecomposition).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeProvenance).interfaceId));
        assertTrue(shapes.supportsInterface(type(IShapeSimulation).interfaceId));
        assertTrue(shapes.supportsInterface(type(IERC721Value).interfaceId));
        assertTrue(shapes.supportsInterface(0x49064906));
        assertTrue(shapes.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(shapes.supportsInterface(0x5b5e139f)); // ERC721Metadata
        assertTrue(shapes.supportsInterface(0x01ffc9a7)); // ERC165
        assertTrue(shapes.supportsInterface(0x2a55205a)); // ERC2981
        assertFalse(shapes.supportsInterface(0xffffffff));
        assertFalse(shapes.supportsInterface(0x780e9d63)); // ERC721Enumerable not claimed

        bytes4[9] memory value = [
            IShapeValue.backingOf.selector,
            IShapeValue.shapeState.selector,
            IShapeValue.denominationAt.selector,
            IShapeValue.denominationCount.selector,
            IShapeValue.unit.selector,
            IShapeValue.redeem.selector,
            IShapeValue.redeemBatch.selector,
            IShapeValue.redeemTo.selector,
            IShapeValue.redeemBatchTo.selector
        ];
        for (uint256 i = 0; i < value.length; ++i) {
            assertTrue(_selectorPresentInCode(value[i]), "IShapeValue selector missing");
        }
        bytes4[6] memory rc = [
            IShapeRecomposition.compose.selector,
            IShapeRecomposition.decompose.selector,
            IShapeRecomposition.decomposeTo.selector,
            IShapeRecomposition.split.selector,
            IShapeRecomposition.splitTo.selector,
            IShapeRecomposition.sacrifice.selector
        ];
        for (uint256 i = 0; i < rc.length; ++i) {
            assertTrue(_selectorPresentInCode(rc[i]), "IShapeRecomposition selector missing");
        }
        bytes4[6] memory pv = [
            IShapeProvenance.seedOf.selector,
            IShapeProvenance.originCountOf.selector,
            IShapeProvenance.inkGeneOf.selector,
            IShapeProvenance.isComplete.selector,
            IShapeProvenance.formationOf.selector,
            IShapeProvenance.childSeed.selector
        ];
        for (uint256 i = 0; i < pv.length; ++i) {
            assertTrue(_selectorPresentInCode(pv[i]), "IShapeProvenance selector missing");
        }
        assertTrue(_selectorPresentInCode(IShapeSimulation.previewCompose.selector));
        assertTrue(_selectorPresentInCode(IShapeSimulation.previewSplit.selector));
        assertTrue(_selectorPresentInCode(IERC721Value.valueOf.selector));
        assertTrue(_selectorPresentInCode(IERC721Value.burn.selector));
    }

    /* -------------- B: every denomination round-trips exactly -------------- */

    function test_EveryDenominationRoundTripsExactly() public {
        for (uint8 i = 0; i < 9; ++i) {
            uint256 amount = Denominations.amountAt(i);
            uint256 fee = shapes.mintFeeFor(amount);
            assertEq(fee, amount / 100, "1% fee is exact");

            uint256 feeBefore = feeRecipient.balance;
            uint256 rbBefore = shapes.redeemableBacking();
            uint256 id = shapes.mint{value: amount + fee}(amount);
            assertEq(shapes.redeemableBacking(), rbBefore + amount);
            assertEq(feeRecipient.balance, feeBefore + fee);
            assertEq(address(shapes).balance, shapes.redeemableBacking());

            uint256 before = address(this).balance;
            shapes.redeem(id);
            assertEq(address(this).balance - before, amount, "exact redemption");
            assertEq(shapes.redeemableBacking(), rbBefore);
        }
    }

    /* ---------------- A: forced ETH is stranded, never redeemable ---------- */

    function test_ForcedEthIsStrandedAndNeverCounted() public {
        uint256 id = shapes.mint{value: 1 ether + 0.01 ether}(1 ether);
        // selfdestruct-style force feed
        vm.deal(address(shapes), address(shapes).balance + 5 ether);
        assertEq(shapes.redeemableBacking(), 1 ether);
        assertGt(address(shapes).balance, shapes.redeemableBacking());

        uint256 before = address(this).balance;
        shapes.redeem(id);
        assertEq(address(this).balance - before, 1 ether, "surplus is not paid out");
        assertEq(shapes.redeemableBacking(), 0);
        assertEq(address(shapes).balance, 5 ether, "surplus is permanently stranded");
    }

    /* -------------- H: hostile resolver cannot brick core paths ------------ */

    function test_HostileResolverCannotBrickAnything() public {
        shapes.setPositionResolver(address(new GasBurningResolver()));
        uint256 id = shapes.mint{value: 0.01 ether + 0.0001 ether}(0.01 ether);
        shapes.tokenURI(id);
        shapes.shapeState(id);
        shapes.redeem(id);

        // positionOf is the only casualty: it returns, but only after eating essentially
        // every wei of gas the caller forwarded.
        uint256 g0 = gasleft();
        (bool ok,) = address(shapes).staticcall{gas: 200_000}(
            abi.encodeWithSignature("positionOf(uint256)", 0)
        );
        uint256 used = g0 - gasleft();
        assertTrue(ok);
        assertGt(used, 190_000, "resolver burns the whole gas stipend");
    }

    /* ------- F: locks are one-way; copy survives lockRenderer ------------- */

    function test_LocksAreOneWayAndCopyStaysEditable() public {
        shapes.lockRenderer();
        vm.expectRevert(IShapes.RendererIsLocked.selector);
        shapes.setRenderer(address(renderer));
        vm.expectRevert(IShapes.RendererIsLocked.selector);
        shapes.setCollection(address(collection));
        vm.expectRevert(IShapes.RendererIsLocked.selector);
        shapes.lockRenderer();

        // Copy is still mutable after the presentation lock, by design.
        shapes.setTokenCopy("X ", "y");
        assertEq(shapes.tokenNamePrefix(), "X ");

        shapes.lockPositionResolver();
        vm.expectRevert(IShapes.PositionResolverIsLocked.selector);
        shapes.setPositionResolver(address(0));

        // Renouncing ownership freezes copy but leaves the reserve fully operational.
        shapes.renounceOwnership();
        uint256 id = shapes.mint{value: 0.01 ether + 0.0001 ether}(0.01 ether);
        shapes.redeem(id);
    }

    /* ---- I: ERC-4906 range emitted by setRenderer (doc says 1..totalMinted) --- */

    function test_BatchMetadataUpdateRangeIsZeroBased() public {
        shapes.mintBatch{value: (0.01 ether + 0.0001 ether) * 3}(0.01 ether, 3);
        vm.recordLogs();
        shapes.setRenderer(address(new ShapeRenderer()));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("BatchMetadataUpdate(uint256,uint256)")) {
                (uint256 from, uint256 to) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(from, 0);
                assertEq(to, 2);
                found = true;
            }
        }
        assertTrue(found);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}

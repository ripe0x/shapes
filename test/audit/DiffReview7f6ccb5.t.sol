// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {AuditBase} from "./AuditBase.sol";
import {IAdminControl} from "../../src/interfaces/IAdminControl.sol";
import {IShapeGeometry} from "../../src/interfaces/IShapeGeometry.sol";
import {IShapeRenderer} from "../../src/interfaces/IShapeRenderer.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";

/// @notice Attempts kept from the diff review of 7f6ccb5..2bc389a. Both target surfaces the diff
///         introduced: the token-id render views' new dependency on `IShapeGeometry`, and the
///         per-recipient fee accrual's loss of the redirect-and-retry escape hatch. Both findings
///         are now fixed; these attempts assert the fix holds.
contract DiffReview7f6ccb5Test is AuditBase {
    /// @notice `setRenderer` now checks ERC-165 for `IShapeGeometry` as well as `IShapeRenderer`,
    ///         so a renderer that cannot answer `IShapeGeometry` never installs and `geometryOf`
    ///         and `moduleAt` keep pointing at a renderer that supports them.
    function test_SetRendererRejectsARendererThatCannotAnswerIShapeGeometry() public {
        GeometryBlindRenderer blind = new GeometryBlindRenderer();
        vm.expectRevert(abi.encodeWithSelector(IShapes.UnsupportedRenderer.selector, address(blind)));
        shapes.setRenderer(address(blind));
        assertEq(shapes.renderer(), address(renderer), "the renderer must be unchanged");
    }

    /// @notice `setFeeRecipient` now rejects `address(this)` alongside the zero address, since
    ///         `Shapes` has no payable `receive` and fees credited to its own address could never
    ///         be withdrawn.
    function test_SetFeeRecipientRejectsTheTokenItself() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAdminControl.AdminInvalidFeeRecipient.selector, address(shapes))
        );
        shapes.setFeeRecipient(address(shapes));
        assertEq(shapes.feeRecipient(), feeRecipient, "the fee recipient must be unchanged");
    }
}

/// @dev Answers ERC-165 for `IShapeRenderer` and not `IShapeGeometry`. Every render call returns
///      an empty string; the four `IShapeGeometry` selectors revert.
contract GeometryBlindRenderer is IERC165 {
    error NoGeometry();

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IShapeRenderer).interfaceId;
    }

    fallback() external {
        bytes4 sel = msg.sig;
        if (
            sel == IShapeGeometry.cardGeometry.selector || sel == IShapeGeometry.cardGeometrySampled.selector
                || sel == IShapeGeometry.moduleAt.selector || sel == IShapeGeometry.moduleAtSampled.selector
        ) {
            revert NoGeometry();
        }
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, 0x20)
            mstore(add(free, 0x20), 0)
            return(free, 0x40)
        }
    }
}

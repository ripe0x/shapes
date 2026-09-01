// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IShapes} from "../interfaces/IShapes.sol";

/// @title PointerOps
/// @notice Value-inert administration for Shapes' explicit positions and market pointers.
/// @dev Public library calls execute through `DELEGATECALL`, so the pointers remain in Shapes'
///      storage and events are emitted from Shapes. Keeping these mutators out of the token's
///      runtime preserves EIP-170 headroom without giving this library authority of its own.
library PointerOps {
    struct Pointers {
        address positions;
        bool positionsLocked;
        address market;
        bool marketLocked;
    }

    function set(Pointers storage p, uint8 pointer, address target) public {
        if (pointer == uint8(IShapes.Pointer.Positions)) {
            if (p.positionsLocked) revert IShapes.PointerIsLocked();
            _requireTarget(target);
            p.positions = target;
            emit IShapes.PositionsSet(target);
        } else if (pointer == uint8(IShapes.Pointer.Market)) {
            if (p.marketLocked) revert IShapes.PointerIsLocked();
            _requireTarget(target);
            p.market = target;
            emit IShapes.MarketSet(target);
        } else {
            revert IShapes.InvalidPointer();
        }
    }

    function lock(Pointers storage p, uint8 pointer) public {
        if (pointer == uint8(IShapes.Pointer.Positions)) {
            if (p.positionsLocked) revert IShapes.PointerIsLocked();
            p.positionsLocked = true;
            emit IShapes.PositionsLocked(p.positions);
        } else if (pointer == uint8(IShapes.Pointer.Market)) {
            if (p.marketLocked) revert IShapes.PointerIsLocked();
            p.marketLocked = true;
            emit IShapes.MarketLocked(p.market);
        } else {
            revert IShapes.InvalidPointer();
        }
    }

    function _requireTarget(address target) private view {
        if (target != address(0) && target.code.length == 0) {
            revert IShapes.InvalidPointerTarget();
        }
    }
}

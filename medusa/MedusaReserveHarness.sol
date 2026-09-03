// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Shapes} from "../src/Shapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @notice Medusa-only D-09 harness. Configure this contract as the sole fuzz target.
/// @dev It deliberately exposes only bounded, valid lifecycle actions. Medusa invokes
///      `property_` functions after every generated call, so the reserve equality is monitored
///      through arbitrary mint/compose/split/decompose/redeem sequences without wasting most of
///      the campaign on invalid calldata or non-owner reverts.
contract MedusaReserveHarness {
    uint256 private constant MINT_FEE = Denominations.UNIT / 10;

    Shapes public shapes;
    uint256 public lastId;
    bool private ownerTokenEverAbsent;

    constructor() payable {}

    receive() external payable {}

    function initialize() external {
        if (address(shapes) != address(0)) return;
        ShapeRenderer renderer = new ShapeRenderer();
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            MINT_FEE, address(0xFEE), address(renderer), 0
        );
        shapes.setCollection(address(new ShapeCollection(renderer, shapes)));
        // Harness is the genesis owner. Keep #0 live, because it contributes its backing to the
        // property from the beginning of every Medusa sequence.
        lastId = 0;
    }

    function mintDust() external {
        if (address(shapes) == address(0)) return;
        uint256 amount = Denominations.amountAt(0);
        if (address(this).balance < amount + MINT_FEE) return;
        lastId = shapes.mint{value: amount + MINT_FEE}(amount);
    }

    function composeDust() external {
        if (address(shapes) == address(0)) return;
        uint256 amount = Denominations.amountAt(0);
        uint256 cost = 5 * (amount + MINT_FEE);
        if (address(this).balance < cost) return;
        uint256 first = shapes.mintBatch{value: cost}(amount, 5);
        uint256[] memory burns = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            burns[i] = first + i + 1;
        }
        lastId = shapes.compose(first, burns);
    }

    function splitLastNickel() external {
        if (!_isLive(lastId) || shapes.denomIndexOf(lastId) != 1) {
            return;
        }
        uint8[] memory outs = new uint8[](5);
        uint256[] memory ids = shapes.split(lastId, outs);
        lastId = ids[0];
    }

    function decomposeLast() external {
        if (!_isLive(lastId) || shapes.composeDepth(lastId) == 0) {
            return;
        }
        shapes.decompose(lastId);
    }

    function redeemLast() external {
        if (!_isLive(lastId)) return;
        shapes.redeem(lastId);
    }

    /// @dev The `IERC721Value` burn path, distinct from `redeem` only in that it also accepts a
    ///      Black Shape. Exercised here on whatever `lastId` is (Black or not), so both branches
    ///      of `_burnForRedemption`'s `allowBlack` gate run when a Black Shape reaches this chain
    ///      through `burnBackingIfApex`.
    function burnLast() external {
        if (!_isLive(lastId)) return;
        shapes.burn(lastId);
    }

    /// @dev Opportunistic, mirroring `Invariants.t.sol`'s `Handler.burnBacking`: an apex Complete
    ///      (10,000 conserved origins on one token) essentially never arises from randomized
    ///      mint/compose/split/decompose, so this rarely fires. Kept so the reserve properties
    ///      stay exact should one ever be reached; the deterministic build-and-burn path is the
    ///      unit suite's job (`Shapes.t.sol#_buildApexComplete`), not a bounded-gas fuzz call.
    function burnBackingIfApex() external {
        if (!_isLive(lastId) || shapes.isBlack(lastId)) return;
        if (shapes.denomIndexOf(lastId) != 8 || shapes.originCountOf(lastId) != Denominations.unitsAt(8)) {
            return;
        }
        shapes.burnBacking(lastId);
    }

    /// @dev Folds the live owner token into a fresh dust batch's survivor, which moves
    ///      `_ownerToken` mid-`compose` (the `burnId + 1 == _ownerToken` arm in `Shapes._compose`).
    ///      Requires the owner token to be dust-denominated, matching every other input, so the
    ///      batch sums to a nickel exactly as `composeDust` does. Once moved, the owner token rides
    ///      `lastId` through `splitLastNickel` and `decomposeLast`, exercising the same arm in
    ///      `_splitTo` and `_decomposeTo`.
    function moveOwnerTokenViaCompose() external {
        if (address(shapes) == address(0)) return;
        uint256 ot;
        try shapes.ownerToken() returns (uint256 id) {
            ot = id;
        } catch {
            return;
        }
        if (!_isLive(ot) || shapes.denomIndexOf(ot) != 0) return;

        uint256 amount = Denominations.amountAt(0);
        uint256 cost = 4 * (amount + MINT_FEE);
        if (address(this).balance < cost) return;
        uint256 first = shapes.mintBatch{value: cost}(amount, 4);
        uint256[] memory burns = new uint256[](4);
        burns[0] = ot;
        burns[1] = first + 1;
        burns[2] = first + 2;
        burns[3] = first + 3;
        lastId = shapes.compose(first, burns);
    }

    function _isLive(uint256 tokenId) private view returns (bool) {
        if (address(shapes) == address(0)) return false;
        try shapes.ownerOf(tokenId) returns (address) {
            return true;
        } catch {
            return false;
        }
    }

    function property_reserve_equals_redeemable_backing() external view returns (bool) {
        return address(shapes) == address(0) || address(shapes).balance == shapes.redeemableBacking();
    }

    function property_reserve_is_solvent() external view returns (bool) {
        return address(shapes) == address(0) || address(shapes).balance >= shapes.redeemableBacking();
    }

    /// @dev While the owner token exists, `owner()` must equal its ERC-721 holder; once
    ///      `ownerToken()` reverts (redeemed or burned), it must never succeed again.
    function property_owner_token_tracks_its_holder() external returns (bool) {
        if (address(shapes) == address(0)) return true;
        try shapes.ownerToken() returns (uint256 id) {
            if (ownerTokenEverAbsent) return false;
            try shapes.ownerOf(id) returns (address holder) {
                return shapes.owner() == holder;
            } catch {
                return false;
            }
        } catch {
            ownerTokenEverAbsent = true;
            return shapes.owner() == address(0);
        }
    }
}

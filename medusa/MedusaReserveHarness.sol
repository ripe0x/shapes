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
    Shapes public shapes;
    uint256 public lastId;

    constructor() payable {}

    receive() external payable {}

    function initialize() external {
        if (address(shapes) != address(0)) return;
        ShapeRenderer renderer = new ShapeRenderer();
        ShapeCollection collection = new ShapeCollection(address(renderer));
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            100, address(0xFEE), address(renderer), address(collection)
        );
        // Harness is the genesis owner. Keep #0 live, because it contributes its backing to the
        // property from the beginning of every Medusa sequence.
        lastId = 0;
    }

    function mintDust() external {
        if (address(shapes) == address(0)) return;
        uint256 amount = Denominations.amountAt(0);
        if (address(this).balance < amount + amount / 100) return;
        lastId = shapes.mint{value: amount + amount / 100}(amount);
    }

    function composeDust() external {
        if (address(shapes) == address(0)) return;
        uint256 amount = Denominations.amountAt(0);
        uint256 cost = 5 * (amount + amount / 100);
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
}

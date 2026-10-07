// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PacksTest} from "./utils/PacksTest.sol";

contract SmokeTest is PacksTest {
    function test_CreateMintedPackAndOpen() public {
        uint32[] memory counts = mintsOf(0, 3);
        uint256 cost = costOf(counts);
        vm.prank(alice);
        uint256 packId = packs.createPack{value: cost}(noIds(), counts);
        assertEq(packs.ownerOf(packId), alice);
        assertEq(packs.valueOf(packId), 3 * unit());
        assertEq(packs.contentsOf(packId).length, 3);
        string memory uri = packs.tokenURI(packId);
        assertGt(bytes(uri).length, 100);
        vm.prank(alice);
        packs.open(packId);
        assertEq(shapes.balanceOf(alice), 3);
        assertEq(address(packs).balance, 0);
    }
}

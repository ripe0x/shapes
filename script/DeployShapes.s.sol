// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {LensEquivalence} from "./LensEquivalence.s.sol";

/// @notice Deploys the renderer, the collection metadata contract, the token, the read-only lens,
///         and the auction house.
///
/// @dev The mint fee and the fee recipient are deployment parameters, not source constants:
///      both are `immutable` on the deployed contract and can never be changed afterwards, so
///      they must be chosen deliberately here.
///
///        SHAPES_FEE_BPS        mint fee in basis points of backing. Defaults to 100 (1%).
///        SHAPES_FEE_RECIPIENT  where fees are forwarded. Must be set off local chains.
///        SHAPES_RENDERER       reuse an already-deployed renderer instead of deploying one.
///
///      `ShapeLens` is periphery deployed alongside `Shapes`: it holds the rich view surface
///      (`shapeState`, `previewCompose`, `previewSplit`, `unicodeCard`, `composeRecordAt`,
///      `splitOriginOf`) that was moved off `Shapes` to keep the token's runtime bytecode under
///      the EIP-170 size limit (see IShapes.sol and IShapeLens.sol). It takes the deployed
///      `Shapes` address as its only constructor argument, holds no state of its own, and reads
///      everything through `Shapes`'s getters. Its previews are bit-identical to what the token
///      executes only while both link the same `ComposeCompute` deployment, so this script proves
///      that with `_assertLensEquivalence` before reporting success (see LensEquivalence.s.sol).
///
///      The auction house is deployed alongside but wired only to `Shapes`: it holds no
///      privileged position over the token and the token knows nothing about it, so a broken
///      house costs an auction rather than the collection.
///
///      The contract collector binding is not configured here. The contract deploys with no
///      collector token, and the collector NFT itself is not deployed by this script. Configure
///      the pointer later with `SetContractCollectorToken.s.sol` and lock it with
///      `LockContractCollectorBinding.s.sol`. Both require `owner()`, so `owner()` must remain
///      held until the token is set and the binding locked; renouncing or losing it beforehand
///      makes configuration impossible.
///
///      Local:
///        forge script script/DeployShapes.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
///      Live (dry run first, always):
///        SHAPES_FEE_RECIPIENT=0x... forge script script/DeployShapes.s.sol --rpc-url $RPC
///        SHAPES_FEE_RECIPIENT=0x... forge script script/DeployShapes.s.sol --rpc-url $RPC \
///          --broadcast --verify
contract DeployShapes is LensEquivalence {
    uint256 internal constant DEFAULT_FEE_BPS = 100; // 1%
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    /// @dev A sanity ceiling, not a protocol rule. The fee is immutable, and a fat-fingered
    ///      one would be permanent. 1000 bps is 10% of backing; anything above that is almost
    ///      certainly a mistake. Override deliberately if you really mean it.
    uint256 internal constant MAX_SANE_FEE_BPS = 1000;

    function run()
        external
        returns (
            ShapeRenderer renderer,
            ShapeCollection collection,
            Shapes shapes,
            ShapeLens lens,
            ShapeAuctionHouse house
        )
    {
        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        address feeRecipient = vm.envOr("SHAPES_FEE_RECIPIENT", address(0));
        address existingRenderer = vm.envOr("SHAPES_RENDERER", address(0));

        if (feeRecipient == address(0)) {
            // On a local chain, defaulting to the deployer keeps `forge script` a one-liner.
            // Anywhere else, an unset recipient is almost certainly a mistake, and it would be
            // permanent.
            require(
                block.chainid == ANVIL_CHAIN_ID, "set SHAPES_FEE_RECIPIENT: it is immutable once deployed"
            );
            feeRecipient = msg.sender;
        }

        require(
            feeBps <= MAX_SANE_FEE_BPS || vm.envOr("SHAPES_ALLOW_HIGH_FEE", false),
            "fee bps above the sanity ceiling: set SHAPES_ALLOW_HIGH_FEE=true to confirm"
        );
        require(
            feeRecipient.code.length == 0 || vm.envOr("SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT", false),
            "fee recipient is a contract: a reverting receive would brick minting forever. "
            "Set SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT=true if it is audited to always accept ETH"
        );

        vm.startBroadcast();

        renderer = existingRenderer == address(0) ? new ShapeRenderer() : ShapeRenderer(existingRenderer);

        collection = new ShapeCollection(address(renderer));

        shapes = new Shapes(feeBps, feeRecipient, address(renderer), address(collection));
        lens = new ShapeLens(address(shapes));
        house = new ShapeAuctionHouse(address(shapes));

        vm.stopBroadcast();

        // Prove the constructor configuration and discovery defaults landed as intended.
        // The fee terms are immutable; the owner may replace the renderer and position resolver
        // until each independent lock is used.
        require(shapes.feeBps() == feeBps, "fee bps mismatch");
        require(shapes.feeRecipient() == feeRecipient, "fee recipient mismatch");
        require(shapes.renderer() == address(renderer), "renderer mismatch");
        require(shapes.positionResolver() == address(0), "position resolver should start empty");
        require(!shapes.positionResolverLocked(), "position resolver should start unlocked");
        require(shapes.supportsInterface(type(IERC721Value).interfaceId), "draft ERC-8060 interface missing");
        require(address(renderer).code.length != 0, "renderer has no code");
        require(shapes.collection() == address(collection), "collection mismatch");
        require(collection.renderer() == address(renderer), "collection points at another renderer");

        {
            (address collectorTokenContract, uint256 collectorTokenId,) = shapes.contractCollectorBinding();
            require(collectorTokenContract == address(0), "collector token should start unset");
            require(collectorTokenId == 0, "collector token id should start zero");
            require(!lens.contractCollectorBindingLocked(), "collector binding should start unlocked");
        }

        // Smoke the renderer through the interface the token will actually use. A renderer
        // that cannot produce metadata would leave every token permanently unrenderable.
        require(
            bytes(
                IShapeRenderer(address(renderer))
                    .tokenURI(bytes32(0), Denominations.amountAt(0), 1, 1, false, 0, 0, "Shape ", "x")
            )
            .length > 500,
            "renderer produced no metadata"
        );
        require(
            bytes(
                IShapeRenderer(address(renderer))
                    .tokenURI(
                        bytes32(uint256(1)),
                        Denominations.amountAt(8),
                        10_000,
                        10_000,
                        true,
                        6,
                        0,
                        "Shape ",
                        "x"
                    )
            )
            .length > 500,
            "renderer produced no metadata at the apex"
        );

        // Contract-level metadata is what a marketplace reads for the collection itself.
        require(bytes(shapes.contractURI()).length > 500, "collection produced no metadata");

        // The lens is wired to the token and holds no privileged position over it; it can never
        // move state, only read it back through `Shapes`'s own getters.
        require(address(lens.shapes()) == address(shapes), "lens points at another token");

        // The house is wired to the token and to nothing else. It holds no role on the token, so
        // this is the whole of the relationship.
        require(house.shapes() == address(shapes), "auction house points at another token");
        require(house.auctionCount() == 0, "auction house is not fresh");

        console.log("chain id      ", block.chainid);
        console.log("ShapeRenderer ", address(renderer));
        console.log("ShapeCollection", address(collection));
        console.log("Shapes        ", address(shapes));
        console.log("ShapeLens     ", address(lens));
        console.log("AuctionHouse  ", address(house));
        console.log("fee (bps)     ", feeBps);
        console.log("fee recipient ", feeRecipient);
        console.log("owner         ", shapes.owner());
        console.log("collector token   unset (configure later with SetContractCollectorToken.s.sol)");
        console.log("");
        console.log("Fee terms and reserve rules are immutable. Ownership is transferable.");
        console.log("Presentation and position resolver settings are independently lockable.");

        // Runs last: the probe advances simulated token state, so every check and log above it
        // reads a fresh collection.
        _assertLensEquivalence(shapes, lens);
    }
}

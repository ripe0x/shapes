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

/// @notice Deploys the renderer, collection metadata, token, read-only lens, and auction house.
///
/// @dev The mint fee and initial fee recipient are deployment parameters, not source constants.
///      `feeBps` is immutable. The initial admin is the deployer and may redirect future fees,
///      so the initial recipient still must be chosen deliberately here.
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
///      Deployment sends the minimum denomination to `Shapes`, which atomically mints backed
///      Shape #0 to the deployer. Its holder is returned by `owner()` but receives no
///      administrative permissions.
///      Permissionless artwork minting therefore begins at #1. The deployer is also the initial
///      `admin()` and may transfer or renounce that separate role. Admin can redirect only future
///      mint fees; it cannot change the rate, touch backing, or alter redemption.
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

    error WrongLadder(string compiled, string expected);

    function _requirePointersUnset(Shapes shapes) private view {
        (address positions, bool positionsLocked) = shapes.positions();
        (address market, bool marketLocked) = shapes.market();
        require(positions == address(0), "positions should start empty");
        require(market == address(0), "market should start empty");
        require(!positionsLocked, "positions should start unlocked");
        require(!marketLocked, "market should start unlocked");
    }

    /// @dev The ladder is compiled in and the backing amounts it names are permanent once deployed.
    ///      Any chain that carries real value must get the mainnet ladder; anvil may use either,
    ///      since a local chain funds any rung.
    function _requireMainnetLadderOffAnvil() internal view {
        if (block.chainid == ANVIL_CHAIN_ID) return;
        if (keccak256(bytes(Denominations.LADDER_NAME)) != keccak256("mainnet")) {
            revert WrongLadder(Denominations.LADDER_NAME, "mainnet");
        }
    }

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
        _requireMainnetLadderOffAnvil();

        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        address feeRecipient = vm.envOr("SHAPES_FEE_RECIPIENT", address(0));
        address existingRenderer = vm.envOr("SHAPES_RENDERER", address(0));

        if (feeRecipient == address(0)) {
            // On a local chain, defaulting to the deployer keeps `forge script` a one-liner.
            // Anywhere else, an unset initial recipient is almost certainly a mistake.
            require(block.chainid == ANVIL_CHAIN_ID, "set initial SHAPES_FEE_RECIPIENT");
            feeRecipient = msg.sender;
        }

        require(
            feeBps <= MAX_SANE_FEE_BPS || vm.envOr("SHAPES_ALLOW_HIGH_FEE", false),
            "fee bps above the sanity ceiling: set SHAPES_ALLOW_HIGH_FEE=true to confirm"
        );
        require(
            feeRecipient.code.length == 0 || vm.envOr("SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT", false),
            "fee recipient is a contract: a reverting receive would block minting until admin updates it. "
            "Set SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT=true if it is audited to always accept ETH"
        );

        // Shapes derives the genesis seed from the previous block. A fresh local Anvil chain is
        // still at block 0 during forge's simulation, although the broadcast transaction mines in
        // block 1. Advance only that simulation so the constructor cannot underflow.
        if (block.number == 0) vm.roll(1);

        vm.startBroadcast();

        renderer = existingRenderer == address(0) ? new ShapeRenderer() : ShapeRenderer(existingRenderer);

        collection = new ShapeCollection(address(renderer));

        shapes = new Shapes{value: Denominations.amountAt(0)}(
            feeBps, feeRecipient, address(renderer), address(collection)
        );
        lens = new ShapeLens(address(shapes));
        house = new ShapeAuctionHouse(address(shapes));

        vm.stopBroadcast();

        // Prove the constructor configuration and pointer defaults landed as intended.
        // The fee rate is immutable. Admin may redirect future fees and may replace the renderer,
        // positions and market pointers until each independent lock is used.
        require(shapes.feeBps() == feeBps, "fee bps mismatch");
        require(shapes.feeRecipient() == feeRecipient, "fee recipient mismatch");
        require(shapes.renderer() == address(renderer), "renderer mismatch");
        _requirePointersUnset(shapes);
        require(shapes.supportsInterface(type(IERC721Value).interfaceId), "draft ERC-8060 interface missing");
        require(address(renderer).code.length != 0, "renderer has no code");
        require(shapes.collection() == address(collection), "collection mismatch");
        require(collection.renderer() == address(renderer), "collection points at another renderer");

        // `vm.startBroadcast()` changes the sender of the CREATEs. In a test that calls this
        // script, that sender is intentionally not the test contract (`msg.sender` here).
        // Prove the four deployment-bound roles agree; live wrappers separately pin this
        // address to their explicitly selected sender.
        address deployedAdmin = shapes.admin();
        require(shapes.ownerOf(0) == deployedAdmin, "Shape #0 owner/admin mismatch");
        require(shapes.owner() == deployedAdmin, "contract owner/admin mismatch");
        require(shapes.artist() == deployedAdmin, "artist/admin mismatch");
        require(shapes.artistReleaseHash() == bytes32(0), "artist attribution should start unsigned");
        require(shapes.artistSignature().length == 0, "artist signature should start empty");
        require(shapes.backingOf(0) == Denominations.amountAt(0), "Shape #0 backing mismatch");
        require(shapes.totalMinted() == 1, "permissionless minting should begin at #1");

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
        console.log("contract owner ", shapes.owner());
        console.log("admin         ", shapes.admin());
        console.log("artist        ", shapes.artist());
        console.log("");
        console.log("Fee rate and reserve rules are immutable. Admin may redirect future mint fees.");
        console.log("Shape #0 represents collectible ownership.");
        console.log("Presentation, positions and market settings are independently lockable.");

        // Runs last: the probe advances simulated token state, so every check and log above it
        // reads a fresh collection.
        _assertLensEquivalence(shapes, lens);
    }
}

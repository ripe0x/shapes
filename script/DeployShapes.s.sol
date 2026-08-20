// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";

/// @notice Deploys the renderer, the collection metadata contract, the token, and the auction house.
///
/// @dev The mint fee and the fee recipient are deployment parameters, not source constants:
///      both are `immutable` on the deployed contract and can never be changed afterwards, so
///      they must be chosen deliberately here.
///
///        SHAPES_FEE_BPS        mint fee in basis points of backing. Defaults to 100 (1%).
///        SHAPES_FEE_RECIPIENT  where fees are forwarded. Must be set off local chains.
///        SHAPES_RENDERER       reuse an already-deployed renderer instead of deploying one.
///      Token 0 is minted in the same broadcast, to the deployer. Nothing reserves it: minting
///      is permissionless, so between deployment and that mint anyone watching could take id 0,
///      and it cannot be renumbered. Deploy through a private mempool if that matters.
///
///        SHAPES_TITLE_HOLDER   who holds title to Shapes at deployment. Defaults to the
///                              deployer. Carries no authority; see `IShapes.titleHolder`.
///
///      The auction house is deployed alongside but wired only to `Shapes`: it holds no
///      privileged position over the token and the token knows nothing about it, so a broken
///      house costs an auction rather than the collection.
///
///      Local:
///        forge script script/DeployShapes.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
///      Live (dry run first, always):
///        SHAPES_FEE_RECIPIENT=0x... forge script script/DeployShapes.s.sol --rpc-url $RPC
///        SHAPES_FEE_RECIPIENT=0x... forge script script/DeployShapes.s.sol --rpc-url $RPC \
///          --broadcast --verify
contract DeployShapes is Script {
    uint256 internal constant DEFAULT_FEE_BPS = 100; // 1%
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    /// @dev A sanity ceiling, not a protocol rule. The fee is immutable, and a fat-fingered
    ///      one would be permanent. 1000 bps is 10% of backing; anything above that is almost
    ///      certainly a mistake. Override deliberately if you really mean it.
    uint256 internal constant MAX_SANE_FEE_BPS = 1000;

    /// @dev Token 0 is minted at the smallest denomination: the densest artwork the ladder has.
    uint256 internal constant TOKEN_ZERO_BACKING = 0.01 ether;

    function run()
        external
        returns (
            ShapeRenderer renderer,
            ShapeCollection collection,
            Shapes shapes,
            ShapeAuctionHouse house,
            uint256 genesisId
        )
    {
        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        address feeRecipient = vm.envOr("SHAPES_FEE_RECIPIENT", address(0));
        address existingRenderer = vm.envOr("SHAPES_RENDERER", address(0));
        // Title is conferred at deployment and cannot be zero. Defaulting to the deployer keeps
        // the local run a one-liner; it is a deliberate choice on a live chain.
        address titleHolder = vm.envOr("SHAPES_TITLE_HOLDER", msg.sender);

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

        shapes = new Shapes(feeBps, feeRecipient, address(renderer), address(collection), titleHolder);
        house = new ShapeAuctionHouse(address(shapes));

        // Token 0 is minted here, in the same broadcast as the deployment, because nothing
        // reserves it. Minting is permissionless and there is no owner-only path, so from the
        // moment the contract exists the first caller to `mint` takes id 0 — and an id cannot be
        // renumbered afterwards. Minting immediately, from the deployer, before the address is
        // public anywhere, closes the window to the gap between two of its own transactions.
        // A live deployment that cares should also go through a private mempool.
        //
        // 0.01 ETH: the smallest denomination, so the densest artwork. Every later addition can
        // only make it sparser.
        genesisId = shapes.mint{value: TOKEN_ZERO_BACKING + shapes.mintFeeFor(TOKEN_ZERO_BACKING)}(
            TOKEN_ZERO_BACKING
        );

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
        require(shapes.titleHolder() == titleHolder, "title holder mismatch");
        require(shapes.titleSince() != 0, "title timestamp not recorded");
        require(collection.renderer() == address(renderer), "collection points at another renderer");

        // Smoke the renderer through the interface the token will actually use. A renderer
        // that cannot produce metadata would leave every token permanently unrenderable.
        require(
            bytes(
                IShapeRenderer(address(renderer))
                    .tokenURI(bytes32(0), 0.01 ether, 1, 1, false, 0, 0, "Shape ", "x")
            )
            .length > 500,
            "renderer produced no metadata"
        );
        require(
            bytes(
                IShapeRenderer(address(renderer))
                    .tokenURI(bytes32(uint256(1)), 100 ether, 10_000, 10_000, true, 6, 0, "Shape ", "x")
            )
            .length > 500,
            "renderer produced no metadata at 100 ETH"
        );

        // Contract-level metadata is what a marketplace reads for the collection itself.
        require(bytes(shapes.contractURI()).length > 500, "collection produced no metadata");

        // The house is wired to the token and to nothing else. It holds no role on the token, so
        // this is the whole of the relationship.
        require(house.shapes() == address(shapes), "auction house points at another token");
        require(house.auctionCount() == 0, "auction house is not fresh");

        // The genesis token exists and belongs to the deployer, in the same broadcast that
        // created the contract. Nothing else could have taken id 0.
        require(genesisId == 0, "genesis token is not id 0");
        require(shapes.ownerOf(0) == msg.sender, "genesis token did not land with the deployer");
        require(shapes.backingOf(0) == TOKEN_ZERO_BACKING, "genesis backing is wrong");

        console.log("chain id      ", block.chainid);
        console.log("ShapeRenderer ", address(renderer));
        console.log("ShapeCollection", address(collection));
        console.log("Shapes        ", address(shapes));
        console.log("AuctionHouse  ", address(house));
        console.log("fee (bps)     ", feeBps);
        console.log("fee recipient ", feeRecipient);
        console.log("owner         ", shapes.owner());
        console.log("title holder  ", shapes.titleHolder());
        console.log("token 0 owner ", shapes.ownerOf(0));
        console.log("");
        console.log("Fee terms and reserve rules are immutable. Ownership is transferable.");
        console.log("Presentation and position resolver settings are independently lockable.");
    }
}

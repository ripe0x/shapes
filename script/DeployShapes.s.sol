// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";

/// @notice Deploys the renderer and then the token, wiring the renderer in immutably.
///
/// @dev The mint fee and the fee recipient are deployment parameters, not source constants:
///      both are `immutable` on the deployed contract and can never be changed afterwards, so
///      they must be chosen deliberately here.
///
///        SHAPES_FEE_BPS        mint fee in basis points of backing. Defaults to 100 (1%).
///        SHAPES_FEE_RECIPIENT  where fees are forwarded. Must be set off local chains.
///        SHAPES_RENDERER       reuse an already-deployed renderer instead of deploying one.
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

    function run() external returns (ShapeRenderer renderer, Shapes shapes) {
        uint256 feeBps = vm.envOr("SHAPES_FEE_BPS", DEFAULT_FEE_BPS);
        address feeRecipient = vm.envOr("SHAPES_FEE_RECIPIENT", address(0));
        address existingRenderer = vm.envOr("SHAPES_RENDERER", address(0));

        if (feeRecipient == address(0)) {
            // On a local chain, defaulting to the deployer keeps `forge script` a one-liner.
            // Anywhere else, an unset recipient is almost certainly a mistake, and it would be
            // permanent.
            require(
                block.chainid == ANVIL_CHAIN_ID,
                "set SHAPES_FEE_RECIPIENT: it is immutable once deployed"
            );
            feeRecipient = msg.sender;
        }

        require(
            feeBps <= MAX_SANE_FEE_BPS || vm.envOr("SHAPES_ALLOW_HIGH_FEE", false),
            "fee bps above the sanity ceiling: set SHAPES_ALLOW_HIGH_FEE=true to confirm"
        );
        require(feeRecipient.code.length == 0 || vm.envOr("SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT", false),
            "fee recipient is a contract: a reverting receive would brick minting forever. "
            "Set SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT=true if it is audited to always accept ETH"
        );

        vm.startBroadcast();

        renderer = existingRenderer == address(0)
            ? new ShapeRenderer()
            : ShapeRenderer(existingRenderer);

        shapes = new Shapes(feeBps, feeRecipient, address(renderer));

        vm.stopBroadcast();

        // Everything below is immutable from here on, so prove it landed as intended rather
        // than trusting the constructor arguments.
        require(shapes.feeBps() == feeBps, "fee bps mismatch");
        require(shapes.feeRecipient() == feeRecipient, "fee recipient mismatch");
        require(shapes.renderer() == address(renderer), "renderer mismatch");
        require(address(renderer).code.length != 0, "renderer has no code");

        // Smoke the renderer through the interface the token will actually use. A renderer
        // that cannot produce metadata would leave every token permanently unrenderable.
        require(
            bytes(IShapeRenderer(address(renderer)).tokenURI(bytes32(0), 0.01 ether, 1, 1, false))
                .length > 500,
            "renderer produced no metadata"
        );
        require(
            bytes(
                IShapeRenderer(address(renderer)).tokenURI(
                    bytes32(uint256(1)), 100 ether, 10_000, 10_000, true
                )
            ).length > 500,
            "renderer produced no metadata at 100 ETH"
        );

        console.log("chain id      ", block.chainid);
        console.log("ShapeRenderer ", address(renderer));
        console.log("Shapes        ", address(shapes));
        console.log("fee (bps)     ", feeBps);
        console.log("fee recipient ", feeRecipient);
        console.log("owner         ", shapes.owner());
        console.log("");
        console.log("Fee terms and the reserve are immutable. The owner's only power is the");
        console.log("renderer: setRenderer to fix a rendering bug, lockRenderer to freeze it.");
    }
}

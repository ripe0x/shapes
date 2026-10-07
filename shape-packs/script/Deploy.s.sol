// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {IShapes} from "shapes/interfaces/IShapes.sol";
import {IShapePacks} from "../src/interfaces/IShapePacks.sol";
import {ShapePackRenderer} from "../src/ShapePackRenderer.sol";
import {ShapePacks} from "../src/ShapePacks.sol";

/// @notice Deploys `ShapePackRenderer` and `ShapePacks` against an already-deployed Shapes token,
///         reads every constructor input back from the chain, and records the result in
///         `deployments/<chainId>.json`.
///
/// @dev One script for every chain. The chain id decides which Shapes address is acceptable;
///      every other input is a value passed in the environment (see script/deploy.sh and
///      script/env/*.env), not a fork of this file.
///
///        SHAPES   the Shapes token to wrap. Required. On mainnet it must be the deployed
///                 collection, `MAINNET_SHAPES`. On Sepolia and anvil any nonzero address is
///                 accepted (anvil: whatever the local flow deployed).
///        ADMIN    the presentation admin of `ShapePacks`. Defaults to the broadcaster when unset
///                 or zero. The admin reaches the renderer and the metadata copy only, never
///                 custody; hold it in a multisig and lock presentation once the art is final.
///
///      The deployer is the account that signs the broadcast. Under `--broadcast` the script
///      writes the record; a dry run (simulation only) writes nothing.
contract Deploy is Script {
    address internal constant MAINNET_SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;

    uint256 internal constant MAINNET = 1;
    uint256 internal constant SEPOLIA = 11155111;
    uint256 internal constant ANVIL = 31337;

    function run() external returns (ShapePackRenderer renderer, ShapePacks packs) {
        address shapes = vm.envAddress("SHAPES");
        _requireShapesForChain(shapes);

        address adminInput = vm.envOr("ADMIN", address(0));

        vm.startBroadcast();
        // After startBroadcast, `msg.sender` as seen through readCallers is the account that signs.
        (, address deployer,) = vm.readCallers();
        address admin = adminInput == address(0) ? deployer : adminInput;

        renderer = new ShapePackRenderer(shapes);
        packs = new ShapePacks(shapes, address(renderer), admin);
        vm.stopBroadcast();

        _readback(shapes, renderer, packs, admin);
        _record(shapes, renderer, packs, admin, deployer);
    }

    /// @dev Chain-id gate. Mainnet is pinned to the deployed collection so a mistyped address
    ///      cannot deploy a pack contract wrapping the wrong token.
    function _requireShapesForChain(address shapes) private view {
        require(shapes != address(0), "SHAPES is zero");
        require(shapes.code.length != 0, "SHAPES has no code on this chain");
        if (block.chainid == MAINNET) {
            require(shapes == MAINNET_SHAPES, "SHAPES is not the mainnet Shapes");
        } else if (block.chainid != SEPOLIA && block.chainid != ANVIL) {
            revert("unsupported chain");
        }
    }

    /// @dev Everything the constructors were handed, read back through the public surface, plus the
    ///      derived floor and the ERC-165 claim. Runs against the simulated state, so it also
    ///      gates a dry run.
    function _readback(address shapes, ShapePackRenderer renderer, ShapePacks packs, address admin)
        private
        view
    {
        require(packs.shapes() == shapes, "packs.shapes mismatch");
        require(packs.renderer() == address(renderer), "packs.renderer mismatch");
        require(packs.admin() == admin, "packs.admin mismatch");
        require(packs.MIN_PACK_VALUE() == 3 * IShapes(shapes).unit(), "MIN_PACK_VALUE mismatch");
        require(renderer.shapes() == shapes, "renderer.shapes mismatch");
        require(packs.supportsInterface(type(IShapePacks).interfaceId), "IShapePacks interface missing");
        require(address(renderer).code.length != 0, "renderer missing code");
        require(address(packs).code.length != 0, "packs missing code");
    }

    /// @dev `deployments/<chainId>.json`. Amounts are decimal strings so a JSON reader without
    ///      256-bit integers does not round them. `blockNumber` is the block the script ran
    ///      against; the broadcast transactions land at or just after it.
    function _record(
        address shapes,
        ShapePackRenderer renderer,
        ShapePacks packs,
        address admin,
        address deployer
    ) private {
        if (
            !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
                && !vm.isContext(VmSafe.ForgeContext.ScriptResume)
        ) {
            return;
        }

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "shapes", shapes);
        vm.serializeAddress(k, "shapePacks", address(packs));
        vm.serializeAddress(k, "shapePackRenderer", address(renderer));
        vm.serializeAddress(k, "admin", admin);
        vm.serializeString(k, "minPackValueWei", vm.toString(packs.MIN_PACK_VALUE()));
        vm.serializeAddress(k, "deployer", deployer);
        string memory json = vm.serializeUint(k, "blockNumber", block.number);

        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}

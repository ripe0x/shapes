// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeLens} from "../src/ShapeLens.sol";
import {ShapeChildPreview, ShapeState} from "../src/interfaces/IShapeCapabilities.sol";
import {Denominations} from "../src/lib/Denominations.sol";

/// @title LensEquivalence
/// @notice Deploy-time proof that a `ShapeLens` previews exactly what its `Shapes` executes.
///
/// @dev `ShapeLens.previewCompose` recomputes a compose result by calling the same externally
///      linked `ComposeCompute` library `Shapes.compose` calls, which in turn calls the
///      `GeometrySampling` and `InkGenes` deployments linked into it. Bit-identical previews hold
///      only while the lens and the token resolve those calls to the same library code. Neither
///      contract records which deployment it linked, `foundry.toml` declares no fixed
///      `libraries`, and every `forge script --broadcast` deploys fresh library instances, so a
///      lens built from a different commit or linked against a different `ComposeCompute` would
///      preview module bytes and ink genes the token does not produce, with nothing on chain
///      contradicting it.
///
///      `_assertLensEquivalence` exercises the property rather than asserting it structurally: it
///      mints a 0.05 ETH probe token, splits it into five 0.01 ETH children so they carry
///      materialized module bytes, composes them back to 0.05 ETH, and requires the lens preview
///      to equal the resulting core state field for field, sampled module bytes included.
///
///      The probe runs outside `vm.startBroadcast`, from a pranked EOA funded with `vm.deal`.
///      Every call executes inside the `forge script` simulation against the same runtime
///      bytecode and the same linked libraries that go on chain, and none of it is recorded for
///      broadcast: no probe token reaches the target chain, no ETH is spent, no token ids are
///      consumed. A mismatch reverts the script before any transaction is sent.
///
///      Because the probe does advance the simulated token state, call it after any check or log
///      that reads `totalMinted`, `totalSupply` or per-token state.
///
///      Scope: both the compose and split halves compare a lens preview's module bytes against
///      the core mutator's stored result, so both exercise the same linked `GeometrySampling`
///      deployment the lens and the token resolve their sampling calls to.
abstract contract LensEquivalence is Script {
    /// @dev One index-1 (0.05 ETH) parent, split into five index-0 (0.01 ETH) children, composed
    ///      back to index 1. The smallest probe that produces materialized donor modules on both
    ///      sides of a compose.
    uint8 internal constant PROBE_PARENT_INDEX = 1;
    uint8 internal constant PROBE_CHILD_INDEX = 0;
    uint256 internal constant PROBE_CHILD_COUNT = 5;

    /// @notice Reverts a chain-id-1 broadcast if the source still carries the testnet-scaled ladder.
    /// @dev Every deploy script here shares this check by inheriting from `LensEquivalence`, so the
    ///      guard lives once instead of once per script. Denominations.sol is scaled 100x for
    ///      sepolia (UNIT = 0.0001 ether); a mainnet deploy from that source would ship the wrong
    ///      immutable economics with no other signal to catch it.
    function _guardMainnetLadder() internal view {
        if (block.chainid == 1) {
            require(
                Denominations.UNIT == 0.01 ether,
                "mainnet deploy blocked: Denominations carries the testnet-scaled ladder; restore UNIT = 0.01 ether"
            );
        }
    }

    /// @notice Reverts unless `lens` previews `shapes`'s own compose and split results exactly.
    /// @param shapes The deployed token.
    /// @param lens The lens under test. Must already point at `shapes`.
    function _assertLensEquivalence(Shapes shapes, ShapeLens lens) internal {
        require(address(lens.shapes()) == address(shapes), "lens points at another token");

        // `Shapes._mintBatch` reads `blockhash(block.number - 1)`, which underflows at genesis.
        // A freshly started anvil simulates at block 0.
        if (block.number == 0) vm.roll(1);

        // `mintTo` below reverts `MintNotOpen` until `block.timestamp >= shapes.mintStart()`. The
        // probe never broadcasts, so warping the local simulated clock forward proves nothing
        // false about the deployed contract: on chain, `mintStart` still gates every real mint.
        if (block.timestamp < shapes.mintStart()) vm.warp(shapes.mintStart());

        address probe = address(uint160(uint256(keccak256("shapes.lens.equivalence.probe"))));
        uint256 amountWei = Denominations.amountAt(PROBE_PARENT_INDEX);
        uint256 cost = amountWei + shapes.mintFee();
        vm.deal(probe, cost);

        vm.startPrank(probe);
        uint256 parentId = shapes.mintTo{value: cost}(amountWei, probe);

        uint8[] memory outDenoms = new uint8[](PROBE_CHILD_COUNT);
        for (uint256 i = 0; i < PROBE_CHILD_COUNT; ++i) {
            outDenoms[i] = PROBE_CHILD_INDEX;
        }

        ShapeChildPreview[] memory previewChildren = lens.previewSplit(parentId, outDenoms);
        uint256[] memory childIds = shapes.split(parentId, outDenoms);
        require(previewChildren.length == childIds.length, "previewSplit child count differs from split");

        for (uint256 i = 0; i < childIds.length; ++i) {
            uint256 childId = childIds[i];
            require(previewChildren[i].seed == shapes.seedOf(childId), "previewSplit seed differs from split");
            require(
                previewChildren[i].originCount == shapes.originCountOf(childId),
                "previewSplit origin count differs from split"
            );
            require(
                previewChildren[i].inkGene == shapes.inkGeneOf(childId),
                "previewSplit ink gene differs from split"
            );
            require(
                previewChildren[i].faceValueWei == shapes.backingOf(childId),
                "previewSplit denomination differs from split"
            );
            // Compose donors must carry materialized geometry, or the sampler below reads the
            // seed-derived fallback on both sides and the comparison proves less than it looks.
            require(shapes.modulesOf(childId).length != 0, "split child has no materialized modules");
            require(
                keccak256(previewChildren[i].modules) == keccak256(shapes.modulesOf(childId)),
                "lens and token do not link the same library: previewSplit modules differ from split"
            );
        }

        uint256 survivorId = childIds[0];
        uint256[] memory burnIds = new uint256[](childIds.length - 1);
        for (uint256 i = 1; i < childIds.length; ++i) {
            burnIds[i - 1] = childIds[i];
        }

        ShapeState memory preview = lens.previewCompose(survivorId, burnIds);
        shapes.compose(survivorId, burnIds);
        vm.stopPrank();

        // Empty preview bytes would match empty stored bytes without the sampler having run.
        require(preview.modules.length != 0, "previewCompose returned no module bytes");
        require(
            keccak256(preview.modules) == keccak256(shapes.modulesOf(survivorId)),
            "lens and token do not link the same library: previewCompose modules differ from compose"
        );
        require(
            preview.inkGene == shapes.inkGeneOf(survivorId),
            "lens and token do not link the same library: previewCompose ink gene differs from compose"
        );
        require(
            preview.originCount == shapes.originCountOf(survivorId),
            "previewCompose origin count differs from compose"
        );
        require(
            preview.faceValueWei == shapes.backingOf(survivorId),
            "previewCompose denomination differs from compose"
        );
        require(
            preview.denominationIndex == PROBE_PARENT_INDEX,
            "probe did not compose back to its parent denomination"
        );

        console.log("lens equivalence  ok (previewSplit and previewCompose match core execution)");
    }
}

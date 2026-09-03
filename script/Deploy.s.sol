// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";

import {Shapes} from "../src/Shapes.sol";
import {ShapeAuctionHouse} from "../src/ShapeAuctionHouse.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {IERC721Value} from "../src/interfaces/IERC721Value.sol";
import {IShapeRenderer} from "../src/interfaces/IShapeRenderer.sol";
import {IShapes} from "../src/interfaces/IShapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";
import {Script} from "forge-std/Script.sol";

/// @notice Deploys the renderer, token, collection metadata and auction house, points the token at
///         the collection, and registers the auction house as the token's `market` pointer.
///
/// @dev One script for every chain. Chain id selects the required ladder and the fee-recipient
///      default; every other input is a value passed in by the caller (see script/deploy.sh and
///      script/env/*.env), not a fork of this file.
///
///      `mintFee` is admin-adjustable afterward via `setMintFee`, up to the on-chain cap of one
///      denomination unit. The initial admin is the deployer and may redirect where future fees
///      accrue or change the fee amount, so the initial recipient must be chosen here.
///
///        SHAPES_MINT_FEE_WEI   flat fee per Shape in wei. Defaults to one tenth of a
///                              denomination unit.
///        SHAPES_FEE_RECIPIENT  where fees accrue and, by default, are sent by `withdrawFees`.
///                              Required off chain id 31337, where it defaults to the deployer.
///        SHAPES_RENDERER       reuse an already-deployed renderer instead of deploying one.
///        SHAPES_MINT_START     unix timestamp at or after which mintBatch/mintBatchTo accept
///                              calls. Defaults to 0, which opens them immediately. Immutable
///                              once deployed.
///
///      Every view and every preview lives on `Shapes` itself, so there is nothing else to deploy
///      for reads and no second address for a client to discover.
///
///      The auction house holds no privileged position over the token. Registering it as the
///      `market` pointer is discovery only: no token or reserve operation reads that pointer, and
///      a broken house costs an auction rather than the collection.
///
///      Deployment sends the minimum denomination to `Shapes`, which atomically mints backed
///      Shape #0 to the deployer. Its holder is returned by `owner()` and `ownerToken()` but
///      receives no administrative permissions. Permissionless artwork minting therefore begins
///      at #1. The deployer is also the initial `admin()` and may transfer or renounce that
///      separate role. Admin can redirect where future mint fees accrue and adjust the fee amount
///      within its compile-time cap, but reaches no balance already accrued to a previous
///      recipient, and cannot touch backing or redemption.
///
///      The collection is constructed with the token's address and therefore cannot be a
///      constructor argument to the token. The token's collection pointer starts zero and
///      `setCollection` fills it in the same broadcast, before any other call.
///
///      No seeding here. Seeding an already-deployed Shapes is script/SeedShapes.s.sol.
///
///      Run through script/deploy.sh, which supplies the chain-specific RPC, wallet and env
///      values from script/env/<name>.env. Direct invocation:
///
///        forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract Deploy is Script {
    uint256 internal constant DEFAULT_MINT_FEE = Denominations.UNIT / 10;
    uint256 internal constant ANVIL_CHAIN_ID = 31337;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    uint256 internal constant MAINNET_CHAIN_ID = 1;

    /// @dev Mirrors the on-chain cap (one denomination unit) the constructor enforces
    ///      unconditionally. Checked here first only so a fat-fingered value fails with a clear
    ///      script error instead of the constructor's revert; there is no override, because none
    ///      would change the outcome on chain.
    uint256 internal constant MAX_SANE_MINT_FEE = Denominations.UNIT;

    error WrongLadder(string compiled, string expected);
    error UnsupportedChain(uint256 chainid);

    /// @dev The market pointer names the auction house deployed above; positions starts empty
    ///      because no positions contract exists yet. Neither is locked, so the admin can still
    ///      replace either one.
    function _requirePointers(Shapes shapes, address house) private view {
        (address positions, bool positionsLocked) = shapes.positions();
        (address market, bool marketLocked) = shapes.market();
        require(positions == address(0), "positions should start empty");
        require(market == house, "market should name the deployed auction house");
        require(!positionsLocked, "positions should start unlocked");
        require(!marketLocked, "market should start unlocked");
    }

    /// @dev The ladder is compiled in and the amounts it names are permanent once deployed.
    ///      Mainnet requires the mainnet ladder, Sepolia requires the testnet ladder, and anvil
    ///      accepts either since a local chain funds any rung. Any other chain id is refused
    ///      outright: nothing here knows what ladder a chain nobody named should carry.
    function _requireLadderForChain() internal view {
        uint256 id = block.chainid;
        if (id == ANVIL_CHAIN_ID) return;

        string memory expected;
        if (id == MAINNET_CHAIN_ID) {
            expected = "mainnet";
        } else if (id == SEPOLIA_CHAIN_ID) {
            expected = "testnet";
        } else {
            revert UnsupportedChain(id);
        }

        if (keccak256(bytes(Denominations.LADDER_NAME)) != keccak256(bytes(expected))) {
            revert WrongLadder(Denominations.LADDER_NAME, expected);
        }
    }

    function run()
        external
        returns (ShapeRenderer renderer, ShapeCollection collection, Shapes shapes, ShapeAuctionHouse house)
    {
        _requireLadderForChain();

        uint256 mintFee = vm.envOr("SHAPES_MINT_FEE_WEI", DEFAULT_MINT_FEE);
        address feeRecipient = vm.envOr("SHAPES_FEE_RECIPIENT", address(0));
        address existingRenderer = vm.envOr("SHAPES_RENDERER", address(0));
        uint64 mintStart = uint64(vm.envOr("SHAPES_MINT_START", uint256(0)));

        if (feeRecipient == address(0)) {
            // On a local chain, defaulting to the deployer keeps `forge script` a one-liner.
            // Anywhere else, an unset initial recipient is almost certainly a mistake.
            require(block.chainid == ANVIL_CHAIN_ID, "set initial SHAPES_FEE_RECIPIENT");
            feeRecipient = msg.sender;
        }

        require(
            mintFee <= MAX_SANE_MINT_FEE,
            "flat fee above the on-chain cap (one denomination unit): the constructor would reject it"
        );
        // A recipient that cannot receive plain ETH would block its own `withdrawFees` call
        // permanently: a later redirect starts a new accrual for the new recipient rather than
        // recovering this one's. Prove acceptance here instead of gating on code length, since a
        // contract (a 0xSplits wallet, for example) can accept ETH just as reliably as an EOA.
        // The probe runs the transfer from its own throwaway address rather than this script's:
        // forge refuses `address(this)` inside a Script contract since its address is ephemeral.
        // `vm.deal`/`call` run only in this simulation, never as a broadcast transaction.
        EthAcceptanceProbe probe = new EthAcceptanceProbe();
        vm.deal(address(probe), 1);
        require(
            probe.probe(feeRecipient), "fee recipient rejects plain ETH: withdrawFees would revert forever"
        );

        // Shapes derives the genesis seed from the previous block. A fresh local chain is still
        // at block 0 during forge's simulation, although the broadcast transaction mines in
        // block 1. Advance only that simulation so the constructor cannot underflow.
        if (block.number == 0) vm.roll(1);

        vm.startBroadcast();

        renderer = existingRenderer == address(0) ? new ShapeRenderer() : ShapeRenderer(existingRenderer);

        shapes =
            new Shapes{value: Denominations.amountAt(0)}(mintFee, feeRecipient, address(renderer), mintStart);

        // The collection is constructed with the token's address, so it cannot be a constructor
        // argument to the token. `tokenURI` and `contractURI` revert `CollectionNotSet` until this
        // pointer is set, which is why it is set before anything else runs.
        collection = new ShapeCollection(renderer, shapes);
        shapes.setCollection(address(collection));

        house = new ShapeAuctionHouse(address(shapes));

        // Discovery only. `setPointer` requires the target to answer ERC-165 for
        // `IShapeAuctionHouse`, and no token or reserve operation ever reads the pointer.
        shapes.setPointer(uint8(IShapes.Pointer.Market), address(house));

        vm.stopBroadcast();

        // Prove the constructor configuration and pointer defaults landed as intended.
        require(shapes.mintFee() == mintFee, "mint fee mismatch");
        require(shapes.mintStart() == mintStart, "mint start mismatch");

        // A future mint start is provable right here, outside the broadcast: `_mintBatch` checks
        // it before anything else, so the revert fires regardless of amount or quantity.
        if (mintStart > block.timestamp) {
            vm.expectRevert(IShapes.MintNotOpen.selector);
            shapes.mintBatch(Denominations.amountAt(0), 1);
        }

        require(shapes.feeRecipient() == feeRecipient, "fee recipient mismatch");
        require(shapes.renderer() == address(renderer), "renderer mismatch");
        _requirePointers(shapes, address(house));
        require(shapes.supportsInterface(type(IERC721Value).interfaceId), "draft ERC-8060 interface missing");
        require(address(renderer).code.length != 0, "renderer missing code");
        require(shapes.collection() == address(collection), "collection mismatch");
        require(collection.renderer() == address(renderer), "collection points at another renderer");
        require(collection.shapes() == address(shapes), "collection points at another token");
        require(
            keccak256(bytes(collection.tokenNamePrefix())) == keccak256(bytes("Shape ")),
            "default token name prefix mismatch"
        );
        require(bytes(collection.description()).length > 100, "default description missing");
        require(
            bytes(collection.ownerTokenDescription()).length > 100, "default owner token description missing"
        );

        // `vm.startBroadcast()` changes the sender of the CREATEs. In a test that calls this
        // script, that sender is intentionally not the test contract (`msg.sender` here).
        // Prove the roles agree; live wrappers separately pin this address to their explicitly
        // selected sender.
        address deployedAdmin = shapes.admin();
        require(shapes.ownerOf(0) == deployedAdmin, "Shape #0 owner/admin mismatch");
        require(shapes.owner() == deployedAdmin, "contract owner/admin mismatch");
        require(shapes.artist() == deployedAdmin, "artist/admin mismatch");
        require(shapes.ownerToken() == 0, "owner token should be Shape #0");
        require(shapes.artistReleaseHash() == bytes32(0), "artist attribution should start unsigned");
        require(shapes.artistSignature().length == 0, "artist signature should start empty");
        require(shapes.backingOf(0) == Denominations.amountAt(0), "Shape #0 backing mismatch");
        require(shapes.totalMinted() == 1, "permissionless minting should begin at #1");
        require(shapes.denominationCount() == 9, "denomination count mismatch");
        require(shapes.denominationAt(0) == Denominations.amountAt(0), "minimum denomination mismatch");
        require(shapes.denomIndexOf(0) == 0, "Shape #0 denomination mismatch");
        require(shapes.exists(0), "Shape #0 must exist");

        // Smoke the renderer through the interface the token will actually use. A renderer
        // that cannot produce metadata would leave every token permanently unrenderable.
        require(
            bytes(
                IShapeRenderer(address(renderer))
                    .tokenURI(bytes32(0), Denominations.amountAt(0), 1, 1, false, 0, 0, "Shape ", "x", false)
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
                        "x",
                        false
                    )
            )
            .length > 500,
            "renderer produced no metadata at the apex"
        );

        // Contract-level metadata is what a marketplace reads for the collection itself.
        require(bytes(shapes.contractURI()).length > 500, "collection produced no metadata");

        // The house is wired to the token and to nothing else. It holds no role on the token, so
        // this is the whole of the relationship.
        require(house.shapes() == address(shapes), "auction house points at another token");
        require(house.auctionCount() == 0, "auction house is not fresh");

        console.log("chainId=%s", block.chainid);
        console.log("renderer=%s", address(renderer));
        console.log("collection=%s", address(collection));
        console.log("shapes=%s", address(shapes));
        console.log("auctionHouse=%s", address(house));
        console.log("mintFeeWei=%s", mintFee);
        console.log("mintStart=%s", mintStart);
        console.log("feeRecipient=%s", feeRecipient);
        console.log("admin=%s", shapes.admin());
        console.log("tokenNamePrefix=%s", collection.tokenNamePrefix());
        console.log("description=%s", collection.description());
        console.log("ownerTokenDescription=%s", collection.ownerTokenDescription());
    }
}

/// @dev Forwards its own balance to `target` in a plain ETH transfer. Exists only so `Deploy` can
///      prove a fee recipient accepts ETH without referencing its own (ephemeral) address.
contract EthAcceptanceProbe {
    function probe(address target) external returns (bool accepted) {
        (accepted,) = target.call{value: address(this).balance}("");
    }
}

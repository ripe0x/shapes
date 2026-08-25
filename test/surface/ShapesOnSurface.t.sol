// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ShapesMinter} from "../../src/surface/ShapesMinter.sol";
import {ShapesSurfaceRenderer} from "../../src/surface/ShapesSurfaceRenderer.sol";
import {ISurfaceFactory, SurfaceConfig} from "../../src/surface/ISurface.sol";
import {Path, PathType} from "../../src/surface/ILineage.sol";
import {ShapeRenderer} from "../../src/ShapeRenderer.sol";
import {Denominations} from "../../src/lib/Denominations.sol";

/// @dev The pooled-collection members the test reads directly.
interface ICollection {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function totalSupply() external view returns (uint256);
    function isMinter(address minter) external view returns (bool);
}

/// @notice Shapes-on-Surface, exercised against the LIVE mainnet SurfaceFactory
///         via a fork. Deploys a real PooledSurface clone from the deployed
///         factory, attaches ShapesMinter + ShapesSurfaceRenderer, and runs the
///         full Shapes lifecycle (mint, redeem, compose, decompose, restore,
///         blacken) asserting the reserve invariant throughout.
contract ShapesOnSurfaceForkTest is Test {
    // Mainnet Surface protocol (recovered from the Homage clone's creation tx,
    // confirmed on-chain). deployments.mainnet.json in the foundation repo is
    // empty and not the source of truth.
    address internal constant SURFACE_FACTORY = 0xdB81d3F33EF3D84685486916E0d372E247558094;

    uint256 internal constant FEE_BPS = 100; // 1%

    ShapeRenderer internal pureRenderer;
    ShapesMinter internal minter;
    ShapesSurfaceRenderer internal surfaceRenderer;
    ICollection internal collection;
    address internal collectionAddr;

    address internal feeRecipient = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    // Deterministic CREATE addresses can hold pre-existing dust on a mainnet
    // fork, so the strict balance assertions are measured as deltas from these.
    uint256 internal minterSeedBalance;
    uint256 internal collectionSeedBalance;

    function feeOf(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string("https://ethereum-rpc.publicnode.com"));
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpc);
        } else {
            vm.createSelectFork(rpc, forkBlock);
        }
        require(SURFACE_FACTORY.code.length != 0, "factory not on this fork");

        pureRenderer = new ShapeRenderer();
        minter = new ShapesMinter(FEE_BPS, feeRecipient);
        surfaceRenderer = new ShapesSurfaceRenderer(address(pureRenderer), address(minter));

        SurfaceConfig memory cfg = SurfaceConfig({
            supplyCap: 0,
            royaltyBps: 0,
            royaltyReceiver: address(0),
            renderer: address(surfaceRenderer),
            rendererLocked: false,
            supplyLocked: false
        });

        address[] memory initialMinters = new address[](1);
        initialMinters[0] = address(minter);
        address[] memory creators = new address[](0);

        collectionAddr = ISurfaceFactory(SURFACE_FACTORY).createPooledSurface(
            "Shapes", "SHAPE", address(this), cfg, initialMinters, address(minter), creators
        );
        collection = ICollection(collectionAddr);

        minter.bind(collectionAddr, address(surfaceRenderer));

        minterSeedBalance = address(minter).balance;
        collectionSeedBalance = collectionAddr.balance;

        vm.deal(alice, 2_000 ether);
        vm.deal(bob, 2_000 ether);
    }

    /* ------------------------------ helpers ---------------------------- */

    function _mint(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = minter.mint{value: amount + feeOf(amount)}(amount, who);
    }

    function _assertSolvent() internal view {
        assertGe(
            address(minter).balance, minter.redeemableBacking(), "minter balance below redeemableBacking"
        );
        // The collection never gains ETH from any Shapes operation.
        assertEq(collectionAddr.balance, collectionSeedBalance, "collection must hold no ETH of ours");
    }

    /* ------------------------------ wiring ----------------------------- */

    function test_FactoryProducedARealSurface() public view {
        assertTrue(ISurfaceFactory(SURFACE_FACTORY).isSurface(collectionAddr), "factory knows collection");
        assertTrue(collection.isMinter(address(minter)), "minter authorized");
        assertEq(address(minter.collection()), collectionAddr, "minter bound");
    }

    /* ------------------------------ minting ---------------------------- */

    function test_MintAllNineDenominations() public {
        uint256 expectedBacking;
        for (uint256 i = 0; i < 9; ++i) {
            uint256 amount = Denominations.amountAt(i);
            uint256 id = _mint(alice, amount);
            expectedBacking += amount;

            assertEq(id, i + 1, "sequential ids from 1");
            assertEq(collection.ownerOf(id), alice, "owner is minter caller");
            assertEq(minter.backingOf(id), amount, "backing");
            assertEq(minter.redeemableBacking(), expectedBacking, "reserve");
            assertEq(minter.totalSupply(), i + 1, "supply");
            assertEq(minter.totalMinted(), i + 1, "minted");
        }
        assertEq(address(minter).balance, minterSeedBalance + expectedBacking, "balance equals backing");
        _assertSolvent();
    }

    function test_TokenURIRendersOnchain() public {
        uint256 id = _mint(alice, 1 ether);
        string memory uri = collection.tokenURI(id);
        assertTrue(bytes(uri).length > 0, "non-empty");
        // Delegated through the Surface core to ShapesSurfaceRenderer to the pure renderer.
        assertEq(_prefix(uri, 29), "data:application/json;base64,", "onchain json data uri");
    }

    function test_MintForwardsFee() public {
        uint256 before = feeRecipient.balance;
        _mint(alice, 1 ether);
        assertEq(feeRecipient.balance - before, feeOf(1 ether), "1% fee forwarded");
        assertEq(address(minter).balance, minterSeedBalance + 1 ether, "only backing retained");
        _assertSolvent();
    }

    function test_MintRejectsBadPayment() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ShapesMinter.IncorrectPayment.selector, 1 ether + feeOf(1 ether), 1 ether)
        );
        minter.mint{value: 1 ether}(1 ether, alice);
    }

    function test_MintRejectsUnsupportedDenomination() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ShapesMinter.UnsupportedDenomination.selector, 0.02 ether)
        );
        minter.mint{value: 0.0202 ether}(0.02 ether, alice);
    }

    /* ---------------------------- redemption --------------------------- */

    function test_RedeemReturnsExactBacking() public {
        uint256 id = _mint(alice, 5 ether);
        uint256 balBefore = alice.balance;

        vm.prank(alice);
        minter.redeem(id);

        assertEq(alice.balance - balBefore, 5 ether, "exact backing returned");
        assertEq(minter.redeemableBacking(), 0, "reserve drained");
        assertEq(minter.totalSupply(), 0, "supply back to zero");
        vm.expectRevert();
        collection.ownerOf(id); // burned

        // Lineage: a redeemed token records a terminal Burn edge.
        Path memory p = minter.pathOf(id);
        assertEq(uint256(p.pathType), uint256(PathType.Burn), "redeem records Burn");
        assertEq(p.target, 0, "burn has no successor");
        _assertSolvent();
    }

    function test_RedeemOnlyByOwner() public {
        uint256 id = _mint(alice, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ShapesMinter.NotShapeOwner.selector, id, bob));
        minter.redeem(id);
    }

    /* --------------------------- recomposition ------------------------- */

    function test_ComposeSumsBackingAndOrigins() public {
        // five 0.01 direct mints -> compose into one 0.05 with 5 origins (Complete)
        vm.prank(alice);
        uint256 first = minter.mintBatch{value: 5 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 5, alice);
        uint256[] memory burn = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) burn[i] = first + 1 + i;

        vm.prank(alice);
        uint256 survivor = minter.compose(first, burn);

        assertEq(survivor, first, "survivor keeps id");
        assertEq(minter.backingOf(survivor), 0.05 ether, "summed backing");
        assertEq(minter.originCountOf(survivor), 5, "summed origins");
        assertTrue(minter.isComplete(survivor), "5 origins on 0.05 is Complete");
        assertEq(minter.totalSupply(), 1, "four burned");
        assertEq(minter.redeemableBacking(), 0.05 ether, "reserve unchanged by compose");
        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert();
            collection.ownerOf(burn[i]);
            // Lineage: each burned input points at the survivor.
            Path memory p = minter.pathOf(burn[i]);
            assertEq(uint256(p.pathType), uint256(PathType.Continuation), "compose records Continuation");
            assertEq(p.target, survivor, "input became part of survivor");
        }
        assertFalse(minter.hasPath(survivor), "survivor persists, no forward edge");
        _assertSolvent();
    }

    function test_DecomposeThenRestoreRoundTrips() public {
        uint256 id = _mint(alice, 0.1 ether); // one direct 0.1, originCount 1
        bytes32 parentSeed = minter.seedOf(id);

        uint8[] memory outs = new uint8[](2);
        outs[0] = 1; // 0.05
        outs[1] = 1; // 0.05
        vm.prank(alice);
        uint256[] memory kids = minter.decompose(id, outs);

        assertEq(kids.length, 2, "two children");
        assertEq(minter.backingOf(kids[0]) + minter.backingOf(kids[1]), 0.1 ether, "backing conserved");
        // origins fill-to-capacity in listed order: parent had 1, first child (cap 5) takes it.
        assertEq(minter.originCountOf(kids[0]), 1, "origin to first child");
        assertEq(minter.originCountOf(kids[1]), 0, "second child is a Fragment");
        assertEq(minter.redeemableBacking(), 0.1 ether, "reserve unchanged by decompose");

        (uint16 childCount,) = minter.splitRecordOf(parentSeed);
        assertEq(childCount, 2, "split record written");

        // Lineage: the parent records a Split to both children.
        Path memory sp = minter.pathOf(id);
        assertEq(uint256(sp.pathType), uint256(PathType.Split), "decompose records Split");
        assertEq(sp.target, kids[0], "split target is first child");
        assertEq(uint256(sp.data), 2, "split data is child count");
        uint256[] memory recordedKids = minter.childrenOf(id);
        assertEq(recordedKids.length, 2, "two children recorded");
        assertEq(recordedKids[0], kids[0], "child 0");
        assertEq(recordedKids[1], kids[1], "child 1");

        uint256[] memory childIds = new uint256[](2);
        childIds[0] = kids[0];
        childIds[1] = kids[1];
        vm.prank(alice);
        uint256 restored = minter.restore(parentSeed, childIds);

        assertEq(minter.seedOf(restored), parentSeed, "restored carries parent seed");
        assertEq(minter.backingOf(restored), 0.1 ether, "restored backing");
        assertEq(minter.originCountOf(restored), 1, "origins conserved");
        (uint16 afterCount,) = minter.splitRecordOf(parentSeed);
        assertEq(afterCount, 0, "split record consumed");

        // Lineage: each restored child points forward at the new parent.
        for (uint256 i = 0; i < 2; i++) {
            Path memory cp = minter.pathOf(kids[i]);
            assertEq(uint256(cp.pathType), uint256(PathType.Continuation), "restore records Continuation");
            assertEq(cp.target, restored, "child became part of restored parent");
        }
        _assertSolvent();
    }

    /* ------------------------------ sacrifice -------------------------- */

    /// @dev Heavy: builds a genuine apex Complete (10,000 direct 0.01 mints
    ///      composed into one 100 ETH token with 10,000 origins), the only
    ///      blackenable state. Each mint issues through the collection, so this
    ///      is 10,000 cross-contract mintToId calls and needs a gas limit above
    ///      forge's 2^30 default. Opt in:
    ///        RUN_HEAVY=1 MAINNET_RPC_URL=... \
    ///          forge test --match-test test_BlackenSacrificesApexComplete \
    ///          --gas-limit 90000000000
    function test_BlackenSacrificesApexComplete() public {
        if (vm.envOr("RUN_HEAVY", uint256(0)) == 0) vm.skip(true);

        vm.prank(alice);
        uint256 first =
            minter.mintBatch{value: 10_000 * (0.01 ether + feeOf(0.01 ether))}(0.01 ether, 10_000, alice);
        uint256[] memory burn = new uint256[](9_999);
        for (uint256 i = 0; i < 9_999; i++) burn[i] = first + 1 + i;
        vm.prank(alice);
        uint256 id = minter.compose(first, burn);

        assertEq(minter.backingOf(id), 100 ether, "apex backing");
        assertEq(minter.originCountOf(id), 10_000, "apex origins");
        assertTrue(minter.isComplete(id), "apex is Complete");

        uint256 deadBefore = address(0x000000000000000000000000000000000000dEaD).balance;
        assertEq(minter.redeemableBacking(), 100 ether, "reserve is the apex backing");

        vm.prank(alice);
        minter.blacken(id);

        assertTrue(minter.isBlack(id), "now Black");
        assertEq(minter.backingOf(id), 0, "no redeemable backing");
        assertEq(minter.redeemableBacking(), 0, "reserve emptied to sacrifice");
        assertEq(minter.sacrificedBacking(), 100 ether, "sacrificed tracked");
        assertEq(minter.blackCount(), 1, "one Black");
        assertEq(
            address(0x000000000000000000000000000000000000dEaD).balance - deadBefore,
            100 ether,
            "100 ETH sacrificed to dEaD"
        );
        // Black is terminal: cannot redeem.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShapesMinter.TokenIsBlack.selector, id));
        minter.redeem(id);
        _assertSolvent();
    }

    /* ------------------------------- utils ----------------------------- */

    function _prefix(string memory s, uint256 n) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length < n) return s;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = b[i];
        return string(out);
    }
}

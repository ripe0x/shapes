// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {IShapes} from "../src/interfaces/IShapes.sol";
import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {Denominations} from "../src/lib/Denominations.sol";

contract MockArtistWallet is IERC1271 {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

contract EmptySignatureArtistWallet is IERC1271 {
    function isValidSignature(bytes32, bytes memory signature) external pure returns (bytes4) {
        return signature.length == 0 ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

contract ArtistAttributionTest is Test {
    uint256 internal constant ARTIST_KEY = 0xA47157;
    uint256 internal constant OTHER_KEY = 0xBAD;
    bytes32 internal constant RELEASE_HASH = keccak256("shapes-release");

    address internal artist;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;

    function setUp() public {
        artist = vm.addr(ARTIST_KEY);
        vm.deal(artist, 1 ether);
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));

        vm.startPrank(artist);
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, address(0xFEE), address(renderer), address(collection), 0
        );
        vm.stopPrank();
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_AttributionIsStoredDirectlyInShapes() public view {
        assertEq(shapes.artist(), artist);
        assertEq(shapes.artistReleaseHash(), bytes32(0));
        assertEq(shapes.artistSignature(), bytes(""));
    }

    function test_AnyoneCanRelayValidArtistSignatureExactlyOnce() public {
        bytes memory signature = _signature(ARTIST_KEY, shapes.artistAttestationDigest(RELEASE_HASH));

        vm.expectEmit(true, true, true, true, address(shapes));
        emit IShapes.ArtistAttested(artist, RELEASE_HASH, signature);
        vm.prank(address(0xB0B));
        shapes.attestArtist(RELEASE_HASH, signature);

        assertEq(shapes.artistReleaseHash(), RELEASE_HASH);
        assertEq(shapes.artistSignature(), signature);

        vm.expectRevert(IShapes.ArtistAlreadyAttested.selector);
        shapes.attestArtist(RELEASE_HASH, signature);
    }

    function test_RejectsZeroReleaseHash() public {
        bytes memory signature = _signature(ARTIST_KEY, shapes.artistAttestationDigest(bytes32(0)));
        vm.expectRevert(IShapes.InvalidArtistReleaseHash.selector);
        shapes.attestArtist(bytes32(0), signature);
    }

    function test_RejectsWrongSignerAndMalformedSignature() public {
        bytes memory wrong = _signature(OTHER_KEY, shapes.artistAttestationDigest(RELEASE_HASH));
        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        shapes.attestArtist(RELEASE_HASH, wrong);

        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        shapes.attestArtist(RELEASE_HASH, hex"1234");
    }

    function test_SignatureBindsReleaseHash() public {
        bytes memory signature = _signature(ARTIST_KEY, shapes.artistAttestationDigest(RELEASE_HASH));
        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        shapes.attestArtist(keccak256("different-release"), signature);
    }

    function test_SignatureBindsChain() public {
        bytes memory signature = _signature(ARTIST_KEY, shapes.artistAttestationDigest(RELEASE_HASH));
        vm.chainId(block.chainid + 1);
        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        shapes.attestArtist(RELEASE_HASH, signature);
    }

    function test_SignatureCannotBeReplayedAcrossDeployments() public {
        uint256 genesisAmount = Denominations.amountAt(0);
        vm.startPrank(artist);
        Shapes other = new Shapes{value: genesisAmount}(
            Denominations.UNIT / 10, address(0xFEE), address(renderer), address(collection), 0
        );
        vm.stopPrank();
        assertEq(other.artist(), artist);
        bytes memory signature = _signature(ARTIST_KEY, shapes.artistAttestationDigest(RELEASE_HASH));

        vm.expectRevert(IShapes.InvalidArtistSignature.selector);
        other.attestArtist(RELEASE_HASH, signature);
    }

    function test_DigestMatchesIndependentEIP712Encoding() public view {
        bytes32 typehash = keccak256("ArtistAttribution(address shapes,address artist,bytes32 releaseHash)");
        bytes32 domainTypehash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domainSeparator = keccak256(
            abi.encode(
                domainTypehash,
                keccak256("Shapes Artist Attribution"),
                keccak256("1"),
                block.chainid,
                address(shapes)
            )
        );
        bytes32 structHash = keccak256(abi.encode(typehash, address(shapes), artist, RELEASE_HASH));
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));

        assertEq(shapes.artistAttestationDigest(RELEASE_HASH), expected);
    }

    function test_DelegatedEoaCanUseItsEcdsaKey() public {
        vm.etch(artist, hex"00");
        assertGt(artist.code.length, 0);

        bytes memory signature = _signature(ARTIST_KEY, shapes.artistAttestationDigest(RELEASE_HASH));
        shapes.attestArtist(RELEASE_HASH, signature);

        assertEq(shapes.artistReleaseHash(), RELEASE_HASH);
        assertEq(shapes.artistSignature(), signature);
    }

    function test_ERC1271ArtistWalletCanAttest() public {
        uint256 signerKey = 0x1271;
        MockArtistWallet wallet = new MockArtistWallet(vm.addr(signerKey));
        Shapes walletShapes = _deployFrom(address(wallet));
        bytes memory signature = _signature(signerKey, walletShapes.artistAttestationDigest(RELEASE_HASH));

        walletShapes.attestArtist(RELEASE_HASH, signature);

        assertEq(walletShapes.artist(), address(wallet));
        assertEq(walletShapes.artistReleaseHash(), RELEASE_HASH);
        assertEq(walletShapes.artistSignature(), signature);
    }

    function test_ERC1271EmptySignatureCanAttestOnlyOnce() public {
        EmptySignatureArtistWallet wallet = new EmptySignatureArtistWallet();
        Shapes walletShapes = _deployFrom(address(wallet));

        walletShapes.attestArtist(RELEASE_HASH, bytes(""));

        assertEq(walletShapes.artistReleaseHash(), RELEASE_HASH);
        assertEq(walletShapes.artistSignature(), bytes(""));
        vm.expectRevert(IShapes.ArtistAlreadyAttested.selector);
        walletShapes.attestArtist(RELEASE_HASH, bytes(""));
    }

    function _deployFrom(address deployer) private returns (Shapes deployed) {
        vm.deal(deployer, Denominations.amountAt(0));
        vm.startPrank(deployer);
        deployed = new Shapes{value: Denominations.amountAt(0)}(
            Denominations.UNIT / 10, address(0xFEE), address(renderer), address(collection), 0
        );
        vm.stopPrank();
    }
}

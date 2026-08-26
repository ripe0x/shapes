// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {ShapeCollection} from "../src/ShapeCollection.sol";
import {ShapeRenderer} from "../src/ShapeRenderer.sol";
import {Shapes} from "../src/Shapes.sol";
import {ShapesArtistAttribution} from "../src/ShapesArtistAttribution.sol";
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

contract ShapesArtistAttributionTest is Test {
    uint256 internal constant ARTIST_KEY = 0xA47157;
    uint256 internal constant OTHER_KEY = 0xBAD;
    bytes32 internal constant RELEASE_HASH = keccak256("shapes-release");

    address internal artist;
    ShapeRenderer internal renderer;
    ShapeCollection internal collection;
    Shapes internal shapes;
    ShapesArtistAttribution internal attribution;

    function setUp() public {
        artist = vm.addr(ARTIST_KEY);
        vm.deal(artist, 1 ether);
        renderer = new ShapeRenderer();
        collection = new ShapeCollection(address(renderer));

        vm.prank(artist);
        shapes = new Shapes{value: Denominations.amountAt(0)}(
            100, address(0xFEE), address(renderer), address(collection)
        );
        attribution = ShapesArtistAttribution(shapes.artistAttribution());
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_AttributionIsPermanentlyBoundToShapesAndArtist() public view {
        assertEq(shapes.artist(), artist);
        assertEq(attribution.shapes(), address(shapes));
        assertEq(attribution.artist(), artist);
        assertFalse(attribution.attested());
        assertEq(attribution.releaseHash(), bytes32(0));
        assertEq(attribution.signature(), bytes(""));
    }

    function test_AnyoneCanRelayValidArtistSignatureExactlyOnce() public {
        bytes memory signature = _signature(ARTIST_KEY, attribution.attestationDigest(RELEASE_HASH));

        vm.prank(address(0xB0B));
        attribution.attest(RELEASE_HASH, signature);

        assertTrue(attribution.attested());
        assertEq(attribution.releaseHash(), RELEASE_HASH);
        assertEq(attribution.signature(), signature);

        vm.expectRevert(ShapesArtistAttribution.ArtistAlreadyAttested.selector);
        attribution.attest(RELEASE_HASH, signature);
    }

    function test_RejectsWrongSignerAndMalformedSignature() public {
        bytes memory wrong = _signature(OTHER_KEY, attribution.attestationDigest(RELEASE_HASH));
        vm.expectRevert(ShapesArtistAttribution.InvalidArtistSignature.selector);
        attribution.attest(RELEASE_HASH, wrong);

        vm.expectRevert(ShapesArtistAttribution.InvalidArtistSignature.selector);
        attribution.attest(RELEASE_HASH, hex"1234");
    }

    function test_SignatureBindsReleaseHash() public {
        bytes memory signature = _signature(ARTIST_KEY, attribution.attestationDigest(RELEASE_HASH));

        vm.expectRevert(ShapesArtistAttribution.InvalidArtistSignature.selector);
        attribution.attest(keccak256("different-release"), signature);
    }

    function test_SignatureBindsChain() public {
        bytes memory signature = _signature(ARTIST_KEY, attribution.attestationDigest(RELEASE_HASH));
        vm.chainId(block.chainid + 1);

        vm.expectRevert(ShapesArtistAttribution.InvalidArtistSignature.selector);
        attribution.attest(RELEASE_HASH, signature);
    }

    function test_SignatureCannotBeReplayedAcrossDeployments() public {
        vm.prank(artist);
        Shapes otherShapes = new Shapes{value: Denominations.amountAt(0)}(
            100, address(0xFEE), address(renderer), address(collection)
        );
        ShapesArtistAttribution other = ShapesArtistAttribution(otherShapes.artistAttribution());
        bytes memory signature = _signature(ARTIST_KEY, attribution.attestationDigest(RELEASE_HASH));

        vm.expectRevert(ShapesArtistAttribution.InvalidArtistSignature.selector);
        other.attest(RELEASE_HASH, signature);
    }

    function test_DigestMatchesIndependentEIP712Encoding() public view {
        bytes32 domainTypehash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domainSeparator = keccak256(
            abi.encode(
                domainTypehash,
                keccak256("Shapes Artist Attribution"),
                keccak256("1"),
                block.chainid,
                address(attribution)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(attribution.ATTRIBUTION_TYPEHASH(), address(shapes), artist, RELEASE_HASH));
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));

        assertEq(attribution.attestationDigest(RELEASE_HASH), expected);

        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = attribution.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "Shapes Artist Attribution");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(attribution));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function test_DelegatedEoaCanUseItsEcdsaKey() public {
        vm.etch(artist, hex"00");
        assertGt(artist.code.length, 0);

        bytes memory signature = _signature(ARTIST_KEY, attribution.attestationDigest(RELEASE_HASH));
        attribution.attest(RELEASE_HASH, signature);

        assertTrue(attribution.attested());
        assertEq(attribution.signature(), signature);
    }

    function test_ERC1271ArtistWalletCanAttest() public {
        uint256 signerKey = 0x1271;
        MockArtistWallet wallet = new MockArtistWallet(vm.addr(signerKey));
        vm.deal(address(wallet), Denominations.amountAt(0));
        vm.prank(address(wallet));
        Shapes walletShapes = new Shapes{value: Denominations.amountAt(0)}(
            100, address(0xFEE), address(renderer), address(collection)
        );
        ShapesArtistAttribution walletAttribution = ShapesArtistAttribution(walletShapes.artistAttribution());
        bytes memory signature = _signature(signerKey, walletAttribution.attestationDigest(RELEASE_HASH));

        walletAttribution.attest(RELEASE_HASH, signature);

        assertEq(walletShapes.artist(), address(wallet));
        assertTrue(walletAttribution.attested());
        assertEq(walletAttribution.signature(), signature);
    }

    function test_ERC1271EmptySignatureCanAttestOnlyOnce() public {
        EmptySignatureArtistWallet wallet = new EmptySignatureArtistWallet();
        vm.deal(address(wallet), Denominations.amountAt(0));
        vm.prank(address(wallet));
        Shapes walletShapes = new Shapes{value: Denominations.amountAt(0)}(
            100, address(0xFEE), address(renderer), address(collection)
        );
        ShapesArtistAttribution walletAttribution = ShapesArtistAttribution(walletShapes.artistAttribution());

        walletAttribution.attest(RELEASE_HASH, bytes(""));

        assertTrue(walletAttribution.attested());
        assertEq(walletAttribution.releaseHash(), RELEASE_HASH);
        assertEq(walletAttribution.signature(), bytes(""));
        vm.expectRevert(ShapesArtistAttribution.ArtistAlreadyAttested.selector);
        walletAttribution.attest(RELEASE_HASH, bytes(""));
    }
}

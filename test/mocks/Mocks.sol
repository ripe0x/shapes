// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {IShapePositionResolver} from "../../src/interfaces/IShapePositionResolver.sol";

/// @notice Configurable position resolver used to exercise exact and zero position results.
contract MockPositionResolver is IShapePositionResolver {
    mapping(uint256 tokenId => address position) public positions;
    bool public shouldRevert;

    error ResolverQueryFailed(uint256 tokenId);

    function setPosition(uint256 tokenId, address position) external {
        positions[tokenId] = position;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function positionOf(uint256 tokenId) external view returns (address) {
        if (shouldRevert) revert ResolverQueryFailed(tokenId);
        return positions[tokenId];
    }
}

/// @notice A resolver that burns far more gas than `positionOf` forwards, to prove the call is
///         capped and its failure swallowed rather than draining the caller.
contract HostileGasResolver is IShapePositionResolver {
    function positionOf(uint256) external pure returns (address) {
        uint256 x;
        for (uint256 i = 0; i < 1_000_000; ++i) {
            x = uint256(keccak256(abi.encode(x, i)));
        }
        return address(uint160(x));
    }
}

/// @notice Accepts ERC721 transfers and ETH. The well-behaved contract counterparty.
contract GoodReceiver is IERC721Receiver {
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function redeem(IShapes shapes, uint256 tokenId) external {
        shapes.redeem(tokenId);
    }

    function redeemBatch(IShapes shapes, uint256[] calldata ids) external {
        shapes.redeemBatch(ids);
    }

    function transfer(IShapes shapes, address to, uint256 tokenId) external {
        shapes.transferFrom(address(this), to, tokenId);
    }
}

/// @notice Rejects ERC721 transfers by returning the wrong magic value.
contract BadReceiver is IERC721Receiver {
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @notice Accepts ERC721 transfers but refuses ETH. Used to prove a failed payout reverts
///         the whole redemption rather than burning the token and losing the backing.
contract EthRejectingReceiver is IERC721Receiver {
    error NoEthThanks();

    receive() external payable {
        revert NoEthThanks();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function redeem(IShapes shapes, uint256 tokenId) external {
        shapes.redeem(tokenId);
    }
}

/// @notice A fee recipient that reverts on receipt. Minting is expected to become impossible;
///         redemption must remain unaffected.
contract RevertingFeeRecipient {
    receive() external payable {
        revert("no fees");
    }
}

/// @notice Attempts to re-enter `redeem` (or `redeemBatch`) from the ETH payout callback.
contract ReentrantRedeemer is IERC721Receiver {
    IShapes public shapes;
    uint256 public reenterTokenId;
    bool public useBatch;
    bool public attempted;
    bool public reentryReverted;

    constructor(IShapes shapes_) {
        shapes = shapes_;
    }

    function arm(uint256 tokenId, bool batch) external {
        reenterTokenId = tokenId;
        useBatch = batch;
        attempted = false;
        reentryReverted = false;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function redeem(uint256 tokenId) external {
        shapes.redeem(tokenId);
    }

    function redeemBatch(uint256[] calldata ids) external {
        shapes.redeemBatch(ids);
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        if (useBatch) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = reenterTokenId;
            try shapes.redeemBatch(ids) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        } else {
            try shapes.redeem(reenterTokenId) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
    }
}

/// @notice A fee recipient that tries to re-enter `mint` from the fee payout.
contract ReentrantFeeRecipient {
    IShapes public shapes;
    bool public attempted;
    bool public reentryReverted;
    uint256 public amountWei;

    function configure(IShapes shapes_, uint256 amountWei_) external {
        shapes = shapes_;
        amountWei = amountWei_;
        attempted = false;
        reentryReverted = false;
    }

    receive() external payable {
        if (attempted || address(shapes) == address(0)) return;
        attempted = true;
        uint256 need = amountWei + shapes.mintFeeFor(amountWei);
        if (address(this).balance < need) return;
        try shapes.mintTo{value: need}(amountWei, address(this)) {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice Attempts to re-enter `mint` from an ERC721 receiver callback.
contract ReentrantMinter is IERC721Receiver {
    IShapes public shapes;
    uint256 public amountWei;
    bool public attempted;
    bool public reentryReverted;

    constructor(IShapes shapes_, uint256 amountWei_) {
        shapes = shapes_;
        amountWei = amountWei_;
    }

    receive() external payable {}

    function mint() external payable returns (uint256) {
        return shapes.mintTo{value: msg.value}(amountWei, address(this));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!attempted) {
            attempted = true;
            uint256 need = amountWei + shapes.mintFeeFor(amountWei);
            if (address(this).balance >= need) {
                try shapes.mintTo{value: need}(amountWei, address(this)) {
                    reentryReverted = false;
                } catch {
                    reentryReverted = true;
                }
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice A plain ERC721 used as a contract collector token candidate.
contract MockCollectorERC721 is ERC721 {
    constructor() ERC721("MockCollector", "COLLECT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function burn(uint256 tokenId) external {
        _burn(tokenId);
    }
}

/// @notice An ERC721 whose `ownerOf` reverts on demand, to exercise the collector token's
///         gas-capped staticcall failure path.
contract RevertingOwnerOfERC721 is ERC721 {
    bool public shouldRevert;

    constructor() ERC721("RevertingOwner", "REVERT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function ownerOf(uint256 tokenId) public view override returns (address) {
        if (shouldRevert) revert("ownerOf reverted");
        return super.ownerOf(tokenId);
    }
}

/// @notice Claims no ERC-165 interface at all and has no `ownerOf`. Any call to it, including the
///         collector binding's gas-capped `ownerOf` staticcall, reverts with no return data.
contract NotAnERC721 {
    function transferFrom(address, address, uint256) external pure {
        revert("not an ERC721");
    }
}

/// @notice Answers `ownerOf` with a nonzero address but implements no other part of ERC-721 and
///         claims no ERC-165 interface. The collector binding validates a candidate purely by
///         whether `ownerOf(tokenId)` resolves, not by ERC-165 conformance, so this is accepted.
contract NonConformingOwnerOfContract {
    address public owner = address(0xBEEF);

    function ownerOf(uint256) external view returns (address) {
        return owner;
    }
}

/// @notice Answers `ownerOf` with a clean address until `setShouldMalform` is toggled, after which
///         it returns a uint256 with dirty upper bits instead of a clean address.
contract MalformedOwnerOfERC721 is IERC165 {
    address public owner = address(0xBEEF);
    bool public shouldMalform;

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC721).interfaceId;
    }

    function setShouldMalform(bool value) external {
        shouldMalform = value;
    }

    function ownerOf(uint256) external view returns (uint256) {
        if (shouldMalform) return type(uint256).max;
        return uint256(uint160(owner));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IShapes} from "../../src/interfaces/IShapes.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IShapeCollection} from "../../src/interfaces/IShapeCollection.sol";
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

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IShapePositionResolver).interfaceId
                || interfaceId == type(IERC165).interfaceId;
    }
}

/// @notice A resolver that burns far more gas than `positionOf` forwards, to prove the call is
///         capped and its failure swallowed rather than draining the caller.
contract HostileGasResolver is IShapePositionResolver {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IShapePositionResolver).interfaceId
                || interfaceId == type(IERC165).interfaceId;
    }

    function positionOf(uint256) external pure returns (address) {
        uint256 x;
        for (uint256 i = 0; i < 1_000_000; ++i) {
            x = uint256(keccak256(abi.encode(x, i)));
        }
        return address(uint160(x));
    }
}

/// @notice Answers ERC-165 so it can be installed, then returns a short ABI word for every other
///         call. `Shapes.positionOf` must reject it to zero.
contract ShortReturnResolver {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IShapePositionResolver).interfaceId
                || interfaceId == type(IERC165).interfaceId;
    }

    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 1)
            return(0, 31)
        }
    }
}

/// @notice Answers ERC-165 so it can be installed, then returns a 32-byte word with dirty bits
///         above the low 160-bit address.
contract DirtyAddressResolver {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IShapePositionResolver).interfaceId
                || interfaceId == type(IERC165).interfaceId;
    }

    fallback() external {
        assembly ("memory-safe") {
            mstore(0, shl(160, 1))
            return(0, 32)
        }
    }
}

/// @notice Answers ERC-165 for `IShapeCollection` with a configurable `shapes()`, isolating
///         `AdminOps.requireCollection`'s binding check from a genuine `ShapeCollection`'s
///         behavior.
contract MockCollection {
    address public shapes;

    constructor(address shapes_) {
        shapes = shapes_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IShapeCollection).interfaceId || interfaceId == type(IERC165).interfaceId;
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

/// @notice A fee recipient that reverts on receipt. Minting is never affected: the mint path
///         never calls it. Only `withdrawFees` reverts while it remains selected; admin may
///         redirect future withdrawals via `setFeeRecipient`, and redemption is unaffected.
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

/// @notice A fee recipient that tries to re-enter `mint` from its `receive` callback. That
///         callback fires only from `withdrawFees`, never from a mint, since minting no longer
///         calls the fee recipient at all.
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
        uint256 need = amountWei + shapes.mintFee();
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

/// @notice Records `owner()`/`ownerToken()` on every `onERC721Received` callback, to catch a
///         mint loop that moves `_ownerToken` mid-loop and lets an earlier callback observe
///         `ownerToken()` pointing at an id not minted yet.
contract OwnerTokenConsistencyRecorder is IERC721Receiver {
    IShapes public shapes;
    address[] public recordedOwner;
    bool[] public recordedOwnerTokenReverted;
    bool[] public recordedConsistent;

    constructor(IShapes shapes_) {
        shapes = shapes_;
    }

    function recordedCount() external view returns (uint256) {
        return recordedOwner.length;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        address ownerAddr = shapes.owner();
        recordedOwner.push(ownerAddr);

        try shapes.ownerToken() returns (uint256 tid) {
            recordedOwnerTokenReverted.push(false);
            // ownerOf reverting here means ownerToken() named an id with no live owner: itself
            // an inconsistency, not something that trivially matches an address(0) owner().
            try shapes.ownerOf(tid) returns (address holder) {
                recordedConsistent.push(holder == ownerAddr);
            } catch {
                recordedConsistent.push(false);
            }
        } catch {
            recordedOwnerTokenReverted.push(true);
            recordedConsistent.push(ownerAddr == address(0));
        }

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
            uint256 need = amountWei + shapes.mintFee();
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPooledSurface, IdMode} from "./ISurface.sol";
import {LineageStore} from "./LineageStore.sol";
import {PathType} from "./ILineage.sol";
import {Denominations} from "../lib/Denominations.sol";

/// @title ShapesMinter
/// @notice The Shapes primitive as a PND Surface extension minter. A pooled
///         Surface clone owns the ERC721 tokens; this contract owns everything
///         economic: the ETH reserve, the denomination ladder, per-token seed
///         and provenance state, redemption, composition and the Black state.
///
/// @dev Port of the standalone Shapes contract onto Surface. The Surface core
///      stores one core-assigned seed per token and holds no value; both are
///      ignored here. This minter reproduces the standalone contract's seed
///      formula, denomination table, fee, reserve accounting and reserve
///      invariant unchanged, and issues/burns tokens through the collection's
///      minter-gated `mintToId`/`burn`.
///
///      Reserve invariant: `address(this).balance >= redeemableBacking` always
///      holds; the collection holds no ETH. Two paths move reserve ETH out:
///      `_settle` (redemption) and `blacken` (100 ETH to an unspendable
///      address). `compose`/`decompose`/`restore` move no ETH.
///
///      Divergences from the standalone contract, forced by the two-contract
///      split and documented for review:
///      - The self-custody guard (`_update` rejecting transfers to the token
///        contract) cannot exist: the collection is an immutable clone this
///        minter cannot subclass. A holder transferring a token to the
///        collection address strands that token's backing (never redeemable),
///        but `redeemableBacking` keeps counting it, so the reserve invariant
///        still holds.
///      - Token ids are chosen by this minter (pooled mode) from a monotonic
///        counter and never reused, reproducing the standalone contract's
///        sequential ids. The collection also assigns its own per-token seed on
///        every `mintToId`; it is unused.
///      - The seed formula uses the collection address in place of the token
///        contract's own address. The seed is pseudorandom with no economic
///        effect, so the substitution changes only which pseudorandom stream a
///        token draws, not any guarantee.
///      - The renderer pointer and its lock live on the Surface core, managed by
///        the collection owner/admin, not here.
contract ShapesMinter is ReentrancyGuard, Ownable, LineageStore {
    /* ------------------------------ types ------------------------------ */

    struct ShapeData {
        bytes32 seed;
        uint8 denomIndex;
        uint32 originCount;
        bool isBlack;
    }

    struct SplitRecord {
        uint16 childCount;
        uint8 denomIndex;
    }

    /* ------------------------------ events ----------------------------- */
    // Names and argument types match the standalone Shapes events, so event
    // topics and an indexer's decoding are identical.

    event ShapeMinted(
        uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount
    );
    event ShapeRedeemed(
        uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount
    );
    event MintFeePaid(address indexed recipient, uint256 amountWei, uint256 quantity);
    event Composed(
        uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint32 originCount
    );
    event Decomposed(
        uint256 indexed tokenId,
        bytes32 parentSeed,
        uint256[] newIds,
        uint8[] outDenoms,
        uint32[] originCounts
    );
    event Restored(
        uint256 indexed newTokenId,
        bytes32 indexed parentSeed,
        uint256[] childIds,
        uint8 denomIndex,
        uint32 originCount
    );
    event Blackened(uint256 indexed tokenId, uint256 sacrificedWei);

    /// @notice Emitted once, when this minter is bound to its collection.
    event Bound(address indexed collection, address indexed metadataBridge);

    /* ------------------------------ errors ----------------------------- */
    // Selector-identical to the standalone Shapes errors.

    error UnsupportedDenomination(uint256 amountWei);
    error IncorrectPayment(uint256 expected, uint256 provided);
    error ZeroQuantity();
    error NotShapeOwner(uint256 tokenId, address caller);
    error EthTransferFailed(address to, uint256 amountWei);
    error MintFeeTransferFailed(address recipient, uint256 amountWei);
    error DirectDepositRejected();
    error TokenIsBlack(uint256 tokenId);
    error EmptyRecomposition();
    error CannotComposeWithSelf(uint256 tokenId);
    error DecompositionMismatch(uint256 inputBacking, uint256 outputSum);
    error NotApexComplete(uint256 tokenId);
    error NoSplitRecord(bytes32 parentSeed);
    error RestoreCountMismatch(uint256 expected, uint256 provided);
    error RestoreChildMismatch(uint256 tokenId, uint256 index);
    error RestoreBackingMismatch(uint256 expected, uint256 provided);

    // Binding errors, specific to the Surface split.
    error AlreadyBound();
    error NotBound();
    error NotThisMinter();
    error NotPooled();

    /* ------------------------------ state ------------------------------ */

    mapping(uint256 tokenId => ShapeData) private _shapes;
    mapping(bytes32 parentSeed => SplitRecord) private _splitRecords;

    uint256 public redeemableBacking;
    uint256 public sacrificedBacking;
    uint256 public blackCount;
    uint256 public totalSupply;
    uint256 public totalMinted;

    uint256 private constant APEX_INDEX = 8;
    uint256 private constant APEX_BACKING = 100 ether;
    address private constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    uint256 public immutable feeBps;
    address public immutable feeRecipient;

    /// @notice The pooled Surface collection this minter issues and burns tokens
    ///         through. Set once, by `bind`.
    IPooledSurface public collection;

    /// @notice Optional ERC-4906 bridge (the Shapes renderer), authorized on the
    ///         collection to emit metadata-refresh signals `compose` and
    ///         `blacken` need. Zero disables the signal; the operations still
    ///         run.
    address public metadataBridge;

    /// @param feeBps_ Mint fee in basis points of the backing, on top of it. 100
    ///        is 1%. Rejected above 100%. Never enters the reserve.
    /// @param feeRecipient_ Where fees are forwarded. Must accept ETH; immutable,
    ///        so a reverting recipient disables minting permanently (redemption
    ///        is unaffected).
    constructor(uint256 feeBps_, address feeRecipient_) Ownable(msg.sender) {
        require(feeBps_ <= BPS_DENOMINATOR, "fee exceeds 100%");
        require(feeRecipient_ != address(0), "fee recipient is zero");
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    /// @notice Bind this minter to its collection, once. Owner only. The
    ///         collection must already authorize this minter (set at creation via
    ///         `initialMinters`) and be a pooled Surface. After binding, the owner
    ///         holds no power over the reserve; it may renounce.
    /// @param collection_ The pooled Surface clone.
    /// @param metadataBridge_ The Shapes renderer, authorized to emit ERC-4906
    ///        refreshes. May be zero to disable that signal.
    function bind(address collection_, address metadataBridge_) external onlyOwner {
        if (address(collection) != address(0)) revert AlreadyBound();
        IPooledSurface c = IPooledSurface(collection_);
        if (!c.isMinter(address(this))) revert NotThisMinter();
        if (c.idMode() != IdMode.Pooled) revert NotPooled();
        collection = c;
        metadataBridge = metadataBridge_;
        emit Bound(collection_, metadataBridge_);
    }

    /* ------------------------------ views ------------------------------ */

    function mintFeeFor(uint256 amountWei) public view returns (uint256) {
        return (amountWei * feeBps) / BPS_DENOMINATOR;
    }

    function backingOf(uint256 tokenId) public view returns (uint256) {
        _requireExists(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return d.isBlack ? 0 : Denominations.amountAt(d.denomIndex);
    }

    function isBlack(uint256 tokenId) public view returns (bool) {
        _requireExists(tokenId);
        return _shapes[tokenId].isBlack;
    }

    function seedOf(uint256 tokenId) public view returns (bytes32) {
        _requireExists(tokenId);
        return _shapes[tokenId].seed;
    }

    function originCountOf(uint256 tokenId) public view returns (uint256) {
        _requireExists(tokenId);
        return _shapes[tokenId].originCount;
    }

    function isComplete(uint256 tokenId) public view returns (bool) {
        _requireExists(tokenId);
        ShapeData storage d = _shapes[tokenId];
        uint256 units = Denominations.unitsAt(d.denomIndex);
        return !d.isBlack && units > 1 && d.originCount == units;
    }

    /// @notice The four fields the renderer needs, in one read. Reverts for a
    ///         nonexistent token. `amountWei` is the token's denomination even
    ///         when Black; the renderer decides how to present the Black state.
    function renderData(uint256 tokenId)
        external
        view
        returns (bytes32 seed, uint256 amountWei, uint256 originCount, bool black)
    {
        _requireExists(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return (d.seed, Denominations.amountAt(d.denomIndex), d.originCount, d.isBlack);
    }

    function splitRecordOf(bytes32 parentSeed)
        external
        view
        returns (uint16 childCount, uint8 denomIndex)
    {
        SplitRecord storage record = _splitRecords[parentSeed];
        return (record.childCount, record.denomIndex);
    }

    function isSupportedDenomination(uint256 amountWei) external pure returns (bool) {
        return Denominations.isSupported(amountWei);
    }

    function gridForAmount(uint256 amountWei) external pure returns (uint256 cols, uint256 rows) {
        return Denominations.gridAt(Denominations.requireIndexOf(amountWei));
    }

    function modulesForAmount(uint256 amountWei) external pure returns (uint256) {
        (uint256 cols, uint256 rows) = Denominations.gridAt(Denominations.requireIndexOf(amountWei));
        return cols * rows;
    }

    /* ------------------------------ minting ---------------------------- */

    function mint(uint256 amountWei, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokenId)
    {
        return _mintBatch(amountWei, 1, to);
    }

    function mintBatch(uint256 amountWei, uint256 quantity, address to)
        external
        payable
        nonReentrant
        returns (uint256 firstTokenId)
    {
        return _mintBatch(amountWei, quantity, to);
    }

    function _mintBatch(uint256 amountWei, uint256 quantity, address to)
        private
        returns (uint256 firstTokenId)
    {
        if (address(collection) == address(0)) revert NotBound();
        if (quantity == 0) revert ZeroQuantity();

        uint256 denomIndex;
        {
            bool ok;
            (denomIndex, ok) = Denominations.indexOf(amountWei);
            if (!ok) revert UnsupportedDenomination(amountWei);
        }

        uint256 backing = amountWei * quantity;
        uint256 fees = mintFeeFor(amountWei) * quantity;
        if (msg.value != backing + fees) revert IncorrectPayment(backing + fees, msg.value);

        firstTokenId = totalMinted + 1;

        // One entropy root per batch; each token derives from it and its id.
        // No caller-controlled input feeds the root. Uses the collection address
        // where the standalone contract used its own address.
        bytes32 batchRoot = keccak256(
            abi.encodePacked(
                block.prevrandao,
                blockhash(block.number - 1),
                block.number,
                block.timestamp,
                block.chainid,
                address(collection),
                firstTokenId
            )
        );

        // -------- effects --------
        totalMinted = firstTokenId + quantity - 1;
        totalSupply += quantity;
        redeemableBacking += backing;

        for (uint256 i = 0; i < quantity; ++i) {
            uint256 tokenId = firstTokenId + i;
            bytes32 seed = keccak256(abi.encodePacked(batchRoot, tokenId));
            _shapes[tokenId] =
                ShapeData({seed: seed, denomIndex: uint8(denomIndex), originCount: 1, isBlack: false});
            emit ShapeMinted(tokenId, to, amountWei, seed, 1);
        }

        // -------- interactions --------
        // Fees forwarded first, so a receiver callback during the issue loop sees
        // balance already equal to redeemableBacking.
        if (fees != 0) {
            (bool sent,) = feeRecipient.call{value: fees}("");
            if (!sent) revert MintFeeTransferFailed(feeRecipient, fees);
            emit MintFeePaid(feeRecipient, fees, quantity);
        }

        // Issue after all storage writes, behind the guard. mintToId triggers the
        // collection's onERC721Received callback.
        for (uint256 i = 0; i < quantity; ++i) {
            collection.mintToId(to, firstTokenId + i);
        }
    }

    /* ---------------------------- redemption --------------------------- */

    function redeem(uint256 tokenId) external nonReentrant {
        (uint256 amountWei, uint256 originCount) = _burnForRedemption(tokenId);

        totalSupply -= 1;
        redeemableBacking -= amountWei;

        emit ShapeRedeemed(tokenId, msg.sender, amountWei, originCount);
        _settle(msg.sender, amountWei);
    }

    function redeemBatch(uint256[] calldata tokenIds)
        external
        nonReentrant
        returns (uint256 totalWei)
    {
        uint256 n = tokenIds.length;
        if (n == 0) revert ZeroQuantity();

        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = tokenIds[i];
            (uint256 amountWei, uint256 originCount) = _burnForRedemption(tokenId);
            totalWei += amountWei;
            emit ShapeRedeemed(tokenId, msg.sender, amountWei, originCount);
        }

        totalSupply -= n;
        redeemableBacking -= totalWei;

        _settle(msg.sender, totalWei);
    }

    /// @dev Ownership check, read backing and origins, clear state, burn. A
    ///      duplicate id in a batch fails on its second appearance: the token no
    ///      longer exists, so `collection.ownerOf` reverts.
    function _burnForRedemption(uint256 tokenId)
        private
        returns (uint256 amountWei, uint256 originCount)
    {
        if (collection.ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        ShapeData storage d = _shapes[tokenId];
        if (d.isBlack) revert TokenIsBlack(tokenId);

        amountWei = Denominations.amountAt(d.denomIndex);
        originCount = d.originCount;

        delete _shapes[tokenId];
        _recordPath(tokenId, PathType.Burn, 0, bytes32(0));
        collection.burn(tokenId);
    }

    function _settle(address to, uint256 amountWei) private {
        (bool sent,) = to.call{value: amountWei}("");
        if (!sent) revert EthTransferFailed(to, amountWei);
    }

    /* --------------------------- recomposition ------------------------- */

    function compose(uint256 survivorId, uint256[] calldata burnIds)
        external
        nonReentrant
        returns (uint256)
    {
        uint256 n = burnIds.length;
        if (n == 0) revert EmptyRecomposition();

        if (collection.ownerOf(survivorId) != msg.sender) revert NotShapeOwner(survivorId, msg.sender);
        ShapeData storage s = _shapes[survivorId];
        if (s.isBlack) revert TokenIsBlack(survivorId);

        uint256 total = Denominations.amountAt(s.denomIndex);
        uint256 origins = s.originCount;

        for (uint256 i = 0; i < n; ++i) {
            uint256 bid = burnIds[i];
            if (bid == survivorId) revert CannotComposeWithSelf(bid);
            if (collection.ownerOf(bid) != msg.sender) revert NotShapeOwner(bid, msg.sender);
            ShapeData storage b = _shapes[bid];
            if (b.isBlack) revert TokenIsBlack(bid);

            total += Denominations.amountAt(b.denomIndex);
            origins += b.originCount;
            delete _shapes[bid];
            _recordPath(bid, PathType.Continuation, survivorId, 0);
            collection.burn(bid);
        }

        uint256 newIndex = Denominations.requireIndexOf(total);

        totalSupply -= n;
        s.denomIndex = uint8(newIndex);
        s.originCount = uint32(origins);

        emit Composed(survivorId, burnIds, uint8(newIndex), uint32(origins));
        _notifyMetadata(survivorId);
        return survivorId;
    }

    function decompose(uint256 tokenId, uint8[] calldata outDenoms)
        external
        nonReentrant
        returns (uint256[] memory newIds)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert EmptyRecomposition();

        if (collection.ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        ShapeData storage p = _shapes[tokenId];
        if (p.isBlack) revert TokenIsBlack(tokenId);

        uint256 parentBacking = Denominations.amountAt(p.denomIndex);
        bytes32 parentSeed = p.seed;
        uint256 remaining = p.originCount;

        uint256 sum;
        for (uint256 i = 0; i < k; ++i) sum += Denominations.amountAt(outDenoms[i]);
        if (sum != parentBacking) revert DecompositionMismatch(parentBacking, sum);

        // -------- effects --------
        uint256 parentIndex = p.denomIndex;
        delete _shapes[tokenId];
        collection.burn(tokenId);

        _splitRecords[parentSeed] =
            SplitRecord({childCount: uint16(k), denomIndex: uint8(parentIndex)});

        uint256 firstId = totalMinted + 1;
        totalMinted = firstId + k - 1;
        totalSupply += k - 1;

        newIds = new uint256[](k);
        uint32[] memory oc = new uint32[](k);
        for (uint256 i = 0; i < k; ++i) {
            uint256 nid = firstId + i;
            uint256 cap = Denominations.unitsAt(outDenoms[i]);
            uint256 give = remaining < cap ? remaining : cap;
            remaining -= give;
            newIds[i] = nid;
            oc[i] = uint32(give);
            _shapes[nid] = ShapeData({
                seed: keccak256(abi.encodePacked(parentSeed, i)),
                denomIndex: outDenoms[i],
                originCount: uint32(give),
                isBlack: false
            });
        }
        assert(remaining == 0);

        emit Decomposed(tokenId, parentSeed, newIds, outDenoms, oc);
        _recordSplit(tokenId, newIds);

        // -------- interactions --------
        for (uint256 i = 0; i < k; ++i) {
            collection.mintToId(msg.sender, newIds[i]);
        }
    }

    function restore(bytes32 parentSeed, uint256[] calldata childIds)
        external
        nonReentrant
        returns (uint256 newTokenId)
    {
        SplitRecord memory record = _splitRecords[parentSeed];
        if (record.childCount == 0) revert NoSplitRecord(parentSeed);
        uint256 k = childIds.length;
        if (k != record.childCount) revert RestoreCountMismatch(record.childCount, k);

        uint256 expected = Denominations.amountAt(record.denomIndex);

        // The successor id is totalMinted + 1; totalMinted is not mutated until
        // after the burn loop, so it is stable to record on each child here.
        newTokenId = totalMinted + 1;

        uint256 sum;
        uint256 origins;
        for (uint256 i = 0; i < k; ++i) {
            uint256 cid = childIds[i];
            if (collection.ownerOf(cid) != msg.sender) revert NotShapeOwner(cid, msg.sender);
            ShapeData storage c = _shapes[cid];
            if (c.isBlack) revert TokenIsBlack(cid);
            if (c.seed != keccak256(abi.encodePacked(parentSeed, i))) {
                revert RestoreChildMismatch(cid, i);
            }

            sum += Denominations.amountAt(c.denomIndex);
            origins += c.originCount;
            delete _shapes[cid];
            _recordPath(cid, PathType.Continuation, newTokenId, 0);
            collection.burn(cid);
        }
        if (sum != expected) revert RestoreBackingMismatch(expected, sum);

        // -------- effects --------
        delete _splitRecords[parentSeed];

        totalMinted = newTokenId;
        totalSupply -= k - 1;

        _shapes[newTokenId] = ShapeData({
            seed: parentSeed,
            denomIndex: record.denomIndex,
            originCount: uint32(origins),
            isBlack: false
        });

        emit Restored(newTokenId, parentSeed, childIds, record.denomIndex, uint32(origins));

        // -------- interactions --------
        collection.mintToId(msg.sender, newTokenId);
    }

    /* ------------------------------ sacrifice -------------------------- */

    function blacken(uint256 tokenId) external nonReentrant {
        if (collection.ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        ShapeData storage d = _shapes[tokenId];
        if (d.isBlack) revert TokenIsBlack(tokenId);
        if (d.denomIndex != APEX_INDEX || d.originCount != Denominations.unitsAt(APEX_INDEX)) {
            revert NotApexComplete(tokenId);
        }

        // -------- effects --------
        d.isBlack = true;
        redeemableBacking -= APEX_BACKING;
        sacrificedBacking += APEX_BACKING;
        blackCount += 1;

        emit Blackened(tokenId, APEX_BACKING);
        _notifyMetadata(tokenId);

        // -------- interactions --------
        (bool sent,) = BURN.call{value: APEX_BACKING}("");
        if (!sent) revert EthTransferFailed(BURN, APEX_BACKING);
    }

    /* ------------------------------ internal --------------------------- */

    /// @dev Reverts for a token this minter has no live record of. Mirrors the
    ///      standalone contract's `_requireOwned` gate on the view functions
    ///      without a second external call.
    function _requireExists(uint256 tokenId) private view {
        if (_shapes[tokenId].seed == bytes32(0)) revert NotShapeOwner(tokenId, address(0));
    }

    /// @dev ERC-4906 refresh for a metadata change the collection cannot observe
    ///      (a compose or blacken mutating a live token). Routed through the
    ///      renderer bridge, which the collection authorizes. Never reverts the
    ///      caller: a refresh failure must not block the value operation.
    function _notifyMetadata(uint256 tokenId) private {
        address bridge = metadataBridge;
        if (bridge == address(0)) return;
        try IMetadataBridge(bridge).emitMetadataUpdate(tokenId) {} catch {}
    }

    /* ------------------------- no stray deposits ----------------------- */

    receive() external payable {
        revert DirectDepositRejected();
    }

    fallback() external payable {
        revert DirectDepositRejected();
    }
}

/// @notice The renderer's ERC-4906 bridge entrypoint, called by the minter.
interface IMetadataBridge {
    function emitMetadataUpdate(uint256 tokenId) external;
}

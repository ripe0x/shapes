// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IShapes} from "shapes/interfaces/IShapes.sol";
import {IERC721Value} from "shapes/interfaces/IERC721Value.sol";
import {ShapeState} from "shapes/ShapeTypes.sol";

import {IShapePacks, PackState} from "./interfaces/IShapePacks.sol";
import {IShapePackRenderer, PackRenderInput} from "./interfaces/IShapePackRenderer.sol";

/// @title ShapePacks
/// @notice Bundles of Shapes as one ERC-721. See `IShapePacks` for the surface and
///         SHAPE_PACKS_DESIGN.md for the specification.
///
/// @dev Custody rules, which follow `ShapeCardEscrow`:
///      - Shapes enter in two ways only. They are pulled with `transferFrom(msg.sender, this, id)`,
///        so an approval granted to this contract can only be exercised by the approver's own
///        call; or they are minted into this contract by `Shapes.mintBatchTo`, through the
///        `_minting` receiver window, which `onERC721Received` opens for a mint and nothing else.
///      - Shapes leave in two ways only, both owner-directed: a plain `transferFrom` out, or one
///        `redeemBatchTo` that makes Shapes pay the ETH directly. This contract never holds ETH
///        and never calls any other Shapes mutator, never approves anyone.
///      - A live pack's contents only grow. Only the owner (not an approved operator) may add,
///        open, redeem or unseal. Exit burns the pack token first, then drains `_contents`
///        from the end, and clears `_packOf` and the claimant entry as it goes. All state is
///        final before the first external transfer.
///      - A Shape pushed in by a plain `transferFrom` cannot be refused and is stranded. That is
///        accepted: a recovery function would be an administrative path into everyone else's
///        packs.
///      - The admin reaches presentation only (renderer, copy, lock). It has no path into custody.
contract ShapePacks is ERC721, IShapePacks, IERC2981, IERC721Receiver, ReentrancyGuard {
    /// @notice `shapes_` has no code or does not answer ERC-165 for `IShapes`.
    error UnsupportedShapes(address shapes);

    uint256 private constant MAX_NAME_BYTES = 64;
    uint256 private constant MAX_DESCRIPTION_BYTES = 2048;
    uint256 private constant TOP_CARDS = 3;

    /// @inheritdoc IShapePacks
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable shapes;

    /// @inheritdoc IShapePacks
    uint256 public immutable MIN_PACK_VALUE;

    /// @dev Live pack: its Shapes in insertion order. Unsealed pack: what remains to claim.
    mapping(uint256 packId => uint256[]) private _contents;
    /// @dev Shape id to the pack naming it. Zero when not packed. Ids start at 1, never reissued.
    mapping(uint256 shapeId => uint256) private _packOf;
    /// @dev Cached sum of backing for a live pack. Cleared on unseal.
    mapping(uint256 packId => uint256) private _valueWei;
    mapping(uint256 packId => uint256) private _mintedCount;
    mapping(uint256 packId => address) private _creator;
    /// @dev Set on unseal, cleared when the last Shape is claimed.
    mapping(uint256 packId => address) private _claimant;

    uint256 private _lastPackId;
    uint256 private _liveCount;

    /// @dev Set only across each `mintBatchTo` call, and read only by `onERC721Received`.
    bool private _minting;

    address private _admin;
    address private _renderer;
    bool private _presentationLocked;
    string private _tokenNamePrefix;
    string private _description;

    /// @param shapes_ The Shapes token to wrap. Must answer ERC-165 for `IShapes`.
    /// @param renderer_ The initial renderer. Must answer ERC-165 for `IShapePackRenderer`.
    /// @param admin_ The presentation admin. Nonzero.
    constructor(address shapes_, address renderer_, address admin_) ERC721("Shape Packs", "PACK") {
        // `ERC165Checker` treats a revert, a silent fallback and malformed return data alike, so
        // every way of not being Shapes fails with the same error.
        if (!ERC165Checker.supportsInterface(shapes_, type(IShapes).interfaceId)) {
            revert UnsupportedShapes(shapes_);
        }
        _requireRenderer(renderer_);
        if (admin_ == address(0)) revert AdminInvalidAdmin(address(0));

        shapes = shapes_;
        MIN_PACK_VALUE = 3 * IShapes(shapes_).unit();
        _renderer = renderer_;
        _admin = admin_;
        _tokenNamePrefix = "Shape Pack ";
        _description = "A Shape Pack bundles Shapes into one token. Its value is exactly the sum of the Shapes "
            "inside, which only ever grows while the pack is live. Open it to take the Shapes out, or redeem "
            "it for their ETH.";
        emit AdminTransferred(address(0), admin_);
    }

    /* --------------------------- create and extend --------------------------- */

    /// @inheritdoc IShapePacks
    function createPack(uint256[] calldata shapeIds, uint32[] calldata mintCounts)
        external
        payable
        nonReentrant
        returns (uint256)
    {
        return _create(shapeIds, mintCounts, msg.sender);
    }

    /// @inheritdoc IShapePacks
    /// @dev The pack token is minted last, after every Shape is in custody and the pack is
    ///      recorded, so a receiver hook that calls back finds a finished pack and a held lock.
    function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
        external
        payable
        nonReentrant
        returns (uint256)
    {
        return _create(shapeIds, mintCounts, to);
    }

    /// @inheritdoc IShapePacks
    /// @dev Owner-only, not approved-operator: an addition raises the pack's exit cost, and every
    ///      value-affecting action on a pack belongs to its owner.
    function addToPack(uint256 packId, uint256[] calldata shapeIds, uint32[] calldata mintCounts)
        external
        payable
        nonReentrant
    {
        _requireOwner(packId);
        (uint256[] memory ids, uint256 added) = _intake(packId, shapeIds, mintCounts);
        emit PackExtended(packId, msg.sender, ids, shapeIds.length, added, _valueWei[packId]);
        emit MetadataUpdate(packId);
    }

    /// @inheritdoc IShapePacks
    function quoteMint(uint32[] calldata mintCounts)
        external
        view
        returns (uint256 backingWei, uint256 feeWei, uint256 totalWei, uint256 shapeCount)
    {
        IShapes s = IShapes(shapes);
        if (mintCounts.length != s.denominationCount()) revert MakeupLengthMismatch();
        for (uint8 d = 0; d < mintCounts.length; ++d) {
            backingWei += uint256(mintCounts[d]) * s.denominationAt(d);
            shapeCount += mintCounts[d];
        }
        feeWei = shapeCount * s.mintFee();
        totalWei = backingWei + feeWei;
    }

    /// @inheritdoc IShapePacks
    /// @dev Reverts with a SafeCast overflow if a count does not fit `uint32`, rather than
    ///      returning a makeup `createPack` cannot take.
    function defaultMakeup(uint256 backingWei) external view returns (uint32[] memory mintCounts) {
        IShapes s = IShapes(shapes);
        if (backingWei % s.unit() != 0) revert NotAUnitMultiple(backingWei);

        uint8 n = s.denominationCount();
        mintCounts = new uint32[](n);
        uint256 remaining = backingWei;
        for (uint8 i = n; i > 0; --i) {
            uint256 amount = s.denominationAt(i - 1);
            mintCounts[i - 1] = SafeCast.toUint32(remaining / amount);
            remaining %= amount;
        }
    }

    /* -------------------------------- exit -------------------------------- */

    /// @inheritdoc IShapePacks
    function open(uint256 packId) external nonReentrant {
        _unseal(packId, msg.sender);
        _claim(packId, type(uint256).max, msg.sender);
    }

    /// @inheritdoc IShapePacks
    /// @dev Plain `transferFrom` is used, as in the escrow: `to` is chosen by the owner, and a
    ///      hook-less push cannot be griefed by a recipient.
    function openTo(uint256 packId, address to) external nonReentrant {
        _unseal(packId, to);
        _claim(packId, type(uint256).max, to);
    }

    /// @inheritdoc IShapePacks
    function redeem(uint256 packId) external nonReentrant {
        _redeem(packId, payable(msg.sender));
    }

    /// @inheritdoc IShapePacks
    function redeemTo(uint256 packId, address payable recipient) external nonReentrant {
        _redeem(packId, recipient);
    }

    /// @inheritdoc IERC721Value
    /// @dev A pack never holds zero value, so `burn` always pays and is identical to `redeem`.
    function burn(uint256 packId) external nonReentrant {
        _redeem(packId, payable(msg.sender));
    }

    /// @inheritdoc IShapePacks
    /// @dev The Shapes stay in custody under `claimant`'s claim. `packOf` keeps naming this pack
    ///      until each Shape is claimed.
    function unseal(uint256 packId, address claimant) external nonReentrant {
        _unseal(packId, claimant);
    }

    /// @inheritdoc IShapePacks
    function claim(uint256 packId, uint256 maxCount) external nonReentrant {
        if (maxCount == 0) revert ZeroQuantity();
        _claim(packId, maxCount, _requireClaimant(packId));
    }

    /// @inheritdoc IShapePacks
    function claimEth(uint256 packId, uint256 maxCount, address payable recipient) external nonReentrant {
        if (maxCount == 0) revert ZeroQuantity();
        _requireClaimant(packId);
        _claimEth(packId, maxCount, recipient);
    }

    /* -------------------------------- read -------------------------------- */

    /// @inheritdoc IShapePacks
    function contentsOf(uint256 packId) external view returns (uint256[] memory) {
        return _contents[packId];
    }

    /// @inheritdoc IERC721Value
    /// @dev The cached sum of backing. Reverts unless the pack is live.
    function valueOf(uint256 packId) external view returns (uint256) {
        _requireOwned(packId);
        return _valueWei[packId];
    }

    /// @inheritdoc IShapePacks
    function packOf(uint256 shapeId) external view returns (uint256) {
        return _packOf[shapeId];
    }

    /// @inheritdoc IShapePacks
    function claimantOf(uint256 packId) external view returns (address) {
        return _claimant[packId];
    }

    /// @inheritdoc IShapePacks
    function creatorOf(uint256 packId) external view returns (address) {
        return _creator[packId];
    }

    /// @inheritdoc IShapePacks
    function makeupOf(uint256 packId) external view returns (uint32[] memory) {
        _requireOwned(packId);
        return _makeup(_contents[packId]);
    }

    /// @inheritdoc IShapePacks
    function packState(uint256 packId) external view returns (PackState memory) {
        _requireOwned(packId);
        uint256[] memory ids = _contents[packId];
        return PackState({
            shapeIds: ids,
            counts: _makeup(ids),
            valueWei: _valueWei[packId],
            mintedCount: _mintedCount[packId],
            creator: _creator[packId]
        });
    }

    /// @inheritdoc IShapePacks
    function exists(uint256 packId) external view returns (bool) {
        return _ownerOf(packId) != address(0);
    }

    /// @inheritdoc IShapePacks
    function totalMinted() external view returns (uint256) {
        return _lastPackId;
    }

    /// @inheritdoc IShapePacks
    function totalSupply() external view returns (uint256) {
        return _liveCount;
    }

    /// @notice EIP-2981 royalty, permanently zero.
    /// @dev Declared so a marketplace reading ERC-2981 gets an explicit zero rate, as Shapes does.
    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        return (address(0), 0);
    }

    /* ------------------------------- receipt ------------------------------- */

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts a Shape only when it is minted here (`from == address(0)`) by Shapes while a
    ///      creation or addition is minting. A `safeTransferFrom` into this contract carries a
    ///      nonzero `from` and is refused, even inside the window, so a Shape cannot be stranded
    ///      here with no pack naming it.
    function onERC721Received(address, address from, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != shapes || !_minting || from != address(0)) revert UnsolicitedToken(from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Direct ETH transfers are rejected. ETH enters only through the payable entrypoints and
    ///      is forwarded in full to Shapes. `selfdestruct` and block rewards can force ETH in; it
    ///      is stranded, never reachable.
    receive() external payable {
        revert DirectDepositRejected();
    }

    fallback() external payable {
        revert DirectDepositRejected();
    }

    /* ---------------------------- presentation ---------------------------- */

    /// @inheritdoc IShapePacks
    function admin() external view returns (address) {
        return _admin;
    }

    modifier onlyAdmin() {
        _requireAdmin();
        _;
    }

    modifier whenUnlocked() {
        _requireUnlocked();
        _;
    }

    /// @inheritdoc IShapePacks
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert AdminInvalidAdmin(address(0));
        address previousAdmin = _admin;
        _admin = newAdmin;
        emit AdminTransferred(previousAdmin, newAdmin);
    }

    /// @inheritdoc IShapePacks
    function renounceAdmin() external onlyAdmin {
        address previousAdmin = _admin;
        _admin = address(0);
        emit AdminTransferred(previousAdmin, address(0));
    }

    /// @inheritdoc IShapePacks
    function renderer() external view returns (address) {
        return _renderer;
    }

    /// @inheritdoc IShapePacks
    function presentationLocked() external view returns (bool) {
        return _presentationLocked;
    }

    /// @inheritdoc IShapePacks
    function tokenNamePrefix() external view returns (string memory) {
        return _tokenNamePrefix;
    }

    /// @inheritdoc IShapePacks
    function description() external view returns (string memory) {
        return _description;
    }

    /// @inheritdoc IShapePacks
    /// @dev The new renderer must have code and answer ERC-165 for `IShapePackRenderer`, so a
    ///      mistyped address cannot brick `tokenURI`. Signals marketplaces to re-read.
    function setRenderer(address newRenderer) external onlyAdmin whenUnlocked {
        _requireRenderer(newRenderer);
        _renderer = newRenderer;
        emit RendererUpdated(newRenderer);
        _signalMetadataChanged();
    }

    /// @inheritdoc IShapePacks
    /// @dev Stored here and passed to the renderer, so a bad string is refused at write time
    ///      rather than breaking the JSON at read time. Signals marketplaces to re-read.
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_)
        external
        onlyAdmin
        whenUnlocked
    {
        _requireJsonSafe(tokenNamePrefix_, MAX_NAME_BYTES, 0);
        _requireJsonSafe(description_, MAX_DESCRIPTION_BYTES, 1);
        _tokenNamePrefix = tokenNamePrefix_;
        _description = description_;
        emit MetadataCopySet(tokenNamePrefix_, description_);
        _signalMetadataChanged();
    }

    /// @inheritdoc IShapePacks
    /// @dev One-way. Reverts if already locked, so the event is emitted exactly once.
    function lockPresentation() external onlyAdmin whenUnlocked {
        _presentationLocked = true;
        emit PresentationLocked(_renderer);
    }

    /* ------------------------------ metadata ------------------------------ */

    /// @notice Fully onchain metadata for a live pack, built by the renderer from one struct.
    /// @dev Reverts for a pack that is not live. Only the first three Shapes in contents order
    ///      are passed as cards, so the cost does not grow with the pack.
    function tokenURI(uint256 packId) public view override returns (string memory) {
        _requireOwned(packId);
        IShapes s = IShapes(shapes);
        uint256[] memory ids = _contents[packId];

        uint8 n = s.denominationCount();
        uint256[] memory denominations = new uint256[](n);
        for (uint8 d = 0; d < n; ++d) {
            denominations[d] = s.denominationAt(d);
        }

        uint256 top = ids.length < TOP_CARDS ? ids.length : TOP_CARDS;
        ShapeState[] memory topCards = new ShapeState[](top);
        for (uint256 i = 0; i < top; ++i) {
            topCards[i] = s.shapeState(ids[i]);
        }

        PackRenderInput memory input = PackRenderInput({
            packId: packId,
            shapeCount: ids.length,
            valueWei: _valueWei[packId],
            unitWei: s.unit(),
            counts: _makeup(ids),
            denominations: denominations,
            mintedCount: _mintedCount[packId],
            creator: _creator[packId],
            topCards: topCards,
            tokenNamePrefix: _tokenNamePrefix,
            description: _description
        });
        return IShapePackRenderer(_renderer).tokenURI(input);
    }

    /// @inheritdoc IShapePacks
    /// @dev The seed changes with the block, so the collection image is illustrative, not fixed.
    function contractURI() external view returns (string memory) {
        return IShapePackRenderer(_renderer)
            .contractURI(name(), _description, keccak256(abi.encodePacked(block.prevrandao, block.number)));
    }

    /* -------------------------------- ERC-165 ------------------------------- */

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IShapePacks).interfaceId || interfaceId == type(IERC721Value).interfaceId
            || interfaceId == type(IERC2981).interfaceId || interfaceId == bytes4(0x49064906) // ERC-4906 metadata update
            || super.supportsInterface(interfaceId);
    }

    /* ------------------------------ internals ------------------------------ */

    /// @dev A pack token held by this contract could never be opened, redeemed or unsealed, since
    ///      those require `msg.sender` to be the owner. Covers `transferFrom` and the mint path;
    ///      `safeTransferFrom` also fails the receiver check, because this contract's receiver
    ///      only accepts Shapes.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (to == address(this)) revert SelfCustodyRejected(tokenId);
        return super._update(to, tokenId, auth);
    }

    function _requireAdmin() internal view {
        if (msg.sender != _admin) revert AdminUnauthorizedAccount(msg.sender);
    }

    function _requireUnlocked() internal view {
        if (_presentationLocked) revert PresentationIsLocked();
    }

    function _requireOwner(uint256 packId) internal view {
        if (_ownerOf(packId) != msg.sender) revert NotPackOwner(packId, msg.sender);
    }

    /// @dev The caller must be the recorded claimant of an unsealed pack with Shapes remaining.
    function _requireClaimant(uint256 packId) internal view returns (address c) {
        c = _claimant[packId];
        if (c == address(0)) revert NothingToClaim(packId);
        if (c != msg.sender) revert NotClaimant(packId, msg.sender);
    }

    function _requireRenderer(address r) internal view {
        if (!ERC165Checker.supportsInterface(r, type(IShapePackRenderer).interfaceId)) {
            revert UnsupportedRenderer(r);
        }
    }

    /// @dev Printable ASCII only, no `"` and no `\`, so the string cannot break the JSON.
    function _requireJsonSafe(string calldata s, uint256 maxBytes, uint8 field) internal pure {
        bytes calldata b = bytes(s);
        if (b.length > maxBytes) revert InvalidCopy(field);
        for (uint256 i = 0; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x20 || c > 0x7E || c == 0x22 || c == 0x5C) revert InvalidCopy(field);
        }
    }

    function _signalMetadataChanged() internal {
        if (_lastPackId > 0) emit BatchMetadataUpdate(1, _lastPackId);
        emit ContractURIUpdated();
    }

    function _makeup(uint256[] memory ids) internal view returns (uint32[] memory counts) {
        IShapes s = IShapes(shapes);
        counts = new uint32[](s.denominationCount());
        for (uint256 i = 0; i < ids.length; ++i) {
            ++counts[s.denomIndexOf(ids[i])];
        }
    }

    function _create(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
        internal
        returns (uint256 packId)
    {
        if (to == address(0)) revert InvalidRecipient(address(0));
        packId = ++_lastPackId;
        _creator[packId] = msg.sender;

        (uint256[] memory ids, uint256 value) = _intake(packId, shapeIds, mintCounts);
        if (value < MIN_PACK_VALUE) revert PackBelowMinimum(value, MIN_PACK_VALUE);

        ++_liveCount;
        emit PackCreated(packId, msg.sender, to, ids, shapeIds.length, value);
        _safeMint(to, packId);
    }

    /// @dev Shared by creation and addition. Checks in the order of the design (length, at least
    ///      one Shape, exact payment), pulls the caller's Shapes, then mints the rest into this
    ///      contract. The mint fee is read once, so the payment check and every mint use the same
    ///      value. A pulled Shape's backing is read live; a minted Shape's backing is the amount
    ///      it was minted at.
    function _intake(uint256 packId, uint256[] calldata shapeIds, uint32[] calldata mintCounts)
        internal
        returns (uint256[] memory ids, uint256 addedValue)
    {
        IShapes s = IShapes(shapes);
        uint8 denomCount = s.denominationCount();
        if (mintCounts.length != denomCount) revert MakeupLengthMismatch();

        uint256 mintTotal;
        for (uint8 d = 0; d < denomCount; ++d) {
            mintTotal += mintCounts[d];
        }
        if (shapeIds.length + mintTotal == 0) revert NoShapes();

        uint256 fee = s.mintFee();
        uint256[] memory amounts = new uint256[](denomCount);
        uint256 expected;
        for (uint8 d = 0; d < denomCount; ++d) {
            amounts[d] = s.denominationAt(d);
            expected += uint256(mintCounts[d]) * (amounts[d] + fee);
        }
        if (msg.value != expected) revert IncorrectPayment(expected, msg.value);

        ids = new uint256[](shapeIds.length + mintTotal);
        addedValue = _pull(packId, shapeIds, ids);
        addedValue += _mint(packId, mintCounts, amounts, fee, ids, shapeIds.length);

        _mintedCount[packId] += mintTotal;
        _valueWei[packId] += addedValue;
    }

    /// @dev Pulls the caller's Shapes into the pack and records them in `ids` from index 0.
    ///      `backingOf` reverts for a dead id and returns zero for a Black Shape, which is how one
    ///      is refused: it keeps the apex denomination but has no backing. A repeated id needs no
    ///      check of its own, because the second pull finds the caller no longer owns it.
    function _pull(uint256 packId, uint256[] calldata shapeIds, uint256[] memory ids)
        private
        returns (uint256 value)
    {
        IShapes s = IShapes(shapes);
        uint256[] storage contents = _contents[packId];
        for (uint256 i = 0; i < shapeIds.length; ++i) {
            uint256 id = shapeIds[i];
            uint256 backing = s.backingOf(id);
            if (backing == 0) revert WorthlessShape(id);
            value += backing;
            contents.push(id);
            _packOf[id] = packId;
            ids[i] = id;
            IERC721(shapes).transferFrom(msg.sender, address(this), id);
        }
    }

    /// @dev Mints each nonzero `mintCounts[d]` into this contract with one `mintBatchTo`, and
    ///      records the ids from index `n` of `ids`. Takes the ids the mint reports rather than
    ///      predicting them from a counter: a batch is contiguous from its return value.
    function _mint(
        uint256 packId,
        uint32[] calldata mintCounts,
        uint256[] memory amounts,
        uint256 fee,
        uint256[] memory ids,
        uint256 n
    ) private returns (uint256 value) {
        IShapes s = IShapes(shapes);
        uint256[] storage contents = _contents[packId];
        for (uint8 d = 0; d < mintCounts.length; ++d) {
            uint256 count = mintCounts[d];
            if (count == 0) continue;

            // The window is open only across the mint call that fills it, so nothing between two
            // calls can slip a token in under the flag.
            _minting = true;
            uint256 firstId =
                s.mintBatchTo{value: count * (amounts[d] + fee)}(amounts[d], count, address(this));
            _minting = false;

            for (uint256 i = 0; i < count; ++i) {
                contents.push(firstId + i);
                _packOf[firstId + i] = packId;
                ids[n++] = firstId + i;
            }
            value += count * amounts[d];
        }
    }

    /// @dev Burns the pack token and turns its contents into `claimant`'s claim. `_contents` and
    ///      `_packOf` stay until claimed so the Shapes remain accounted for; `_creator` and
    ///      `_mintedCount` persist for provenance.
    function _unseal(uint256 packId, address claimant) internal {
        _requireOwner(packId);
        // This contract as claimant would receive its own Shapes back with no pack naming them.
        if (claimant == address(0) || claimant == address(this)) revert InvalidRecipient(claimant);
        _burn(packId);
        delete _valueWei[packId];
        --_liveCount;
        _claimant[packId] = claimant;
        emit PackUnsealed(packId, msg.sender, claimant, _contents[packId].length);
    }

    /// @dev Removes up to `maxCount` Shapes from the end of the list and clears their `packId`
    ///      entries. Clears the claimant when the list empties.
    function _pop(uint256 packId, uint256 maxCount) internal returns (uint256[] memory ids) {
        uint256[] storage contents = _contents[packId];
        uint256 len = contents.length;
        if (len == 0) revert NothingToClaim(packId);

        uint256 n = maxCount < len ? maxCount : len;
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = contents[contents.length - 1];
            contents.pop();
            delete _packOf[id];
            ids[i] = id;
        }
        if (n == len) delete _claimant[packId];
    }

    function _claim(uint256 packId, uint256 maxCount, address to) internal {
        uint256[] memory ids = _pop(packId, maxCount);
        for (uint256 i = 0; i < ids.length; ++i) {
            IERC721(shapes).transferFrom(address(this), to, ids[i]);
        }
        emit ShapesClaimed(packId, to, ids);
    }

    function _claimEth(uint256 packId, uint256 maxCount, address payable recipient) internal {
        if (recipient == address(0)) revert InvalidRecipient(address(0));
        uint256[] memory ids = _pop(packId, maxCount);
        // Shapes burns every id and pays `recipient` the exact total in one transfer; the amount
        // it reports is the amount paid.
        uint256 value = IShapes(shapes).redeemBatchTo(ids, recipient);
        emit EthClaimed(packId, recipient, ids, value);
    }

    function _redeem(uint256 packId, address payable recipient) internal {
        _unseal(packId, msg.sender);
        _claimEth(packId, type(uint256).max, recipient);
    }
}

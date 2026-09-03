// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAdminControl} from "./interfaces/IAdminControl.sol";
import {IShapeCollection} from "./interfaces/IShapeCollection.sol";
import {IShapes} from "./interfaces/IShapes.sol";
import {IERC721Value} from "./interfaces/IERC721Value.sol";
import {IShapeRenderer, SplitProvenance} from "./interfaces/IShapeRenderer.sol";
import {
    IShapeProvenance,
    IShapeRecomposition,
    IShapeValue,
    ShapeFormation
} from "./interfaces/IShapeCapabilities.sol";
import {AdminOps} from "./lib/AdminOps.sol";
import {Denominations} from "./lib/Denominations.sol";
import {InkGenes} from "./lib/InkGenes.sol";
import {GeometrySampling} from "./lib/GeometrySampling.sol";
import {ComposeCompute} from "./lib/ComposeCompute.sol";
import {EIP712Signature} from "./lib/EIP712Signature.sol";
import {PointerOps} from "./lib/PointerOps.sol";
import {ShapeMath} from "./lib/ShapeMath.sol";

/// @title Shapes
/// @notice ETH-backed ERC-721 tokens with exact redemption value.
///
/// @dev Each live non-Black Shape is backed by one supported ETH denomination. Compose, decompose
///      and split change token structure without changing total redeemable backing.
///
///      Three operations move ETH out. Redemption sends a burned token's redeemable backing to the
///      caller or a chosen recipient. Sacrifice sends an apex Shape's backing to a fixed
///      unspendable address. Fee withdrawal sends only `pendingFees`, which is never part of the
///      reserve. Compose, decompose and split move no ETH.
///
///      One live Shape is the owner token. `owner()` tracks its holder and returns zero once it is
///      redeemed or burned. `owner()` gives no admin rights. Administrative rights are held
///      separately by `admin()`, which configures presentation and fees and can never reach
///      backing, redemption or token ownership.
///
///      `artist()` permanently attributes the deployment to its deployer and grants no authority.
///
///      Reentrancy: every state-changing entrypoint declared here is guarded. The inherited ERC-721
///      transfer and approval functions are not, so during a `safeTransferFrom` the receiver can
///      redeem the Shape from inside its own `onERC721Received`. Accounting stays exact. An
///      integrator must not assume the token still exists after that callback returns.
///
///      Reserve invariant: `address(this).balance >= redeemableBacking() + pendingFees()`.
///      Equality holds in normal use. ETH forced into the contract outside its payable entrypoints
///      is not withdrawable.
contract Shapes is ERC721, ReentrancyGuard, IShapes, IERC2981, IERC4906 {
    /* ------------------------------ state ------------------------------ */

    /// @dev Per-token state. Storing the denomination index rather than a wei amount makes an
    ///      off-ladder backing value unrepresentable. `originCount` is the number of direct mints
    ///      credited to this token, conserved across compose, decompose and split. `isBlack` marks
    ///      a sacrificed token. `inkGene` is assigned at mint and afterwards changes only through
    ///      `compose`; `decompose` restores the pre-compose value and `split` copies it to every
    ///      child. See INK_GENES_IMPL_SPEC.md.
    struct ShapeData {
        bytes32 seed;
        uint8 denomIndex;
        uint32 originCount;
        bool isBlack;
        uint8 inkGene;
    }

    mapping(uint256 tokenId => ShapeData) private _shapes;

    /// @dev Sampled module geometry, keyed by token id. Empty when the token's geometry derives
    ///      from `seed` under grammar v1: an original mint, never composed or split. Nonempty for a
    ///      compose survivor or a split child, holding one `ModuleCodec` byte per grid cell at the
    ///      token's current denomination. Restored verbatim by `decompose`. See SAMPLING_SPEC.md.
    mapping(uint256 tokenId => bytes) private _sampledModules;

    /// @dev One burned compose input, holding everything `decompose` needs to re-mint it
    ///      verbatim. `modules` is the input's sampled geometry, empty if it had none. `id` is the
    ///      token id narrowed to `uint96`; ids are issued one at a time, so reaching 2**96 is not
    ///      economically feasible.
    struct ComposeInput {
        bytes32 seed;
        uint96 id;
        uint32 originCount;
        uint8 denomIndex;
        uint8 inkGene;
        bytes modules;
    }

    /// @dev State needed to undo one compose. `decompose` restores the survivor's prior state
    ///      from `survivor*` and re-mints each burned input under its original id. The record holds
    ///      everything decompose needs: no caller-supplied state and no event history.
    ///      `ownerTokenFrom` is the owner token's id plus one when this compose moved ownership
    ///      from one of `inputs` to the survivor, else zero. `decompose` reads it to return
    ///      ownership to that input.
    struct ComposeRecord {
        uint8 survivorDenomIndex;
        uint32 survivorOriginCount;
        uint8 survivorInkGene;
        uint96 ownerTokenFrom;
        bytes survivorModules;
        ComposeInput[] inputs;
    }

    /// @dev Per-survivor LIFO stack of reversible composes. `compose` pushes, `decompose` pops
    ///      the top, so one survivor can be composed repeatedly and unwound newest first. A record
    ///      is left inert if the survivor is later burned or marked Black: `decompose`'s ownership
    ///      and `isBlack` checks reject every such case. See DECOMPOSE_SPEC.md.
    mapping(uint256 survivorId => ComposeRecord[]) private _composeStack;

    /// @dev Parent snapshot shared by every child of one split. `parentModules` records the
    ///      parent's effective geometry at split time, for provenance; it is not the pool the
    ///      children sampled from. `originDenomIndex` keeps the root split ancestor's denomination:
    ///      the parent's own value when the parent was itself a split child, else the parent's
    ///      denomination. `parentId` allows the split's sampling source to be reconstructed from
    ///      the parent's compose history. See SAMPLING_SPEC.md.
    struct SplitRecord {
        bytes32 parentSeed;
        uint96 parentId;
        uint8 parentDenomIndex;
        uint8 parentInkGene;
        uint8 originDenomIndex;
        bytes parentModules;
    }

    /// @dev Append-only, one entry per split operation. Referenced by `_splitOriginRef`.
    SplitRecord[] private _splitRecords;

    /// @dev One split child's reference to its shared `SplitRecord`: which record, and the
    ///      child's index within that split. `exists` separates a real reference at record 0, child
    ///      0 from the mapping's zero default for a token that was never a split child.
    struct SplitOriginRef {
        bool exists;
        uint64 recordIndex;
        uint32 childIndex;
    }

    /// @dev No entry for an original mint or for a token re-minted by `decompose`. A split child's
    ///      entry is never deleted, so it survives the child's own later compose or split.
    mapping(uint256 childId => SplitOriginRef) private _splitOriginRef;

    /// @inheritdoc IShapes
    uint256 public redeemableBacking;
    /// @inheritdoc IShapes
    uint256 public burnedBacking;
    /// @inheritdoc IShapes
    uint256 public blackShapeCount;
    /// @inheritdoc IShapes
    uint256 public totalSupply;
    /// @inheritdoc IShapes
    uint256 public totalMinted;

    /// @dev The apex denomination index. Only an apex Complete Shape may be sacrificed.
    uint256 private constant APEX_INDEX = 8;
    /// @dev Destination for burned backing. No known key, so the ETH is unspendable.
    address private constant UNSPENDABLE = 0x000000000000000000000000000000000000dEaD;

    /* --------------------------- fee and renderer --------------------------- */

    /// @dev Mint fee and fee recipient, grouped so one storage pointer reaches both.
    AdminOps.FeeConfig private _feeConfig;
    /// @inheritdoc IShapes
    uint256 public pendingFees;

    /// @inheritdoc IShapes
    function mintFee() public view returns (uint256) {
        return _feeConfig.mintFee;
    }

    /// @inheritdoc IShapes
    function feeRecipient() public view returns (address) {
        return _feeConfig.feeRecipient;
    }

    /// @inheritdoc IShapes
    address public immutable artist;

    /// @inheritdoc IShapes
    uint64 public immutable mintStart;

    /// @dev The artist's release hash and signature, grouped so one storage pointer reaches both.
    AdminOps.ArtistAttestation private _artistAttestation;

    /// @inheritdoc IShapes
    function artistReleaseHash() public view returns (bytes32) {
        return _artistAttestation.releaseHash;
    }

    /// @inheritdoc IShapes
    function artistSignature() public view returns (bytes memory) {
        return _artistAttestation.signature;
    }

    /// @inheritdoc IShapes
    /// @dev Replaceable by the admin via `setRenderer` until `lockRenderer`. Read only by
    ///      `tokenURI`, so renderer and collection metadata logic can never affect ETH, backing,
    ///      redemption or ownership.
    address public renderer;

    /// @inheritdoc IShapes
    bool public rendererLocked;

    /// @inheritdoc IShapes
    /// @dev Read only by `contractURI`. Replaceable by the admin until `lockRenderer`, which
    ///      freezes the renderer and the collection together.
    address public collection;

    /// @dev Default metadata copy, seeded at construction. Mirrors the canonical spec in
    ///      `preview/src/canonical/render.ts`; the parity suite asserts byte identity against it.
    string private constant DEFAULT_TOKEN_NAME_PREFIX = "Shape ";
    string private constant DEFAULT_DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";
    /// @dev Token name prefix and shared description, grouped so one storage pointer reaches
    ///      both.
    AdminOps.CopyConfig private _copyConfig;

    /// @inheritdoc IShapes
    /// @dev Admin-editable via `setMetadataCopy`, written verbatim into every token's metadata.
    ///      Not frozen by `lockRenderer`.
    function tokenNamePrefix() public view returns (string memory) {
        return _copyConfig.tokenNamePrefix;
    }

    /// @inheritdoc IShapes
    /// @dev Shared by token and collection metadata so the collection cannot describe itself
    ///      differently from its tokens.
    function description() public view returns (string memory) {
        return _copyConfig.description;
    }

    /// @dev Optional positions and market pointers, each with its own permanent lock. No token or
    ///      reserve operation reads them.
    PointerOps.Pointers private _pointers;

    /* -------------------------- ownership/admin -------------------------- */

    /// @dev Administrative authority. Separate from `owner()`, which resolves the holder of the
    ///      owner token. No authorization check reads token ownership.
    address private _admin;

    /// @dev The owner token's id plus one; zero means no owner token. Starts as Shape #0 and
    ///      moves through `compose`, `decompose` and `split`; cleared by redeeming or burning it.
    uint256 private _ownerToken;

    /// @param mintFee_ Flat fee in wei per Shape minted, charged on top of backing. May be zero,
    ///        up to `AdminOps.MAX_MINT_FEE`. Admin-adjustable afterward via `setMintFee`.
    /// @param feeRecipient_ Initial destination for accrued mint fees, paid only by `withdrawFees`.
    ///        A reverting recipient blocks only `withdrawFees`, never minting.
    /// @param renderer_ The onchain renderer. Replaceable by the admin until locked. An address
    ///        with no renderer code is refused here and by `setRenderer`.
    /// @param mintStart_ Unix timestamp at or after which public minting opens. Zero opens minting
    ///        immediately. Immutable after deployment.
    /// @dev Requires exactly `Denominations.amountAt(0)` as backing for Shape #0, minted fee-exempt
    ///      to `msg.sender` as the initial owner token. Shape #0 is minted in the constructor and is
    ///      not subject to `mintStart_`. Public minting begins at #1.
    constructor(
        uint256 mintFee_,
        address feeRecipient_,
        address renderer_,
        address collection_,
        uint64 mintStart_
    ) payable ERC721("Shapes", "SHAPE") {
        if (feeRecipient_ == address(0)) revert AdminInvalidFeeRecipient(address(0));
        _requireRendererHasCode(renderer_);
        _requireCollectionHasCode(collection_);
        _requireFeeWithinCap(mintFee_);
        _feeConfig.mintFee = mintFee_;
        _feeConfig.feeRecipient = feeRecipient_;
        artist = msg.sender;
        mintStart = mintStart_;
        renderer = renderer_;
        collection = collection_;
        _copyConfig.tokenNamePrefix = DEFAULT_TOKEN_NAME_PREFIX;
        _copyConfig.description = DEFAULT_DESCRIPTION;

        _admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);

        _ownerToken = 1;
        emit OwnerTokenMoved(type(uint256).max, 0);

        uint256 genesisBacking = Denominations.amountAt(0);
        if (msg.value != genesisBacking) revert IncorrectPayment(genesisBacking, msg.value);

        bytes32 batchRoot = _batchRoot(0);
        bytes32 seed = keccak256(abi.encodePacked(batchRoot, uint256(0)));
        uint8 gene = InkGenes.geneAtMint(seed, 0);

        totalMinted = 1;
        totalSupply = 1;
        redeemableBacking = genesisBacking;
        _shapes[0] = ShapeData({seed: seed, denomIndex: 0, originCount: 1, isBlack: false, inkGene: gene});

        emit ShapeMinted(0, msg.sender, genesisBacking, seed, 1);
        emit InkGene(0, gene);
        _mint(msg.sender, 0);
    }

    /// @inheritdoc IShapes
    function owner() public view returns (address) {
        return _ownerToken == 0 ? address(0) : _ownerOf(_ownerToken - 1);
    }

    /// @inheritdoc IShapes
    function ownerToken() external view returns (uint256) {
        if (_ownerToken == 0) revert NoOwnerToken();
        return _ownerToken - 1;
    }

    /// @inheritdoc IShapes
    function artistAttestationDigest(bytes32 releaseHash) public view returns (bytes32) {
        return EIP712Signature.artistDigest(artist, releaseHash);
    }

    /// @inheritdoc IShapes
    function attestArtist(bytes32 releaseHash, bytes calldata signature_) external {
        AdminOps.attestArtist(_artistAttestation, artist, releaseHash, signature_);
    }

    /// @inheritdoc IAdminControl
    function admin() public view returns (address) {
        return _admin;
    }

    modifier onlyAdmin() {
        if (msg.sender != _admin) revert AdminUnauthorizedAccount(msg.sender);
        _;
    }

    /// @inheritdoc IAdminControl
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert AdminInvalidAdmin(address(0));
        address previousAdmin = _admin;
        _admin = newAdmin;
        emit AdminTransferred(previousAdmin, newAdmin);
    }

    /// @inheritdoc IAdminControl
    function renounceAdmin() external onlyAdmin {
        address previousAdmin = _admin;
        _admin = address(0);
        emit AdminTransferred(previousAdmin, address(0));
    }

    /// @inheritdoc IAdminControl
    function setFeeRecipient(address newRecipient) external onlyAdmin {
        AdminOps.setFeeRecipient(_feeConfig, newRecipient);
    }

    /// @dev Construction has no prior fee to hand `AdminOps.setMintFee`, so the cap is enforced
    ///      here instead.
    function _requireFeeWithinCap(uint256 fee) private pure {
        if (fee > AdminOps.MAX_MINT_FEE) revert MintFeeAboveCap(fee);
    }

    /// @inheritdoc IAdminControl
    function setMintFee(uint256 newFee) external onlyAdmin {
        AdminOps.setMintFee(_feeConfig, newFee);
    }

    /// @dev One lock covers both presentation pointers: `setRenderer`, `setCollection` and
    ///      `lockRenderer` all gate on it.
    function _requireRendererUnlocked() private view {
        if (rendererLocked) revert RendererIsLocked();
    }

    /// @inheritdoc IShapes
    function setRenderer(address newRenderer) external onlyAdmin {
        _requireRendererUnlocked();
        _requireRendererHasCode(newRenderer);
        renderer = newRenderer;
        emit RendererUpdated(newRenderer);
        // A new renderer changes `tokenURI` for every existing token; ERC-4906 signals the refresh.
        _emitBatchMetadataUpdate();
    }

    /// @dev ERC-4906 refresh for every minted token. Shared by `setRenderer` and
    ///      `setMetadataCopy`, the two admin actions that change every token's `tokenURI` at once.
    function _emitBatchMetadataUpdate() private {
        if (totalMinted != 0) emit BatchMetadataUpdate(0, totalMinted - 1);
    }

    /// @inheritdoc IShapes
    /// @dev Admin only, one way. Freezes both `renderer` and `collection`, because `setCollection`
    ///      gates on the same lock. The positions and market pointers have their own locks.
    function lockRenderer() external onlyAdmin {
        _requireRendererUnlocked();
        rendererLocked = true;
        emit RendererLocked();
    }

    /// @inheritdoc IShapes
    /// @dev Admin only. Arguments are validated so copy cannot break or restructure metadata JSON.
    ///      Token and collection metadata share one description.
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_)
        external
        onlyAdmin
    {
        AdminOps.setMetadataCopy(_copyConfig, tokenNamePrefix_, description_, totalMinted);
    }

    /// @inheritdoc IShapes
    function setCollection(address newCollection) external onlyAdmin {
        _requireRendererUnlocked();
        _requireCollectionHasCode(newCollection);
        collection = newCollection;
        emit CollectionUpdated(newCollection);
    }

    /// @inheritdoc IShapes
    function setPointer(uint8 pointer, address target) external onlyAdmin {
        PointerOps.set(_pointers, pointer, target);
    }

    /// @inheritdoc IShapes
    function lockPointer(uint8 pointer) external onlyAdmin {
        PointerOps.lock(_pointers, pointer);
    }

    /// @inheritdoc IShapes
    function positions() external view returns (address target, bool locked) {
        PointerOps.Pointers storage p = _pointers;
        return (p.positions, p.positionsLocked);
    }

    /// @inheritdoc IShapes
    function market() external view returns (address target, bool locked) {
        PointerOps.Pointers storage p = _pointers;
        return (p.market, p.marketLocked);
    }

    /// @dev Returns false on a revert as well as on a false return, so the caller's revert path is
    ///      the same however `target` failed the check.
    function _supportsInterfaceOrFalse(address target, bytes4 interfaceId) private view returns (bool) {
        try IERC165(target).supportsInterface(interfaceId) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }

    /// @dev A zero address has no code, so the length check also rejects `address(0)`.
    function _requireRendererHasCode(address renderer_) private view {
        if (
            renderer_.code.length == 0
                || !_supportsInterfaceOrFalse(renderer_, type(IShapeRenderer).interfaceId)
        ) {
            revert UnsupportedRenderer(renderer_);
        }
    }

    function _requireCollectionHasCode(address collection_) private view {
        if (collection_.code.length == 0) revert UnsupportedCollection(collection_);
        if (!_supportsInterfaceOrFalse(collection_, type(IShapeCollection).interfaceId)) {
            revert UnsupportedCollection(collection_);
        }
    }

    /* ------------------------------ minting ----------------------------- */

    /// @inheritdoc IShapes
    function mint(uint256 amountWei) external payable nonReentrant returns (uint256 tokenId) {
        return _mintBatch(amountWei, 1, msg.sender);
    }

    /// @inheritdoc IShapes
    function mintTo(uint256 amountWei, address to) external payable nonReentrant returns (uint256 tokenId) {
        return _mintBatch(amountWei, 1, to);
    }

    /// @inheritdoc IShapes
    function mintBatch(uint256 amountWei, uint256 quantity)
        external
        payable
        nonReentrant
        returns (uint256 firstTokenId)
    {
        return _mintBatch(amountWei, quantity, msg.sender);
    }

    /// @inheritdoc IShapes
    function mintBatchTo(uint256 amountWei, uint256 quantity, address to)
        external
        payable
        nonReentrant
        returns (uint256 firstTokenId)
    {
        return _mintBatch(amountWei, quantity, to);
    }

    /// @dev One batch's seed root, from block-level inputs and the batch's own `firstTokenId`.
    ///      Shared by the constructor and `_mintBatch`. See the seed note in `_mintBatch`.
    function _batchRoot(uint256 firstTokenId) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                block.prevrandao,
                _previousBlockHash(),
                block.number,
                block.timestamp,
                block.chainid,
                address(this),
                firstTokenId
            )
        );
    }

    function _mintBatch(uint256 amountWei, uint256 quantity, address to)
        private
        returns (uint256 firstTokenId)
    {
        if (block.timestamp < mintStart) revert MintNotOpen();
        _requireNonZero(quantity);

        firstTokenId = totalMinted;

        // The fee is flat per token, so a batch costs the same as `quantity` separate mints.
        //
        // One seed root per batch; each token's seed mixes in its own id, so seeds are distinct
        // within a batch. No minter or recipient identity feeds the root, so naming a recipient
        // cannot search for a seed. Seeds are still grindable: because `firstTokenId == totalMinted`,
        // a minter can advance the ordinal with more mints, making visual traits selectable at about
        // one mint fee per try. Never treat a seed as secure randomness. Seeds do not affect backing
        // or redemption value, so trait scarcity is best-effort, not enforced.
        uint256 denomIndex;
        {
            bool ok;
            (denomIndex, ok) = Denominations.indexOf(amountWei);
            if (!ok) revert UnsupportedDenomination(amountWei);
        }
        uint256 backing = amountWei * quantity;
        uint256 fees = _feeConfig.mintFee * quantity;
        if (msg.value != backing + fees) revert IncorrectPayment(backing + fees, msg.value);
        bytes32 batchRoot = _batchRoot(firstTokenId);

        // -------- effects --------
        totalMinted = firstTokenId + quantity;
        totalSupply += quantity;
        redeemableBacking += backing;
        // Fees accrue in aggregate and never join the reserve. No external call happens before the
        // receiver callbacks below, so `address(this).balance` already equals
        // `redeemableBacking + pendingFees` when any of them runs.
        if (fees != 0) {
            pendingFees += fees;
            emit MintFeeAccrued(fees);
        }

        for (uint256 i = 0; i < quantity; ++i) {
            uint256 tokenId = firstTokenId + i;
            bytes32 seed = keccak256(abi.encodePacked(batchRoot, tokenId));
            uint8 gene = InkGenes.geneAtMint(seed, uint8(denomIndex));
            _shapes[tokenId] = ShapeData({
                seed: seed, denomIndex: uint8(denomIndex), originCount: 1, isBlack: false, inkGene: gene
            });
            emit ShapeMinted(tokenId, to, amountWei, seed, 1);
            emit InkGene(tokenId, gene);
        }

        // -------- interactions --------
        // Minting happens after every storage write, behind the reentrancy guard. `totalSupply` and
        // `redeemableBacking` already hold the whole batch while only some tokens exist, so supply
        // read from inside `onERC721Received` is the batch's end state, not its progress.
        for (uint256 i = 0; i < quantity; ++i) {
            _safeMint(to, firstTokenId + i);
        }
    }

    /// @inheritdoc IShapes
    /// @dev The recipient is read before the transfer. An admin contract that is also the fee
    ///      recipient could redirect itself from its own `receive` hook, but the event and the
    ///      transfer must name the address that actually received this withdrawal.
    function withdrawFees() external nonReentrant {
        uint256 amount = pendingFees;
        if (amount == 0) revert NoFeesPending();
        address recipient = _feeConfig.feeRecipient;
        pendingFees = 0;
        emit FeesWithdrawn(recipient, amount);
        _sendEth(recipient, amount);
    }

    /* ---------------------------- redemption ---------------------------- */

    /// @inheritdoc IShapes
    /// @dev Owner only, which fixes the payout destination. An approved operator reaches the same
    ///      outcome by transferring the Shape to itself and redeeming in the same transaction, so
    ///      approval is economically equivalent to granting redemption rights. Redeeming the owner
    ///      token ends collection ownership permanently.
    function redeem(uint256 tokenId) external nonReentrant {
        _redeemTo(tokenId, payable(msg.sender), false);
    }

    /// @inheritdoc IERC721Value
    /// @dev Uses the `IERC721Value` burn surface with stricter authorization: only the current
    ///      owner may burn. Approved operators must first take ownership through an ERC-721
    ///      transfer. Unlike `redeem`, this also destroys a Black Shape, for zero, with no ETH
    ///      call. Structural burns never route through here.
    function burn(uint256 tokenId) external nonReentrant {
        _redeemTo(tokenId, payable(msg.sender), true);
    }

    /// @inheritdoc IShapes
    function redeemBatch(uint256[] calldata tokenIds) external nonReentrant returns (uint256 totalWei) {
        return _redeemBatchTo(tokenIds, payable(msg.sender));
    }

    /// @inheritdoc IShapes
    function redeemTo(uint256 tokenId, address payable recipient) external nonReentrant {
        _redeemTo(tokenId, recipient, false);
    }

    /// @inheritdoc IShapes
    function redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        external
        nonReentrant
        returns (uint256 totalWei)
    {
        return _redeemBatchTo(tokenIds, recipient);
    }

    /// @dev Shared by `_redeemTo` and `_redeemBatchTo`: the payout destination can never be the
    ///      zero address, or the redemption would burn the ETH along with the token.
    function _requireValidRecipient(address recipient) private pure {
        if (recipient == address(0)) revert InvalidRecipient(recipient);
    }

    function _redeemTo(uint256 tokenId, address payable recipient, bool allowBlack) private {
        _requireValidRecipient(recipient);
        (uint256 amountWei, uint256 originCount) = _burnForRedemption(tokenId, allowBlack);

        totalSupply -= 1;
        redeemableBacking -= amountWei;

        emit ShapeRedeemed(tokenId, recipient, amountWei, originCount);
        if (amountWei != 0) _sendEth(recipient, amountWei);
    }

    function _redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        private
        returns (uint256 totalWei)
    {
        _requireValidRecipient(recipient);
        uint256 n = tokenIds.length;
        _requireNonZero(n);

        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = tokenIds[i];
            (uint256 amountWei, uint256 originCount) = _burnForRedemption(tokenId, false);
            totalWei += amountWei;
            emit ShapeRedeemed(tokenId, recipient, amountWei, originCount);
        }

        totalSupply -= n;
        redeemableBacking -= totalWei;

        _sendEth(recipient, totalWei);
    }

    /// @dev Checks and effects for one redemption: ownership, read the backing and origin count,
    ///      clear the token state, burn. The origin count is returned so the redemption event
    ///      carries it and an event-only indexer can track origin conservation without a pre-burn
    ///      state read. A duplicate id in a batch fails here the second time, because the token no
    ///      longer exists. Burning the owner token ends collection ownership permanently: no other
    ///      token inherits it.
    function _burnForRedemption(uint256 tokenId, bool allowBlack)
        private
        returns (uint256 amountWei, uint256 originCount)
    {
        address tokenOwner = _requireOwned(tokenId);
        if (tokenOwner != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        ShapeData storage d = _shapes[tokenId];
        if (d.isBlack && !allowBlack) revert TokenIsBlack(tokenId);

        amountWei = d.isBlack ? 0 : Denominations.amountAt(d.denomIndex);
        originCount = d.originCount;

        if (tokenId + 1 == _ownerToken) {
            _ownerToken = 0;
            emit OwnerTokenMoved(tokenId, type(uint256).max);
        }

        delete _shapes[tokenId];
        delete _sampledModules[tokenId];
        _burn(tokenId);
    }

    /// @dev The only path that moves ETH out. Redemption pays after the tokens are burned and the
    ///      accounting is updated; `sacrifice` pays the unspendable address out of the reserve;
    ///      `withdrawFees` pays out of `pendingFees`. A failed transfer reverts the whole call.
    function _sendEth(address to, uint256 amountWei) private {
        (bool sent,) = to.call{value: amountWei}("");
        if (!sent) revert EthTransferFailed(to, amountWei);
    }

    /* --------------------------- recomposition -------------------------- */

    /// @inheritdoc IShapes
    /// @dev Reshapes tokens without moving ETH: the summed backing is unchanged, so
    ///      `redeemableBacking` needs no adjustment and the reserve invariant holds by
    ///      construction. `_burn` triggers no receiver callback, so this makes no external call; it
    ///      is guarded regardless. A duplicate id in `burnIds` reverts the second time, because the
    ///      token no longer exists.
    function compose(uint256 survivorId, uint256[] calldata burnIds) external nonReentrant returns (uint256) {
        return _compose(survivorId, burnIds);
    }

    /// @inheritdoc IShapes
    /// @dev Runs each `(survivorId, burnIds)` compose in order under one reentrancy guard. Compose
    ///      mints nothing and keeps each survivor's id, so a later call may name a survivor an
    ///      earlier call in the same batch produced. Each compose pushes its own reversible record.
    ///      Atomic, and bounded by block gas; the caller sizes the batch.
    function composeMany(ComposeCall[] calldata calls)
        external
        nonReentrant
        returns (uint256[] memory outIds)
    {
        uint256 n = calls.length;
        _requireNonZero(n);
        outIds = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            outIds[i] = _compose(calls[i].survivorId, calls[i].burnIds);
        }
    }

    /// @dev Requires `n` be nonzero, for every batch entrypoint that rejects an empty batch.
    function _requireNonZero(uint256 n) private pure {
        if (n == 0) revert ZeroQuantity();
    }

    /// @dev Ownership and liveness gate for every entrypoint that requires the caller to hold a
    ///      non-Black token. Returns the token's storage slot so the caller does not re-derive it.
    function _requireCallerOwnsLive(uint256 tokenId) private view returns (ShapeData storage d) {
        if (ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        d = _shapes[tokenId];
        if (d.isBlack) revert TokenIsBlack(tokenId);
    }

    /// @dev Folds one burned donor into `acc` and returns its `Donor` snapshot for module
    ///      sampling.
    function _accumulateBurnDonor(
        ShapeData storage b,
        uint256 burnId,
        bytes memory burnModules,
        ShapeMath.BurnPoolAccum memory acc
    ) private view returns (GeometrySampling.Donor memory donor) {
        uint256 bUnits = ShapeMath.addDonor(acc, b.seed, b.denomIndex, b.originCount, b.inkGene);

        donor = GeometrySampling.Donor({
            id: burnId,
            units: bUnits,
            seed: b.seed,
            denomIndex: b.denomIndex,
            inkGene: b.inkGene,
            modules: burnModules
        });
    }

    function _compose(uint256 survivorId, uint256[] calldata burnIds) private returns (uint256) {
        uint256 n = burnIds.length;
        if (n == 0) revert EmptyRecomposition();

        ShapeData storage s = _requireCallerOwnsLive(survivorId);

        // Read before the loop, so nothing burned inside it can affect these values.
        uint8 oldIndex = s.denomIndex;
        ShapeMath.BurnPoolAccum memory acc;
        uint256 survivorUnits = ShapeMath.initPool(acc, oldIndex, s.originCount, s.inkGene);

        // `decompose` pops this record and restores exactly these values.
        ComposeRecord storage rec = _composeStack[survivorId].push();
        rec.survivorDenomIndex = oldIndex;
        rec.survivorOriginCount = uint32(s.originCount);
        rec.survivorInkGene = s.inkGene;
        rec.survivorModules = _sampledModules[survivorId];

        // Donor snapshots for module sampling, collected in calldata order. Sorted by id below so
        // compose output does not depend on the caller's burnIds order. See SAMPLING_SPEC.md.
        GeometrySampling.Donor[] memory burnDonors = new GeometrySampling.Donor[](n);

        for (uint256 i = 0; i < n; ++i) {
            uint256 burnId = burnIds[i];
            if (burnId == survivorId) revert CannotComposeWithSelf(burnId);
            ShapeData storage b = _requireCallerOwnsLive(burnId);

            bytes memory burnModules = _sampledModules[burnId];
            burnDonors[i] = _accumulateBurnDonor(b, burnId, burnModules, acc);

            // Snapshot the input verbatim, then burn it. Re-minted by `decompose` under this id.
            rec.inputs
                .push(
                    ComposeInput({
                        seed: b.seed,
                        id: uint96(burnId),
                        originCount: b.originCount,
                        denomIndex: b.denomIndex,
                        inkGene: b.inkGene,
                        modules: burnModules
                    })
                );

            if (burnId + 1 == _ownerToken) {
                // A live token id plus one, so the same width bound as `ComposeInput.id` holds.
                rec.ownerTokenFrom = uint96(_ownerToken);
                _ownerToken = survivorId + 1;
                emit OwnerTokenMoved(burnId, survivorId);
            }

            delete _shapes[burnId];
            delete _sampledModules[burnId];
            _burn(burnId);
            emit ShapeAbsorbed(survivorId, burnId);
        }

        // The summed backing must land on a denomination, or the composition is rejected.
        uint256 newIndex = Denominations.requireIndexOf(acc.total);

        uint8 centerGene = InkGenes.center(acc.sumW, acc.unitsTotal);
        (uint8 newGene, bytes memory sampled) = ComposeCompute.composeSampleAndGene(
            _survivorDonor(survivorId, survivorUnits, s.seed, oldIndex, s.inkGene, rec.survivorModules),
            burnDonors,
            acc.burnSeedFold,
            uint8(newIndex),
            acc.best,
            acc.worst,
            centerGene
        );

        totalSupply -= n;
        s.denomIndex = uint8(newIndex);
        s.originCount = uint32(acc.origins); // <= total/UNIT <= 10000 by the capacity invariant
        s.inkGene = newGene;
        _sampledModules[survivorId] = sampled;

        emit Composed(survivorId, burnIds, uint8(newIndex), uint32(acc.origins));
        emit InkGene(survivorId, newGene);
        emit ModulesSampled(survivorId, sampled);
        emit MetadataUpdate(survivorId);
        return survivorId;
    }

    /// @dev The survivor's own donor snapshot for compose sampling.
    ///      `GeometrySampling.sampleComposeSorted` places it at index 0 whatever its id.
    function _survivorDonor(
        uint256 survivorId,
        uint256 survivorUnits,
        bytes32 survivorSeed,
        uint8 survivorDenomIndex,
        uint8 survivorInkGene,
        bytes memory survivorModules
    ) private pure returns (GeometrySampling.Donor memory) {
        return GeometrySampling.Donor({
            id: survivorId,
            units: survivorUnits,
            seed: survivorSeed,
            denomIndex: survivorDenomIndex,
            inkGene: survivorInkGene,
            modules: survivorModules
        });
    }

    /// @inheritdoc IShapes
    /// @dev Burns the input and mints outputs whose backing sums to the input's, so
    ///      `redeemableBacking` is untouched. Child seeds derive from the parent seed, fixing the
    ///      whole split tree at mint. All accounting precedes the `_safeMint` loop, so a receiver
    ///      callback sees consistent state.
    function split(uint256 tokenId, uint8[] calldata outDenoms)
        external
        nonReentrant
        returns (uint256[] memory newIds)
    {
        return _splitTo(tokenId, outDenoms, msg.sender);
    }

    /// @inheritdoc IShapes
    function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        external
        nonReentrant
        returns (uint256[] memory newIds)
    {
        return _splitTo(tokenId, outDenoms, recipient);
    }

    function _splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        private
        returns (uint256[] memory newIds)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert SplitTooFewOutputs();

        ShapeData storage p = _requireCallerOwnsLive(tokenId);

        // The parent's pre-burn state. Group these values into one memory struct to reduce stack
        // pressure. `parentModules` is the parent's effective geometry, read before the parent is
        // burned below. It is kept for provenance only: neither sampling branch reads it.
        //
        // Keep the root split ancestor's denomination across later splits. The parent already
        // carries one when it was itself a split child; otherwise the parent is the root and its
        // own denomination is the origin.
        SplitOriginRef storage parentRef = _splitOriginRef[tokenId];
        uint8 originDenomIndex =
            parentRef.exists ? _splitRecords[parentRef.recordIndex].originDenomIndex : p.denomIndex;

        SplitRecord memory rec = SplitRecord({
            parentSeed: p.seed,
            parentId: uint96(tokenId),
            parentDenomIndex: p.denomIndex,
            parentInkGene: p.inkGene,
            originDenomIndex: originDenomIndex,
            parentModules: GeometrySampling.effectiveModulesOf(
                _sampledModules[tokenId], p.seed, p.denomIndex, p.inkGene
            )
        });

        // If the parent has a compose record, all children sample from that record's donor pool,
        // which does not depend on the child denomination and is built once here. Otherwise each
        // child samples from grammar v1 at its own denomination, read fresh per child in the loop.
        // Split never deletes `_composeStack[tokenId]`, so this branch decision can be redone later
        // from `parentId` and `composeDepth`. See SAMPLING_SPEC.md.
        uint256 recordDepth = _composeStack[tokenId].length;
        bool hasRecordPool = recordDepth > 0;
        bytes memory recordPool = hasRecordPool
            ? _buildSplitRecordPool(_composeStack[tokenId][recordDepth - 1], rec.parentSeed)
            : bytes("");

        // Every output is at least one unit and the outputs sum to the parent's backing, which is
        // at most 10000 units, so `k <= 10000` and the `uint32` child index below cannot overflow.
        ShapeMath.requireSplitSumMatches(Denominations.amountAt(rec.parentDenomIndex), outDenoms);
        uint32[] memory give = ShapeMath.allocateSplitOrigins(p.originCount, outDenoms);

        // -------- effects --------
        delete _shapes[tokenId];
        delete _sampledModules[tokenId];
        _burn(tokenId);

        // One split record per split operation, referenced by every child below. `_splitRecords`
        // grows by one entry per call, so a `uint64` index cannot realistically be exhausted.
        uint64 splitRecordIndex = uint64(_splitRecords.length);
        _splitRecords.push(rec);

        uint256 firstId = totalMinted;
        totalMinted = firstId + k;
        totalSupply += k - 1; // burned one, minting k

        if (tokenId + 1 == _ownerToken) {
            _ownerToken = firstId + 1;
            emit OwnerTokenMoved(tokenId, firstId);
        }

        newIds = new uint256[](k);
        bytes[] memory childModules = new bytes[](k);
        for (uint256 i = 0; i < k; ++i) {
            uint256 nid = firstId + i;
            newIds[i] = nid;
            _shapes[nid] = ShapeData({
                seed: ShapeMath.childSeed(rec.parentSeed, i),
                denomIndex: outDenoms[i],
                originCount: give[i],
                isBlack: false,
                inkGene: rec.parentInkGene
            });

            childModules[i] = GeometrySampling.sampleSplitChildFromPool(
                hasRecordPool, recordPool, rec.parentSeed, rec.parentInkGene, outDenoms[i], i
            );
            _sampledModules[nid] = childModules[i];
            _splitOriginRef[nid] =
                SplitOriginRef({exists: true, recordIndex: splitRecordIndex, childIndex: uint32(i)});
        }

        emit Split(tokenId, rec.parentSeed, newIds, outDenoms, give);
        for (uint256 i = 0; i < k; ++i) {
            emit InkGene(newIds[i], rec.parentInkGene);
            emit ShapeFragmentCreated(tokenId, newIds[i], rec.parentSeed, i);
            emit ModulesSampled(newIds[i], childModules[i]);
        }

        // -------- interactions --------
        for (uint256 i = 0; i < k; ++i) {
            _safeMint(recipient, newIds[i]);
        }
    }

    /// @dev Builds a split's sampling pool from the parent's top compose record: the pre-compose
    ///      survivor's effective modules first, then the record's inputs' effective modules. Sort
    ///      donors by id so split output does not depend on the earlier compose's burnIds order,
    ///      which is the order `rec.inputs` is stored in. See SAMPLING_SPEC.md.
    function _buildSplitRecordPool(ComposeRecord storage rec, bytes32 parentSeed)
        private
        view
        returns (bytes memory)
    {
        uint256 m = rec.inputs.length;
        GeometrySampling.Donor[] memory inputDonors = new GeometrySampling.Donor[](m);
        for (uint256 i = 0; i < m; ++i) {
            ComposeInput storage inp = rec.inputs[i];
            inputDonors[i] = GeometrySampling.Donor({
                id: inp.id,
                units: 0, // unused: split's pool concatenates every donor's modules, unweighted
                seed: inp.seed,
                denomIndex: inp.denomIndex,
                inkGene: inp.inkGene,
                modules: inp.modules
            });
        }
        return GeometrySampling.buildSplitRecordPoolSorted(
            rec.survivorModules, parentSeed, rec.survivorDenomIndex, rec.survivorInkGene, inputDonors
        );
    }

    /// @inheritdoc IShapes
    /// @dev The inverse of `compose`. Pops the survivor's top compose record: the survivor returns
    ///      to its pre-compose state and every burned input is re-minted under its original id and
    ///      seed. `totalMinted` does not move, because those ids are reused. Reuse cannot collide:
    ///      a fresh mint takes `totalMinted` itself, above every id ever issued. LIFO: stacked
    ///      composes unwind newest first. Backing is conserved. The owner token move, if this record
    ///      carried one, waits until every restored id exists. See DECOMPOSE_SPEC.md.
    function decompose(uint256 survivorId) external nonReentrant returns (uint256[] memory restoredIds) {
        return _decomposeTo(survivorId, msg.sender);
    }

    /// @inheritdoc IShapes
    function decomposeTo(uint256 survivorId, address recipient)
        external
        nonReentrant
        returns (uint256[] memory restoredIds)
    {
        return _decomposeTo(survivorId, recipient);
    }

    /// @inheritdoc IShapes
    /// @dev Decomposes each survivor in order under one reentrancy guard. Repeat an id to pop
    ///      several stacked records. List ids parent-before-child to unwind a nested tree, so a
    ///      re-minted input exists by the time its own id is reached. Atomic, and bounded by block
    ///      gas; the caller sizes the batch.
    function decomposeMany(uint256[] calldata survivorIds)
        external
        nonReentrant
        returns (uint256[][] memory restoredIds)
    {
        return _decomposeMany(survivorIds, msg.sender);
    }

    /// @inheritdoc IShapes
    function decomposeManyTo(uint256[] calldata survivorIds, address recipient)
        external
        nonReentrant
        returns (uint256[][] memory restoredIds)
    {
        return _decomposeMany(survivorIds, recipient);
    }

    function _decomposeMany(uint256[] calldata survivorIds, address recipient)
        private
        returns (uint256[][] memory restoredIds)
    {
        uint256 n = survivorIds.length;
        _requireNonZero(n);
        restoredIds = new uint256[][](n);
        for (uint256 i = 0; i < n; ++i) {
            restoredIds[i] = _decomposeTo(survivorIds[i], recipient);
        }
    }

    function _decomposeTo(uint256 survivorId, address recipient)
        private
        returns (uint256[] memory restoredIds)
    {
        ShapeData storage s = _requireCallerOwnsLive(survivorId);

        ComposeRecord[] storage stack = _composeStack[survivorId];
        uint256 depth = stack.length;
        if (depth == 0) revert NoComposeRecord(survivorId);
        ComposeRecord storage rec = stack[depth - 1];
        uint256 m = rec.inputs.length;
        uint96 ownerTokenFrom = rec.ownerTokenFrom;

        // -------- effects --------
        // Restore the survivor to its pre-compose state. Its seed is unchanged: compose never
        // wrote it.
        s.denomIndex = rec.survivorDenomIndex;
        s.originCount = rec.survivorOriginCount;
        s.inkGene = rec.survivorInkGene;
        _sampledModules[survivorId] = rec.survivorModules;

        restoredIds = new uint256[](m);
        uint8[] memory genes = new uint8[](m);
        for (uint256 i = 0; i < m; ++i) {
            ComposeInput storage inp = rec.inputs[i];
            uint256 iid = inp.id;
            _shapes[iid] = ShapeData({
                seed: inp.seed,
                denomIndex: inp.denomIndex,
                originCount: inp.originCount,
                isBlack: false,
                inkGene: inp.inkGene
            });
            _sampledModules[iid] = inp.modules;
            restoredIds[i] = iid;
            genes[i] = inp.inkGene;
        }

        totalSupply += m; // compose burned m inputs; decompose re-mints them, survivor stays
        bytes memory survivorModules = _sampledModules[survivorId];
        stack.pop(); // clears the record and its inputs array

        emit Decomposed(survivorId, restoredIds, s.denomIndex, s.originCount);
        emit InkGene(survivorId, s.inkGene);
        emit ModulesSampled(survivorId, survivorModules);
        for (uint256 i = 0; i < m; ++i) {
            emit InkGene(restoredIds[i], genes[i]);
            emit ShapeRevived(survivorId, restoredIds[i]);
            emit ModulesSampled(restoredIds[i], _sampledModules[restoredIds[i]]);
        }
        emit MetadataUpdate(survivorId);

        // -------- interactions --------
        // The restored owner token can sit at any position in `rec.inputs`, so `_ownerToken` moves
        // only after every mint completes. Moving it before the loop would let an earlier receiver
        // callback see `ownerToken()` pointing at an id not yet minted, with `owner()` reading zero.
        for (uint256 i = 0; i < m; ++i) {
            _safeMint(recipient, restoredIds[i]);
        }

        if (ownerTokenFrom != 0) {
            _ownerToken = ownerTokenFrom;
            emit OwnerTokenMoved(survivorId, uint256(ownerTokenFrom) - 1);
        }
    }

    /// @inheritdoc IShapes
    /// @dev Only a complete apex Shape may be sacrificed. It becomes Black, its backing leaves
    ///      `redeemableBacking`, the same amount is added to `burnedBacking`, and that ETH is
    ///      sent to the fixed unspendable address. The token stays alive but can no longer redeem
    ///      ETH. CEI: the token is marked Black before the transfer, which is last.
    function sacrifice(uint256 tokenId) external nonReentrant {
        ShapeData storage d = _requireCallerOwnsLive(tokenId);
        if (d.denomIndex != APEX_INDEX || d.originCount != Denominations.unitsAt(APEX_INDEX)) {
            revert NotApexComplete(tokenId);
        }
        // Read the apex backing from the ladder so it cannot drift from the denomination table.
        uint256 apexBacking = Denominations.amountAt(APEX_INDEX);

        // -------- effects --------
        d.isBlack = true;
        redeemableBacking -= apexBacking;
        burnedBacking += apexBacking;
        blackShapeCount += 1;

        emit Blackened(tokenId, apexBacking);
        emit MetadataUpdate(tokenId);

        // -------- interactions --------
        _sendEth(UNSPENDABLE, apexBacking);
    }

    /* ------------------------------- views ------------------------------ */

    /// @inheritdoc IShapes
    function formationOf(uint256 tokenId) public view returns (ShapeFormation) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return ShapeMath.formation(d.denomIndex, d.originCount, d.isBlack);
    }

    /// @inheritdoc IShapes
    function backingOf(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return d.isBlack ? 0 : Denominations.amountAt(d.denomIndex);
    }

    /// @inheritdoc IShapes
    function denomIndexOf(uint256 tokenId) external view returns (uint8) {
        _requireOwned(tokenId);
        return _shapes[tokenId].denomIndex;
    }

    /// @inheritdoc IShapes
    function modulesOf(uint256 tokenId) external view returns (bytes memory) {
        _requireOwned(tokenId);
        return _sampledModules[tokenId];
    }

    /// @inheritdoc IERC721Value
    function valueOf(uint256 tokenId) external view returns (uint256) {
        return backingOf(tokenId);
    }

    /// @inheritdoc IShapes
    function isBlack(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        return _shapes[tokenId].isBlack;
    }

    /// @inheritdoc IShapes
    function seedOf(uint256 tokenId) public view returns (bytes32) {
        _requireOwned(tokenId);
        return _shapes[tokenId].seed;
    }

    /// @inheritdoc IShapes
    function originCountOf(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        return _shapes[tokenId].originCount;
    }

    /// @inheritdoc IShapes
    function inkGeneOf(uint256 tokenId) public view returns (uint8) {
        _requireOwned(tokenId);
        return _shapes[tokenId].inkGene;
    }

    /// @inheritdoc IShapes
    function isComplete(uint256 tokenId) public view returns (bool) {
        return formationOf(tokenId) == ShapeFormation.Complete;
    }

    /// @inheritdoc IShapes
    function composeDepth(uint256 survivorId) external view returns (uint256) {
        return _composeStack[survivorId].length;
    }

    /// @inheritdoc IShapes
    /// @dev Returns the stored compose header at `depth`. An out-of-range depth uses Solidity's
    ///      normal array bounds panic.
    function composeRecordHeaderAt(uint256 survivorId, uint256 depth)
        external
        view
        returns (
            uint8 survivorDenomIndex,
            uint32 survivorOriginCount,
            uint8 survivorInkGene,
            uint96 ownerTokenFrom,
            bytes memory survivorModules,
            uint256 inputCount
        )
    {
        ComposeRecord storage rec = _composeStack[survivorId][depth];
        return (
            rec.survivorDenomIndex,
            rec.survivorOriginCount,
            rec.survivorInkGene,
            rec.ownerTokenFrom,
            rec.survivorModules,
            rec.inputs.length
        );
    }

    /// @inheritdoc IShapes
    /// @dev Returns one stored compose input. An out-of-range input index uses Solidity's normal
    ///      array bounds panic.
    function composeRecordInputAt(uint256 survivorId, uint256 depth, uint256 inputIndex)
        external
        view
        returns (
            uint256 id,
            bytes32 seed,
            uint8 denomIndex,
            uint32 originCount,
            uint8 inkGene,
            bytes memory modules
        )
    {
        ComposeInput storage inp = _composeStack[survivorId][depth].inputs[inputIndex];
        return (inp.id, inp.seed, inp.denomIndex, inp.originCount, inp.inkGene, inp.modules);
    }

    /// @inheritdoc IShapes
    /// @dev Returns the stored split-origin fields for `childId`, verbatim. `parentId` re-derives
    ///      the split's sampling branch: `composeDepth(parentId) > 0` selects the compose-record
    ///      pool, rebuilt from `composeRecordHeaderAt` and `composeRecordInputAt` at that depth.
    ///      `originDenomIndex` is the root split ancestor's denomination, read directly by the
    ///      "Split Origin" metadata trait.
    function splitOriginRaw(uint256 childId)
        external
        view
        returns (
            bytes32 parentSeed,
            uint256 parentId,
            uint8 parentDenomIndex,
            uint8 originDenomIndex,
            uint8 parentInkGene,
            bytes memory parentModules,
            uint256 childIndex
        )
    {
        SplitOriginRef storage ref = _splitOriginRef[childId];
        if (!ref.exists) revert NotASplitChild(childId);
        SplitRecord storage rec = _splitRecords[ref.recordIndex];
        return (
            rec.parentSeed,
            rec.parentId,
            rec.parentDenomIndex,
            rec.originDenomIndex,
            rec.parentInkGene,
            rec.parentModules,
            ref.childIndex
        );
    }

    /// @dev A fresh local EVM may execute at genesis. Production transactions cannot, but keeping
    ///      this seed input total makes constructor simulation and local deployment reliable.
    function _previousBlockHash() private view returns (bytes32) {
        return block.number == 0 ? bytes32(0) : blockhash(block.number - 1);
    }

    /// @inheritdoc IShapes
    function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32) {
        return ShapeMath.childSeed(parentSeed, childIndex);
    }

    /// @inheritdoc IShapes
    function denominationAt(uint8 index) external pure returns (uint256) {
        return Denominations.amountAt(index);
    }

    /// @inheritdoc IShapes
    function denominationCount() external pure returns (uint8) {
        return uint8(Denominations.COUNT);
    }

    /// @inheritdoc IShapes
    function unit() external pure returns (uint256) {
        return Denominations.UNIT;
    }

    /// @notice EIP-2981 royalty, permanently zero.
    /// @dev Declared rather than omitted so a marketplace reading the standard is told the rate
    ///      instead of falling back to its own default.
    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        return (address(0), 0);
    }

    /// @inheritdoc IShapes
    function contractURI() external view returns (string memory) {
        return IShapeCollection(collection).contractURI(name(), _copyConfig.description);
    }

    /// @notice Fully onchain metadata. Base64 JSON containing a base64 SVG.
    /// @dev Original mints use seed-based geometry (grammar v1). Compose survivors and split
    ///      children carry stored sampled geometry (grammar v2) and use the sampled path. A split
    ///      child always carries stored geometry, so its split provenance traits only ever reach
    ///      the renderer through the sampled path.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        bytes memory modules = _sampledModules[tokenId];
        uint256 amountWei = Denominations.amountAt(d.denomIndex);
        uint256 depth = _composeStack[tokenId].length;
        bool isOwnerToken = tokenId + 1 == _ownerToken;
        if (modules.length != 0) {
            return IShapeRenderer(renderer)
                .tokenURISampled(
                    modules,
                    amountWei,
                    tokenId,
                    d.originCount,
                    d.isBlack,
                    d.inkGene,
                    depth,
                    _copyConfig.tokenNamePrefix,
                    _copyConfig.description,
                    _splitProvenanceOf(tokenId),
                    isOwnerToken
                );
        }
        return IShapeRenderer(renderer)
            .tokenURI(
                d.seed,
                amountWei,
                tokenId,
                d.originCount,
                d.isBlack,
                d.inkGene,
                depth,
                _copyConfig.tokenNamePrefix,
                _copyConfig.description,
                isOwnerToken
            );
    }

    /// @dev Split creation provenance for `tokenId`'s metadata: the all-zero value for a token
    ///      that was never minted by `split`/`splitTo`, else its parent's and root split ancestor's
    ///      denomination indexes, read from its `SplitRecord`.
    function _splitProvenanceOf(uint256 tokenId) private view returns (SplitProvenance memory) {
        SplitOriginRef storage ref = _splitOriginRef[tokenId];
        if (!ref.exists) {
            return SplitProvenance({isSplitChild: false, parentDenomIndex: 0, originDenomIndex: 0});
        }
        SplitRecord storage rec = _splitRecords[ref.recordIndex];
        return SplitProvenance({
            isSplitChild: true, parentDenomIndex: rec.parentDenomIndex, originDenomIndex: rec.originDenomIndex
        });
    }

    /// @dev Refuses to place a Shape in this contract's own custody. `Shapes` can never be
    ///      `msg.sender`, so a token held here could never be redeemed: its backing would be
    ///      stranded while `redeemableBacking` went on counting it. The reserve invariant would
    ///      survive; the token's redeemability would not. `safeTransferFrom` already fails here on
    ///      the receiver check. This closes the plain `transferFrom` path and the mint path too.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (to == address(this)) revert SelfCustodyRejected(tokenId);
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IShapes).interfaceId || interfaceId == type(IAdminControl).interfaceId
            || interfaceId == type(IShapeValue).interfaceId
            || interfaceId == type(IShapeRecomposition).interfaceId
            || interfaceId == type(IShapeProvenance).interfaceId
            || interfaceId == type(IERC721Value).interfaceId || interfaceId == type(IERC2981).interfaceId
            || interfaceId == bytes4(0x49064906) // ERC-4906 metadata update
            || super.supportsInterface(interfaceId);
    }

    /* ------------------------- no stray deposits ------------------------ */

    /// @dev Direct ETH transfers are rejected. ETH normally enters only through construction and
    ///      the payable mint entrypoints. ETH may still be forced into the contract through EVM
    ///      paths that bypass `receive`.
    receive() external payable {
        revert DirectDepositRejected();
    }

    fallback() external payable {
        revert DirectDepositRejected();
    }
}

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
import {Denominations} from "./lib/Denominations.sol";
import {InkGenes} from "./lib/InkGenes.sol";
import {GeometrySampling} from "./lib/GeometrySampling.sol";
import {CopyValidation} from "./lib/CopyValidation.sol";
import {ComposeCompute} from "./lib/ComposeCompute.sol";
import {EIP712Signature} from "./lib/EIP712Signature.sol";
import {PointerOps} from "./lib/PointerOps.sol";

/// @title Shapes
/// @notice ETH in, Shape out.
///         Shape burned, ETH returned.
///
/// @dev Two paths move ETH out of the reserve, both through `_sendEth`: redemption, reached from
///      `redeem`, `burn` and their batch/recipient variants after the token is burned, and
///      `sacrifice`, which sends a fixed 100 ETH to an unspendable address. `compose`, `decompose`
///      and `split` reshape tokens at constant summed backing and leave the reserve unchanged.
///
///      The admin may replace the renderer via `setRenderer` and the collection metadata
///      contract via `setCollection`, and freeze both via `lockRenderer`. The renderer is read
///      only by `tokenURI`, the collection only by `contractURI`. The admin also holds the
///      metadata copy: `setMetadataCopy` atomically sets the token name prefix and the description
///      shared with `contractURI`, and remains editable after `lockRenderer`. Independently,
///      the admin may set, clear and permanently lock optional positions and market pointers;
///      core token and reserve operations never call either. The admin role is transferable and
///      may be renounced. None of these touch ETH, backing or redeemability.
///
///      Shape #0 represents ownership of this contract as a collectible object. `owner()` follows
///      its holder and returns zero while #0 is burned. Shape #0 is otherwise a normal backed
///      Shape and carries no administrative permissions; authorization uses the separate `admin()` role.
///
///      `artist()` permanently attributes the deployment to its deployer. That artist may store
///      one EIP-712 signature approving this exact contract and a release hash. The attribution
///      is stored directly in Shapes and grants no authority.
///
///      Reentrancy: `mint`, `mintBatch`, `compose`, `composeMany`, `decompose`, `decomposeMany`,
///      `split`, `sacrifice`, `burn`, the `redeem` entrypoints and every `*To` recipient variant
///      are guarded. The inherited ERC721 transfer and approval functions are not, so a receiver
///      can redeem a Shape from inside its own `onERC721Received` during a `safeTransferFrom`.
///      Accounting stays exact; an integrator that assumes the token still exists after a safe
///      transfer can be griefed into reverting.
///
///      Reserve invariant: `address(this).balance >= redeemableBacking()`, with equality in
///      normal operation. The inequality accommodates ETH forced in through paths that bypass
///      `receive`; such a surplus is permanently inaccessible.
contract Shapes is ERC721, ReentrancyGuard, IShapes, IERC2981, IERC4906 {
    /* ------------------------------ state ------------------------------ */

    /// @dev Per token: a visual seed, a denomination index, a provenance credit, a terminal
    ///      flag and an ink gene. Storing the index rather than a wei amount makes an
    ///      out-of-ladder backing value unrepresentable. `originCount` is the count of
    ///      independent direct-mint events credited to this token (one per mint, conserved
    ///      across composition and decomposition). `isBlack` marks a sacrificed token.
    ///      `inkGene` (INK_GENES_IMPL_SPEC.md) is assigned once at mint and thereafter evolves
    ///      only through `compose`; `decompose` restores the pre-compose value and `split` copies
    ///      it verbatim to every child. The last four pack into one slot.
    struct ShapeData {
        bytes32 seed;
        uint8 denomIndex;
        uint32 originCount;
        bool isBlack;
        uint8 inkGene;
    }

    mapping(uint256 tokenId => ShapeData) private _shapes;

    /// @dev Materialized module geometry, keyed by token id (SAMPLING_SPEC.md). Empty for a
    ///      token whose geometry derives from `seed` under grammar v1 (an original mint that has
    ///      never been composed or split). Nonempty for a compose survivor or a split child:
    ///      length equals the token's grid cell count at its current denomination, each byte a
    ///      module encoded per `ModuleCodec`. Restored verbatim by `decompose`.
    mapping(uint256 tokenId => bytes) private _sampledModules;

    /// @dev One burned compose input, holding everything needed to re-mint it verbatim in
    ///      `decompose`. `id` is a uint96: the token id, narrowed to help pack the fixed-size
    ///      fields into two slots (seed, then id+originCount+denomIndex+inkGene); `modules` takes
    ///      a further slot when nonempty. Overflow needs ~8e28 mints. `modules` is the burned
    ///      input's materialized geometry snapshot, empty if it had none.
    struct ComposeInput {
        bytes32 seed;
        uint96 id;
        uint32 originCount;
        uint8 denomIndex;
        uint8 inkGene;
        bytes modules;
    }

    /// @dev One reversible compose. `survivor*` is the survivor's pre-compose state, restored by
    ///      `decompose`; `inputs` are the burned tokens, re-minted verbatim. Self-contained: the
    ///      record alone suffices to reverse the compose, with no caller input and no dependence
    ///      on event history. The fixed-size survivor fields pack into one slot; `survivorModules`
    ///      (the survivor's pre-compose materialized geometry, empty if none) takes a further
    ///      slot when nonempty; `inputs` is dynamic.
    struct ComposeRecord {
        uint8 survivorDenomIndex;
        uint32 survivorOriginCount;
        uint8 survivorInkGene;
        bytes survivorModules;
        ComposeInput[] inputs;
    }

    /// @dev A per-survivor LIFO stack of reversible composes: `compose` pushes, `decompose` pops
    ///      the top. Stacking lets one survivor be composed repeatedly and unwound fully, newest
    ///      first. A record is abandoned (left inert, never actionable) if the survivor is
    ///      later burned by `split`/`redeem`/compose-as-input or marked Black — `decompose`'s
    ///      ownership and `isBlack` guards reject every such case. See DECOMPOSE_SPEC.md.
    mapping(uint256 survivorId => ComposeRecord[]) private _composeStack;

    /// @dev One split operation's parent snapshot, appended once per `_splitTo` call and shared
    ///      by every child of that split. `parentModules` is the parent's own effective
    ///      materialized geometry at split time (stored bytes if materialized, otherwise the
    ///      grammar v1 sequence derived from `parentSeed` at the parent's own denomination), read
    ///      before the parent is burned. Informational only since D3' (SAMPLING_SPEC.md section
    ///      6): the sampling pool split actually draws from is `parentId`'s top compose record
    ///      when it has one, or grammar v1 at each CHILD's own denomination otherwise, neither of
    ///      which `parentModules` necessarily equals. `parentId` is the burned parent's token id,
    ///      needed to re-read `_composeStack[parentId]` (which split does not delete, and which no
    ///      later operation on `parentId` can ever grow, since the id is burned) for reconstruction.
    ///      `originDenomIndex` is the root split ancestor's denomination index: the parent's own
    ///      `originDenomIndex` (via `_splitOriginRef[parentId]`) when the parent was itself a
    ///      split child, else `parentDenomIndex`. Set once at split time. Not reconstructable from
    ///      the rest of this struct, since `parentId`'s own `_splitOriginRef` entry may belong to a
    ///      different `SplitRecord` than this one; that is why it is stored here directly.
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

    /// @dev One split child's reference to its shared `SplitRecord`: which record, and its index
    ///      among that split's children. `exists` distinguishes a real reference (including
    ///      `recordIndex == 0, childIndex == 0`) from the mapping's zero default for a token that
    ///      was never a split child. Packs into one slot.
    struct SplitOriginRef {
        bool exists;
        uint64 recordIndex;
        uint32 childIndex;
    }

    /// @dev No entry for an original mint or for a token re-minted verbatim by `decompose` (that
    ///      path restores a `ComposeInput`, never writes here). A split child's entry survives the
    ///      child's own later mutation (e.g. becoming a compose survivor); it is never deleted.
    mapping(uint256 childId => SplitOriginRef) private _splitOriginRef;

    /// @inheritdoc IShapes
    uint256 public redeemableBacking;
    /// @inheritdoc IShapes
    uint256 public sacrificedBacking;
    /// @inheritdoc IShapes
    uint256 public blackCount;
    /// @inheritdoc IShapes
    uint256 public totalSupply;
    /// @inheritdoc IShapes
    uint256 public totalMinted;

    /// @dev The apex denomination (100 ETH) and its origin count, gating `sacrifice`.
    uint256 private constant APEX_INDEX = 8;
    /// @dev Where sacrificed ETH is sent: an address with no known key. Provably unspendable.
    address private constant UNSPENDABLE = 0x000000000000000000000000000000000000dEaD;

    /* --------------------------- fee and renderer --------------------------- */

    /// @inheritdoc IShapes
    uint256 public immutable mintFee;
    /// @inheritdoc IShapes
    address public feeRecipient;

    /// @inheritdoc IShapes
    address public immutable artist;

    /// @inheritdoc IShapes
    bytes32 public artistReleaseHash;

    /// @inheritdoc IShapes
    bytes public artistSignature;

    /// @inheritdoc IShapes
    /// @dev Not immutable: the admin may replace it via `setRenderer` to fix a rendering bug,
    ///      until `lockRenderer` freezes it permanently. It is read only by `tokenURI`, so it
    ///      never touches ETH, backing, redemption or ownership.
    address public renderer;

    /// @inheritdoc IShapes
    bool public rendererLocked;

    /// @inheritdoc IShapes
    /// @dev Read only by `contractURI`. Replaceable by the admin until `lockRenderer` freezes
    ///      both presentation pointers.
    address public collection;

    /// @dev Default metadata copy, seeded at construction. Mirrors the canonical spec in
    ///      `preview/src/canonical/render.ts`; the parity suite asserts byte identity against it.
    string private constant DEFAULT_TOKEN_NAME_PREFIX = "Shape ";
    string private constant DEFAULT_DESCRIPTION = "Shapes are ETH-backed onchain objects. Each Shape wraps an exact amount of ETH. "
        "Burning it returns exactly that amount to its owner. Higher denominations resolve "
        "into fewer, larger modules. Artwork and metadata are generated entirely onchain.";
    /// @inheritdoc IShapes
    /// @dev Editorial copy, admin-editable via `setMetadataCopy`, written verbatim into every token's
    ///      metadata by the renderer. Independent of `rendererLocked`.
    string public tokenNamePrefix;
    /// @inheritdoc IShapes
    /// @dev Shared by token and collection metadata so the collection cannot describe itself
    ///      differently from its tokens.
    string public description;

    /// @dev Explicit positions and market pointers with independent locks. `PointerOps` keeps
    ///      their administration outside this contract's EIP-170-constrained runtime.
    PointerOps.Pointers private _pointers;

    /* -------------------------- ownership/admin -------------------------- */

    /// @dev Administrative authority is deliberately separate from `owner()`, which resolves the
    ///      holder of backed Shape #0. No authorization check reads collectible ownership.
    address private _admin;

    /// @param mintFee_ Flat fee in wei for every Shape created. Charged on top of backing and may
    ///        be zero. A batch of `quantity` Shapes pays exactly `mintFee_ * quantity`.
    /// @param feeRecipient_ Initial destination for mint fees. The admin may redirect future fees.
    ///        It MUST be able to receive ETH: a recipient that reverts disables minting until the
    ///        admin replaces it. Prefer an EOA, or a splitter audited for a non-reverting `receive`.
    /// @param renderer_ The onchain renderer. Replaceable by the admin until locked. An address
    ///        with no renderer code is refused here and by `setRenderer`.
    /// @dev Pay exactly `Denominations.amountAt(0)` as backing for Shape #0. The collectible-ownership
    ///      Shape is fee-exempt and minted atomically to `msg.sender`, so permissionless artwork
    ///      minting begins at #1.
    constructor(uint256 mintFee_, address feeRecipient_, address renderer_, address collection_)
        payable
        ERC721("Shapes", "SHAPE")
    {
        require(feeRecipient_ != address(0), "fee recipient is zero");
        _requireRendererHasCode(renderer_);
        _requireCollectionHasCode(collection_);
        mintFee = mintFee_;
        feeRecipient = feeRecipient_;
        artist = msg.sender;
        renderer = renderer_;
        collection = collection_;
        tokenNamePrefix = DEFAULT_TOKEN_NAME_PREFIX;
        description = DEFAULT_DESCRIPTION;

        _admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);

        uint256 genesisBacking = Denominations.amountAt(0);
        if (msg.value != genesisBacking) revert IncorrectPayment(genesisBacking, msg.value);

        bytes32 batchRoot = keccak256(
            abi.encodePacked(
                block.prevrandao,
                _previousBlockHash(),
                block.number,
                block.timestamp,
                block.chainid,
                address(this),
                uint256(0)
            )
        );
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

    /// @notice The owner of Shapes as a collectible object: the current holder of Shape #0.
    /// @dev Returns zero after #0 is burned or split. This address has no administrative rights.
    function owner() public view returns (address) {
        return _ownerOf(0);
    }

    /// @inheritdoc IShapes
    function artistAttestationDigest(bytes32 releaseHash) public view returns (bytes32) {
        return EIP712Signature.artistDigest(artist, releaseHash);
    }

    /// @inheritdoc IShapes
    function attestArtist(bytes32 releaseHash, bytes calldata signature_) external {
        if (artistReleaseHash != bytes32(0)) revert ArtistAlreadyAttested();
        if (releaseHash == bytes32(0)) revert InvalidArtistReleaseHash();
        bytes32 digest = artistAttestationDigest(releaseHash);
        if (!EIP712Signature.isValidNow(artist, digest, signature_)) revert InvalidArtistSignature();

        artistReleaseHash = releaseHash;
        artistSignature = signature_;
        emit ArtistAttested(artist, releaseHash, signature_);
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
        if (newRecipient == address(0)) revert AdminInvalidFeeRecipient(address(0));
        address previousRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(previousRecipient, newRecipient);
    }

    /// @dev Shared by every entrypoint that requires the renderer/collection pointers to still be
    ///      mutable: `setRenderer`, `lockRenderer`, `setCollection`.
    function _requireRendererUnlocked() private view {
        if (rendererLocked) revert RendererIsLocked();
    }

    /// @inheritdoc IShapes
    /// @dev Admin only, and only while unlocked. The new renderer must carry code.
    function setRenderer(address newRenderer) external onlyAdmin {
        _requireRendererUnlocked();
        _requireRendererHasCode(newRenderer);
        renderer = newRenderer;
        emit RendererUpdated(newRenderer);
        // A new renderer changes `tokenURI` for every existing token; ERC-4906 signals the refresh.
        _emitBatchMetadataUpdate();
    }

    /// @dev ERC-4906 refresh signal for every currently-minted token. Shared by `setRenderer` and
    ///      `setMetadataCopy`, the two admin actions that change every token's `tokenURI` at once.
    function _emitBatchMetadataUpdate() private {
        if (totalMinted != 0) emit BatchMetadataUpdate(0, totalMinted - 1);
    }

    /// @inheritdoc IShapes
    /// @dev Admin only, one way. After this the renderer can never change again. The positions and
    ///      market pointers remain independently configurable until their own locks or renunciation.
    function lockRenderer() external onlyAdmin {
        _requireRendererUnlocked();
        rendererLocked = true;
        emit RendererLocked();
    }

    /// @dev Longest a name or name prefix may be, in bytes.
    uint256 private constant MAX_NAME_BYTES = 64;
    /// @dev Longest a description may be, in bytes.
    uint256 private constant MAX_DESCRIPTION_BYTES = 2048;

    /// @inheritdoc IShapes
    /// @dev Admin only. All arguments are validated so copy cannot break or restructure metadata
    ///      JSON. Token and collection descriptions deliberately share one value.
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_)
        external
        onlyAdmin
    {
        CopyValidation.requireJsonSafe(tokenNamePrefix_, MAX_NAME_BYTES, 0);
        CopyValidation.requireJsonSafe(description_, MAX_DESCRIPTION_BYTES, 1);
        tokenNamePrefix = tokenNamePrefix_;
        description = description_;
        _emitBatchMetadataUpdate();
        emit ContractURIUpdated();
    }

    /// @inheritdoc IShapes
    /// @dev Admin only, and only while unlocked. The new collection must carry code.
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

    /// @dev `false` on a revert or a `false` return from `target`'s `supportsInterface`, so the
    ///      caller's revert path is uniform regardless of why `target` failed the check. Shared
    ///      by `_requireRendererHasCode` and `_requireCollectionHasCode`.
    function _supportsInterfaceOrFalse(address target, bytes4 interfaceId) private view returns (bool) {
        try IERC165(target).supportsInterface(interfaceId) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }

    /// @dev Applied at construction and on every replacement. Metadata has no fallback path.
    function _requireRendererHasCode(address renderer_) private view {
        require(renderer_ != address(0), "renderer is zero");
        require(renderer_.code.length != 0, "renderer has no code");
        if (!_supportsInterfaceOrFalse(renderer_, type(IShapeRenderer).interfaceId)) {
            revert UnsupportedRenderer(renderer_);
        }
    }

    /// @dev Applied at construction and on every replacement. `contractURI` has no fallback path.
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

    function _mintBatch(uint256 amountWei, uint256 quantity, address to)
        private
        returns (uint256 firstTokenId)
    {
        _requireNonZero(quantity);

        firstTokenId = totalMinted;

        // The fee is flat per token, so a batch costs exactly the same as `quantity` independent
        // mints regardless of denomination.
        //
        // One entropy root per batch; each token's seed derives from it and its own id, so every
        // token in a batch gets a distinct seed.
        //
        // No minter or recipient identity feeds this root, so the seed cannot be enumerated by
        // varying the recipient. It is still selectable: `firstTokenId` is `totalMinted`, which a
        // minter can advance within one transaction by minting and redeeming dust (backing returns,
        // only the fee is spent), so the mint ordinal is a free knob and traits are grindable at
        // roughly the mint fee per candidate. The seed has no economic effect: redemption value is
        // fixed by denomination. Trait scarcity is best-effort, not enforced (SPEC.md D3e).
        uint256 denomIndex;
        {
            bool ok;
            (denomIndex, ok) = Denominations.indexOf(amountWei);
            if (!ok) revert UnsupportedDenomination(amountWei);
        }
        uint256 backing = amountWei * quantity;
        uint256 fees = mintFee * quantity;
        if (msg.value != backing + fees) revert IncorrectPayment(backing + fees, msg.value);
        bytes32 batchRoot = keccak256(
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

        // -------- effects --------
        totalMinted = firstTokenId + quantity;
        totalSupply += quantity;
        redeemableBacking += backing;

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
        // Fees are forwarded in aggregate and never join the reserve. Forwarding before the mint
        // loop means `address(this).balance` already equals `redeemableBacking` by the time any
        // ERC721 receiver callback runs.
        if (fees != 0) {
            // Snapshot before the external call. An admin contract may also be the fee recipient
            // and redirect later fees from its receive hook; this mint and its event must still
            // name the address that actually received this payment.
            address recipient = feeRecipient;
            (bool sent,) = recipient.call{value: fees}("");
            if (!sent) revert MintFeeTransferFailed(recipient, fees);
            emit MintFeePaid(recipient, fees, quantity);
        }

        // Minting after all storage writes, behind the reentrancy guard.
        //
        // During a batch `totalSupply` and `redeemableBacking` already reflect the whole batch
        // while only some tokens exist, so supply read from inside `onERC721Received` is the
        // batch's end state, not its progress.
        for (uint256 i = 0; i < quantity; ++i) {
            _safeMint(to, firstTokenId + i);
        }
    }

    /* ---------------------------- redemption ---------------------------- */

    /// @inheritdoc IShapes
    /// @dev Owner only, which fixes the payout destination. An approved operator reaches the same
    ///      outcome by transferring the Shape to itself and redeeming in the same transaction, so
    ///      approval is economically equivalent to granting redemption rights.
    function redeem(uint256 tokenId) external nonReentrant {
        _redeemTo(tokenId, payable(msg.sender), false);
    }

    /// @inheritdoc IERC721Value
    /// @dev Draft ERC-8060 entry point. It additionally permits a Black Shape to be destroyed
    ///      for zero without making an ETH call. Structural burns never route through here.
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

    /// @dev Checks and effects for a single redemption: ownership, read the backing and origin
    ///      count, clear the token state, burn. The origin count is returned so redemption events
    ///      carry it, letting an event-only indexer track global origin conservation without a
    ///      pre-burn state read. A duplicate id in a batch fails here on its second appearance,
    ///      because the token no longer exists.
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

        delete _shapes[tokenId];
        delete _sampledModules[tokenId];
        _burn(tokenId);
    }

    /// @dev The two paths that move ETH out of the reserve: a redemption payout, reached only
    ///      after the corresponding tokens are burned and the accounting is updated, and
    ///      `sacrifice`'s fixed 100 ETH transfer. A failed transfer reverts the whole call.
    function _sendEth(address to, uint256 amountWei) private {
        (bool sent,) = to.call{value: amountWei}("");
        if (!sent) revert EthTransferFailed(to, amountWei);
    }

    /* --------------------------- recomposition -------------------------- */

    /// @inheritdoc IShapes
    /// @dev Reshapes tokens without moving ETH: the summed backing is unchanged, so `redeemableBacking`
    ///      stays correct with no adjustment and the reserve invariant holds by construction.
    ///      `_burn` triggers no receiver callback, so this function makes no external calls; it is
    ///      guarded regardless. A duplicate id in `burnIds` reverts on its second appearance,
    ///      because the token no longer exists.
    function compose(uint256 survivorId, uint256[] calldata burnIds) external nonReentrant returns (uint256) {
        return _compose(survivorId, burnIds);
    }

    /// @inheritdoc IShapes
    /// @dev Runs each `(survivorId, burnIds)` compose in order, under one reentrancy guard. All ids
    ///      are pre-existing (compose mints nothing new and keeps each survivor's id), so a later
    ///      call may name a survivor an earlier call in the same batch produced. Each compose pushes
    ///      its own reversible record. Bounded by block gas; the caller sizes the batch. Atomic.
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

    /// @dev Ink gene pool statistics (INK_GENES_IMPL_SPEC.md §2.3, §3.3) accumulated over
    ///      {survivor + burns}, plus the running compose backing total and origin count. Folded
    ///      by `_accumulateBurnDonor` as `_compose` iterates the burn set; seeded from the
    ///      survivor's own contribution before the loop runs. `ShapeLens.previewCompose` folds
    ///      the equivalent accumulator over its own copy, read through this contract's getters.
    struct BurnPoolAccum {
        uint256 total;
        uint256 origins;
        uint256 burnSeedFold;
        uint8 best;
        uint8 worst;
        uint256 sumW;
        uint256 unitsTotal;
    }

    /// @dev Requires `n` be nonzero, for every batch entrypoint that rejects an empty batch.
    function _requireNonZero(uint256 n) private pure {
        if (n == 0) revert ZeroQuantity();
    }

    /// @dev Ownership and liveness gate shared by every entrypoint that requires the caller to
    ///      hold a non-Black token: reverts if `tokenId` is not owned by the caller, or if it is
    ///      Black. Returns the token's storage slot so the caller does not re-derive it.
    function _requireCallerOwnsLive(uint256 tokenId) private view returns (ShapeData storage d) {
        if (ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        d = _shapes[tokenId];
        if (d.isBlack) revert TokenIsBlack(tokenId);
    }

    /// @dev One burn-side donor's contribution to `acc`, plus its `Donor` snapshot for module
    ///      sampling. The per-donor step of the compose pool statistics, used by `_compose`.
    function _accumulateBurnDonor(
        ShapeData storage b,
        uint256 burnId,
        bytes memory burnModules,
        BurnPoolAccum memory acc
    ) private view returns (GeometrySampling.Donor memory donor) {
        acc.total += Denominations.amountAt(b.denomIndex);
        acc.origins += b.originCount;

        // Fold order-invariantly (XOR), so burnIds calldata order cannot affect the gene.
        acc.burnSeedFold ^= uint256(b.seed);
        if (b.inkGene > acc.best) acc.best = b.inkGene;
        if (b.inkGene < acc.worst) acc.worst = b.inkGene;
        uint256 bUnits = Denominations.unitsAt(b.denomIndex);
        acc.sumW += uint256(b.inkGene) * bUnits;
        acc.unitsTotal += bUnits;

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

        // `oldIndex` and the survivor's own pool contribution are captured before the loop so
        // they are unaffected by what gets burned inside it.
        uint8 oldIndex = s.denomIndex;
        uint256 survivorUnits = Denominations.unitsAt(oldIndex);
        BurnPoolAccum memory acc;
        acc.total = Denominations.amountAt(oldIndex);
        acc.origins = s.originCount;
        acc.best = s.inkGene;
        acc.worst = s.inkGene;
        acc.sumW = uint256(s.inkGene) * survivorUnits;
        acc.unitsTotal = survivorUnits;

        // Push the reversible record and capture the survivor's pre-compose state before the
        // loop mutates anything. `decompose` pops this to restore exactly these values.
        ComposeRecord storage rec = _composeStack[survivorId].push();
        rec.survivorDenomIndex = oldIndex;
        rec.survivorOriginCount = uint32(s.originCount);
        rec.survivorInkGene = s.inkGene;
        rec.survivorModules = _sampledModules[survivorId];

        // Donor snapshots for module sampling (SAMPLING_SPEC.md §5), collected in calldata order
        // and sorted below into canonical (ascending id) order before sampling.
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

    /// @dev The survivor's own `Donor` snapshot for compose sampling, placed at index 0 by
    ///      `GeometrySampling.sampleComposeSorted` regardless of its id. Used by `_compose`;
    ///      `ShapeLens.previewCompose` assembles the equivalent donor from this contract's getters.
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
    /// @dev Burns the input and mints fresh outputs whose backing sums to the input's, so
    ///      `redeemableBacking` is untouched. Child seeds derive from the parent seed deterministically,
    ///      fixing the full split tree at mint. All accounting precedes the `_safeMint` loop so
    ///      a receiver callback observes consistent state.
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

    /// @dev Requires the summed backing of `outDenoms` equal `parentBacking`, or the split is
    ///      rejected. Used by `_splitTo`; `ShapeLens.previewSplit` runs the same check.
    function _requireSplitSumMatches(uint256 parentBacking, uint8[] calldata outDenoms) private pure {
        uint256 sum;
        for (uint256 i = 0; i < outDenoms.length; ++i) {
            sum += Denominations.amountAt(outDenoms[i]);
        }
        if (sum != parentBacking) revert SplitMismatch(parentBacking, sum);
    }

    /// @dev Per-child origin-count allocation for a split: fills each output's capacity from
    ///      `originCount`, in order, until exhausted. Used by `_splitTo`; `ShapeLens.previewSplit`
    ///      runs the same allocation.
    function _allocateSplitOrigins(uint256 originCount, uint8[] calldata outDenoms)
        private
        pure
        returns (uint32[] memory give)
    {
        uint256 k = outDenoms.length;
        give = new uint32[](k);
        uint256 remaining = originCount;
        for (uint256 i = 0; i < k; ++i) {
            uint256 cap = Denominations.unitsAt(outDenoms[i]);
            uint256 g = remaining < cap ? remaining : cap;
            remaining -= g;
            give[i] = uint32(g);
        }
        // Sum of capacities == parentBacking/UNIT >= parent origin count, so the fill exhausts it.
        assert(remaining == 0);
    }

    function _splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        private
        returns (uint256[] memory newIds)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert EmptyRecomposition();

        ShapeData storage p = _requireCallerOwnsLive(tokenId);

        // The parent's pre-burn state, held as the record it will be pushed as. Bundling these
        // values into one memory struct rather than separate locals keeps `_splitTo` off the
        // stack-too-deep limit under the non-optimized codegen `forge coverage` uses.
        // `parentModules` is the parent's own effective geometry snapshot (its stored bytes if
        // materialized, otherwise the grammar v1 sequence from its seed at its own denomination),
        // read before the parent is burned below. Informational only (SAMPLING_SPEC.md §6, D3'):
        // the sampling pool below is not read from this field in either branch.
        //
        // `originDenomIndex` (issue #21C): the root split ancestor's denomination. The parent
        // carries one already (via its own `_splitOriginRef` entry) when it was itself a split
        // child; otherwise the parent is the root and its own denomination is the origin.
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

        // Split's sampling pool (SAMPLING_SPEC.md §6, D3'): the parent's top compose record's
        // donor pool when it has one (child-denomination-independent, built once here and reused
        // by every child below), else grammar v1 at each child's own denomination (denomination-
        // dependent, so read fresh per child in the loop). `_composeStack[tokenId]` is untouched
        // by split — read here, never deleted — so `ShapeLens`/off-chain reconstruction can redo
        // this same branch decision later via `parentId` and `Shapes.composeDepth`.
        uint256 recordDepth = _composeStack[tokenId].length;
        bool hasRecordPool = recordDepth > 0;
        bytes memory recordPool =
            hasRecordPool ? _buildSplitRecordPool(_composeStack[tokenId][recordDepth - 1], rec.parentSeed) : bytes("");

        _requireSplitSumMatches(Denominations.amountAt(rec.parentDenomIndex), outDenoms);
        uint32[] memory give = _allocateSplitOrigins(p.originCount, outDenoms);

        // -------- effects --------
        delete _shapes[tokenId];
        delete _sampledModules[tokenId];
        _burn(tokenId);

        // One shared split-origin record per operation (SAMPLING_SPEC.md "Provenance views"):
        // the parent's pre-burn state and effective modules, referenced by every child below.
        uint64 splitRecordIndex = uint64(_splitRecords.length);
        _splitRecords.push(rec);

        uint256 firstId = totalMinted;
        totalMinted = firstId + k;
        totalSupply += k - 1; // burned one, minting k

        newIds = new uint256[](k);
        bytes[] memory childModules = new bytes[](k);
        for (uint256 i = 0; i < k; ++i) {
            uint256 nid = firstId + i;
            newIds[i] = nid;
            _shapes[nid] = ShapeData({
                seed: _childSeed(rec.parentSeed, i),
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

    /// @dev Assembles a materialized-parent split's sampling pool from its top compose record
    ///      (SAMPLING_SPEC.md §6, D3'): the record's pre-compose survivor effective modules
    ///      first, then its inputs' effective modules ascending by donor id. `rec.inputs` is
    ///      stored in calldata order (the loop in `_compose` pushed them in that order), so this
    ///      sorts a memory copy before concatenating — required, or the split result would depend
    ///      on that earlier compose's burnIds calldata order, breaking burn-order independence.
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
                units: 0, // unused: split's pool concatenates every donor's modules, no weighting
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
    /// @dev The inverse of `compose`. Pops the survivor's top compose record and reverses that one
    ///      merge: the survivor reverts to its pre-compose denomination, origin count and gene (its
    ///      id and seed never changed), and every burned input is re-minted verbatim under its
    ///      original id and seed. `totalMinted` is not bumped — the input ids are reused, not freshly
    ///      issued, which is collision-free because a fresh mint takes `totalMinted` itself, above
    ///      every id already issued, and an id
    ///      belongs to at most one live record (DECOMPOSE_SPEC.md). LIFO: stacked composes on one
    ///      survivor unwind newest first. Backing is conserved, so `redeemableBacking` is untouched.
    ///      All accounting precedes the `_safeMint` loop so a receiver callback observes consistent
    ///      state.
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
    /// @dev Decomposes each survivor in `survivorIds`, in order, under one reentrancy guard. Repeat
    ///      an id to pop several stacked records; list ids parent-before-child to unwind a nested
    ///      tree (a re-minted input exists by the time its own id is reached). Bounded by block gas;
    ///      the caller sizes the batch. Atomic: any item reverting rolls back the whole call.
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

        // -------- effects --------
        // Restore the survivor to its pre-compose state. Seed is unchanged — compose never wrote it.
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
        for (uint256 i = 0; i < m; ++i) {
            _safeMint(recipient, restoredIds[i]);
        }
    }

    /// @inheritdoc IShapes
    /// @dev The second and final reserve outflow path sends a fixed 100 ETH to a fixed
    ///      unspendable address, moving the backing out of `redeemableBacking` into
    ///      `sacrificedBacking`. Unlike `burn`, the token remains alive and becomes Black.
    ///      CEI: the token is marked Black before the transfer, which is last.
    function sacrifice(uint256 tokenId) external nonReentrant {
        ShapeData storage d = _requireCallerOwnsLive(tokenId);
        if (d.denomIndex != APEX_INDEX || d.originCount != Denominations.unitsAt(APEX_INDEX)) {
            revert NotApexComplete(tokenId);
        }
        // The apex backing, from the ladder rather than a separate literal, so it cannot drift from
        // the denomination table (e.g. a scaled testnet build).
        uint256 apexBacking = Denominations.amountAt(APEX_INDEX);

        // -------- effects --------
        d.isBlack = true;
        redeemableBacking -= apexBacking;
        sacrificedBacking += apexBacking;
        blackCount += 1;

        emit Blackened(tokenId, apexBacking);
        emit MetadataUpdate(tokenId);

        // -------- interactions --------
        _sendEth(UNSPENDABLE, apexBacking);
    }

    /* ------------------------------- views ------------------------------ */

    function _formation(uint8 denomIndex, uint32 originCount, bool black)
        private
        pure
        returns (ShapeFormation)
    {
        if (black) return ShapeFormation.Black;
        uint256 units = Denominations.unitsAt(denomIndex);
        if (units > 1 && originCount == units) return ShapeFormation.Complete;
        if (originCount == 0) return ShapeFormation.Fragment;
        if (originCount == 1) return ShapeFormation.Direct;
        return ShapeFormation.Composed;
    }

    /// @inheritdoc IShapes
    function formationOf(uint256 tokenId) external view returns (ShapeFormation) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return _formation(d.denomIndex, d.originCount, d.isBlack);
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
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        uint256 units = Denominations.unitsAt(d.denomIndex);
        return !d.isBlack && units > 1 && d.originCount == units;
    }

    /// @inheritdoc IShapes
    function composeDepth(uint256 survivorId) external view returns (uint256) {
        return _composeStack[survivorId].length;
    }

    /// @inheritdoc IShapes
    /// @dev Raw accessor: the survivor's pre-compose fields and its input count at `depth`, with
    ///      no `ComposeInputView[]` assembly and no `depth` bounds check (unlike the removed
    ///      `composeRecordAt`, which reverted `ComposeRecordOutOfRange`) — an out-of-range `depth`
    ///      instead panics on the storage array access. `ShapeLens.composeRecordAt` checks `depth`
    ///      against `composeDepth` itself, reverting the same error, before calling this.
    function composeRecordHeaderAt(uint256 survivorId, uint256 depth)
        external
        view
        returns (
            uint8 survivorDenomIndex,
            uint32 survivorOriginCount,
            uint8 survivorInkGene,
            bytes memory survivorModules,
            uint256 inputCount
        )
    {
        ComposeRecord storage rec = _composeStack[survivorId][depth];
        return (
            rec.survivorDenomIndex,
            rec.survivorOriginCount,
            rec.survivorInkGene,
            rec.survivorModules,
            rec.inputs.length
        );
    }

    /// @inheritdoc IShapes
    /// @dev Raw accessor: one burned input's fields at `(survivorId, depth, inputIndex)`. Reverts
    ///      with the standard out-of-bounds panic for an `inputIndex` beyond the record's input
    ///      count; `ShapeLens` only ever calls this with indices below the count
    ///      `composeRecordHeaderAt` just reported.
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
    /// @dev Raw accessor: the stored split-origin fields for `childId`, verbatim. Already minimal
    ///      (a passthrough, no struct assembly); `ShapeLens.splitOriginOf` returns this unchanged.
    ///      `parentId` is needed to re-derive the split's sampling branch (SAMPLING_SPEC.md §6,
    ///      D3'): `composeDepth(parentId) > 0` means the record branch, whose donor pool is
    ///      rebuilt from `composeRecordHeaderAt`/`composeRecordInputAt` at that depth.
    ///      `originDenomIndex` is the root split ancestor's denomination (issue #21C): the "Split
    ///      Origin" metadata trait reads it directly, with no reconstruction needed.
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

    function _childSeed(bytes32 parentSeed, uint256 childIndex) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentSeed, childIndex));
    }

    /// @dev A fresh local EVM may execute at genesis. Production transactions cannot, but making
    ///      the entropy input total keeps constructor simulation and local deployment reliable.
    function _previousBlockHash() private view returns (bytes32) {
        return block.number == 0 ? bytes32(0) : blockhash(block.number - 1);
    }

    /// @inheritdoc IShapes
    function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32) {
        return _childSeed(parentSeed, childIndex);
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
        return IShapeCollection(collection).contractURI(name(), description);
    }

    /// @notice Fully onchain metadata. Base64 JSON containing a base64 SVG.
    /// @dev Reads the sampled path (grammar v2) when the token carries materialized geometry
    ///      (`_sampledModules[tokenId]` nonempty: a compose survivor or a split child), otherwise
    ///      the seed-based path (grammar v1, an original mint). A split child always carries
    ///      materialized geometry (`_splitTo` writes `_sampledModules` for every child), so its
    ///      "Split From" / "Split Origin" traits are only ever plumbed through the sampled path;
    ///      `_splitProvenanceOf` is the all-zero, non-split value for every other token.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        bytes memory modules = _sampledModules[tokenId];
        uint256 amountWei = Denominations.amountAt(d.denomIndex);
        uint256 depth = _composeStack[tokenId].length;
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
                    tokenNamePrefix,
                    description,
                    _splitProvenanceOf(tokenId)
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
                tokenNamePrefix,
                description
            );
    }

    /// @dev Split creation-provenance for `tokenId`'s metadata (issue #21C): the all-zero value
    ///      for a token that was never minted by `split`/`splitTo`, else its immediate parent's
    ///      and root split ancestor's denomination indexes, read from its `SplitRecord`.
    function _splitProvenanceOf(uint256 tokenId) private view returns (SplitProvenance memory) {
        SplitOriginRef storage ref = _splitOriginRef[tokenId];
        if (!ref.exists) {
            return SplitProvenance({isSplitChild: false, parentDenomIndex: 0, originDenomIndex: 0});
        }
        SplitRecord storage rec = _splitRecords[ref.recordIndex];
        return SplitProvenance({
            isSplitChild: true,
            parentDenomIndex: rec.parentDenomIndex,
            originDenomIndex: rec.originDenomIndex
        });
    }

    /// @dev Refuses to place a Shape in this contract's own custody.
    ///      `Shapes` can never be `msg.sender`, so a token held here could never be redeemed:
    ///      its backing would be stranded while `redeemableBacking` went on counting it. The
    ///      reserve invariant would survive, but the token's redeemability — the whole point
    ///      of the object — would not. `safeTransferFrom` already fails here because the
    ///      receiver check reverts; this closes the plain `transferFrom` path too, and the
    ///      mint path along with it.
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

    /// @dev ETH can only arrive through `mint` / `mintBatch`. Anything else is rejected, so
    ///      the contract balance never drifts above the reserve through ordinary transfers.
    receive() external payable {
        revert DirectDepositRejected();
    }

    fallback() external payable {
        revert DirectDepositRejected();
    }
}

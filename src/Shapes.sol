// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IShapeCollection} from "./interfaces/IShapeCollection.sol";
import {IShapes} from "./interfaces/IShapes.sol";
import {IShapeRenderer} from "./interfaces/IShapeRenderer.sol";
import {
    IShapeProvenance,
    IShapeRecomposition,
    IShapeSimulation,
    IShapeValue,
    ShapeChildPreview,
    ShapeFormation,
    ShapeState
} from "./interfaces/IShapeCapabilities.sol";
import {Denominations} from "./lib/Denominations.sol";
import {InkGenes} from "./lib/InkGenes.sol";

/// @title Shapes
/// @notice ETH in, Shape out.
///         Shape burned, ETH returned.
///
/// @dev Two paths move ETH out of the reserve: `_payRedemption`, reached from the `redeem` entrypoints
///      after the token is burned, and `blacken`, which sends a fixed 100 ETH to an unspendable
///      address. `compose`, `decompose` and `split` reshape tokens at constant summed
///      backing and leave the reserve unchanged.
///
///      The owner may replace the renderer via `setRenderer` and the collection metadata
///      contract via `setCollection`, and freeze both via `lockRenderer`. The renderer is read
///      only by `tokenURI`, the collection only by `contractURI`.
///
///      Reentrancy: `mint`, `mintBatch`, `compose`, `composeMany`, `decompose`, `decomposeMany`,
///      `split`, `blacken`, the `redeem` entrypoints and every `*To` recipient variant
///      are guarded. The inherited ERC721 transfer and approval functions are not, so a receiver
///      can redeem a Shape from inside its own `onERC721Received` during a `safeTransferFrom`.
///      Accounting stays exact; an integrator that assumes the token still exists after a safe
///      transfer can be griefed into reverting.
///
///      Reserve invariant: `address(this).balance >= redeemableBacking()`, with equality in
///      normal operation. The inequality accommodates ETH forced in through paths that bypass
///      `receive`; such a surplus is permanently inaccessible.
contract Shapes is ERC721, ReentrancyGuard, Ownable, IShapes, IERC2981, IERC4906 {
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


    /// @dev One burned compose input, holding everything needed to re-mint it verbatim in
    ///      `decompose`. `id` is a uint96: the token id, narrowed to pack the whole struct into
    ///      two slots (seed, then id+originCount+denomIndex+inkGene). Overflow needs ~8e28 mints.
    struct ComposeInput {
        bytes32 seed;
        uint96 id;
        uint32 originCount;
        uint8 denomIndex;
        uint8 inkGene;
    }

    /// @dev One reversible compose. `survivor*` is the survivor's pre-compose state, restored by
    ///      `decompose`; `inputs` are the burned tokens, re-minted verbatim. Self-contained: the
    ///      record alone suffices to reverse the compose, with no caller input and no dependence
    ///      on event history. The survivor fields pack into one slot; `inputs` is dynamic.
    struct ComposeRecord {
        uint8 survivorDenomIndex;
        uint32 survivorOriginCount;
        uint8 survivorInkGene;
        ComposeInput[] inputs;
    }

    /// @dev A per-survivor LIFO stack of reversible composes: `compose` pushes, `decompose` pops
    ///      the top. Stacking lets one survivor be composed repeatedly and unwound fully, newest
    ///      first. A record is abandoned (left inert, never actionable) if the survivor is
    ///      later burned by `split`/`redeem`/compose-as-input or marked Black — `decompose`'s
    ///      ownership and `isBlack` guards reject every such case. See DECOMPOSE_SPEC.md.
    mapping(uint256 survivorId => ComposeRecord[]) private _composeStack;

    /// @dev Complete deterministic result of a compose preview before it is converted into the
    ///      public `ShapeState` representation.
    struct ComposeResult {
        bytes32 seed;
        uint8 denomIndex;
        uint32 originCount;
        uint8 inkGene;
    }

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

    /// @dev The apex denomination (100 ETH) and its origin count, gating `blacken`.
    uint256 private constant APEX_INDEX = 8;
    uint256 private constant APEX_BACKING = 100 ether;
    /// @dev Where sacrificed ETH is sent: an address with no known key. Provably unspendable.
    address private constant UNSPENDABLE = 0x000000000000000000000000000000000000dEaD;

    /* --------------------------- fee and renderer --------------------------- */

    /// @dev Basis-point denominator: `feeBps` of 100 is 1%.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @inheritdoc IShapes
    uint256 public immutable feeBps;
    /// @inheritdoc IShapes
    address public immutable feeRecipient;

    /// @inheritdoc IShapes
    /// @dev Not immutable: the owner may replace it via `setRenderer` to fix a rendering bug,
    ///      until `lockRenderer` freezes it permanently. It is read only by `tokenURI`, so it
    ///      never touches ETH, backing, redemption or ownership.
    address public renderer;

    /// @inheritdoc IShapes
    bool public rendererLocked;

    /// @inheritdoc IShapes
    /// @dev Read only by `contractURI`. Replaceable by the owner until `lockRenderer` freezes
    ///      both presentation pointers.
    address public collection;

    /// @param feeBps_ Mint fee in basis points of the backing, charged on top of it. 100 is 1%.
    ///        May be zero. Above BPS_DENOMINATOR (100%) is rejected.
    /// @param feeRecipient_ Where fees are forwarded. Immutable, and it MUST be able to receive
    ///        ETH: a recipient that reverts on receipt disables minting permanently, leaving the
    ///        contract redeem-only. Prefer an EOA, or a splitter audited for a non-reverting,
    ///        low-gas `receive`.
    /// @param renderer_ The onchain renderer. Replaceable by the owner until locked. An address
    ///        with no renderer code is refused here and by `setRenderer`.
    constructor(uint256 feeBps_, address feeRecipient_, address renderer_, address collection_)
        ERC721("Shapes", "SHAPE")
        Ownable(msg.sender)
    {
        require(feeBps_ <= BPS_DENOMINATOR, "fee exceeds 100%");
        require(feeRecipient_ != address(0), "fee recipient is zero");
        _requireRendererHasCode(renderer_);
        _requireCollectionHasCode(collection_);
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        renderer = renderer_;
        collection = collection_;
    }

    /// @inheritdoc IShapes
    function mintFeeFor(uint256 amountWei) public view returns (uint256) {
        return (amountWei * feeBps) / BPS_DENOMINATOR;
    }

    /// @inheritdoc IShapes
    /// @dev Owner only, and only while unlocked. The new renderer must carry code.
    function setRenderer(address newRenderer) external onlyOwner {
        if (rendererLocked) revert RendererIsLocked();
        _requireRendererHasCode(newRenderer);
        renderer = newRenderer;
        emit RendererUpdated(newRenderer);
        // A new renderer changes `tokenURI` for every existing token; ERC-4906 signals the refresh.
        if (totalMinted != 0) emit BatchMetadataUpdate(1, totalMinted);
    }

    /// @inheritdoc IShapes
    /// @dev Owner only, one way. After this the renderer can never change again.
    function lockRenderer() external onlyOwner {
        if (rendererLocked) revert RendererIsLocked();
        rendererLocked = true;
        emit RendererLocked();
    }

    /// @inheritdoc IShapes
    /// @dev Owner only, and only while unlocked. The new collection must carry code.
    function setCollection(address newCollection) external onlyOwner {
        if (rendererLocked) revert RendererIsLocked();
        _requireCollectionHasCode(newCollection);
        collection = newCollection;
        emit CollectionUpdated(newCollection);
    }

    /// @dev Applied at construction and on every replacement. Metadata has no fallback path.
    function _requireRendererHasCode(address renderer_) private view {
        require(renderer_ != address(0), "renderer is zero");
        require(renderer_.code.length != 0, "renderer has no code");
        try IERC165(renderer_).supportsInterface(type(IShapeRenderer).interfaceId) returns (bool supported) {
            if (!supported) revert UnsupportedRenderer(renderer_);
        } catch {
            revert UnsupportedRenderer(renderer_);
        }
    }

    /// @dev Applied at construction and on every replacement. `contractURI` has no fallback path.
    function _requireCollectionHasCode(address collection_) private view {
        if (collection_.code.length == 0) revert UnsupportedCollection(collection_);
        try IERC165(collection_).supportsInterface(type(IShapeCollection).interfaceId) returns (
            bool supported
        ) {
            if (!supported) revert UnsupportedCollection(collection_);
        } catch {
            revert UnsupportedCollection(collection_);
        }
    }

    /* ------------------------------ minting ----------------------------- */

    /// @inheritdoc IShapes
    function mint(uint256 amountWei, address to) external payable nonReentrant returns (uint256 tokenId) {
        return _mintBatch(amountWei, 1, to);
    }

    /// @inheritdoc IShapes
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
        if (quantity == 0) revert ZeroQuantity();

        uint256 denomIndex;
        {
            bool ok;
            (denomIndex, ok) = Denominations.indexOf(amountWei);
            if (!ok) revert UnsupportedDenomination(amountWei);
        }

        uint256 backing = amountWei * quantity;
        // Fee is a percentage of each token's backing. Computed per token, then scaled, so the
        // aggregate matches quantity independent mints exactly. Exact in wei at every
        // denomination for the committed 1% (each denomination is a whole number of finney).
        uint256 fees = mintFeeFor(amountWei) * quantity;
        if (msg.value != backing + fees) revert IncorrectPayment(backing + fees, msg.value);

        firstTokenId = totalMinted + 1;

        // One entropy root per batch; each token's seed derives from it and its own id, so every
        // token in a batch gets a distinct seed.
        //
        // No caller-controlled value feeds this root, which would otherwise let a minter
        // enumerate candidates off chain until the artwork suited them. The residual is grinding
        // through a contract that reverts on an unwanted outcome: one attempt per block, gas per
        // attempt (SPEC.md D3e).
        bytes32 batchRoot = keccak256(
            abi.encodePacked(
                block.prevrandao,
                blockhash(block.number - 1),
                block.number,
                block.timestamp,
                block.chainid,
                address(this),
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
            (bool sent,) = feeRecipient.call{value: fees}("");
            if (!sent) revert MintFeeTransferFailed(feeRecipient, fees);
            emit MintFeePaid(feeRecipient, fees, quantity);
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
        _redeemTo(tokenId, payable(msg.sender));
    }

    /// @inheritdoc IShapes
    function redeemBatch(uint256[] calldata tokenIds) external nonReentrant returns (uint256 totalWei) {
        return _redeemBatchTo(tokenIds, payable(msg.sender));
    }

    /// @inheritdoc IShapes
    function redeemTo(uint256 tokenId, address payable recipient) external nonReentrant {
        _redeemTo(tokenId, recipient);
    }

    /// @inheritdoc IShapes
    function redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        external
        nonReentrant
        returns (uint256 totalWei)
    {
        return _redeemBatchTo(tokenIds, recipient);
    }

    function _redeemTo(uint256 tokenId, address payable recipient) private {
        if (recipient == address(0)) revert InvalidRecipient(recipient); // never burn the payout
        (uint256 amountWei, uint256 originCount) = _burnForRedemption(tokenId);

        totalSupply -= 1;
        redeemableBacking -= amountWei;

        emit ShapeRedeemed(tokenId, recipient, amountWei, originCount);
        _payRedemption(recipient, amountWei);
    }

    function _redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)
        private
        returns (uint256 totalWei)
    {
        if (recipient == address(0)) revert InvalidRecipient(recipient); // never burn the payout
        uint256 n = tokenIds.length;
        if (n == 0) revert ZeroQuantity();

        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = tokenIds[i];
            (uint256 amountWei, uint256 originCount) = _burnForRedemption(tokenId);
            totalWei += amountWei;
            emit ShapeRedeemed(tokenId, recipient, amountWei, originCount);
        }

        totalSupply -= n;
        redeemableBacking -= totalWei;

        _payRedemption(recipient, totalWei);
    }

    /// @dev Checks and effects for a single redemption: ownership, read the backing and origin
    ///      count, clear the token state, burn. The origin count is returned so redemption events
    ///      carry it, letting an event-only indexer track global origin conservation without a
    ///      pre-burn state read. A duplicate id in a batch fails here on its second appearance,
    ///      because the token no longer exists.
    function _burnForRedemption(uint256 tokenId) private returns (uint256 amountWei, uint256 originCount) {
        address owner = _requireOwned(tokenId);
        if (owner != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        ShapeData storage d = _shapes[tokenId];
        if (d.isBlack) revert TokenIsBlack(tokenId);

        amountWei = Denominations.amountAt(d.denomIndex);
        originCount = d.originCount;

        delete _shapes[tokenId];
        _burn(tokenId);
    }

    /// @dev The redemption payout. Reached only after the corresponding tokens are burned and the
    ///      accounting is updated. A failed transfer reverts the whole redemption. `blacken` is the
    ///      only other path that sends reserve ETH out, at a fixed amount to a fixed address.
    function _payRedemption(address to, uint256 amountWei) private {
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
        if (n == 0) revert ZeroQuantity();
        outIds = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            outIds[i] = _compose(calls[i].survivorId, calls[i].burnIds);
        }
    }

    function _compose(uint256 survivorId, uint256[] calldata burnIds) private returns (uint256) {
        uint256 n = burnIds.length;
        if (n == 0) revert EmptyRecomposition();

        if (ownerOf(survivorId) != msg.sender) revert NotShapeOwner(survivorId, msg.sender);
        ShapeData storage s = _shapes[survivorId];
        if (s.isBlack) revert TokenIsBlack(survivorId);

        uint256 total = Denominations.amountAt(s.denomIndex);
        uint256 origins = s.originCount;

        // Ink gene pool statistics (INK_GENES_IMPL_SPEC.md §2.3, §3.3), accumulated over
        // {survivor + burns} as the loop runs. `oldIndex` and the survivor's own contribution
        // are captured before the loop so they are unaffected by what gets burned inside it.
        uint8 oldIndex = s.denomIndex;
        uint256 survivorUnits = Denominations.unitsAt(s.denomIndex);
        uint8 best = s.inkGene;
        uint8 worst = s.inkGene;
        uint256 sumW = uint256(s.inkGene) * survivorUnits;
        uint256 unitsTotal = survivorUnits;
        uint256 burnSeedFold;

        // Push the reversible record and capture the survivor's pre-compose state before the
        // loop mutates anything. `decompose` pops this to restore exactly these values.
        ComposeRecord storage rec = _composeStack[survivorId].push();
        rec.survivorDenomIndex = oldIndex;
        rec.survivorOriginCount = uint32(s.originCount);
        rec.survivorInkGene = s.inkGene;

        for (uint256 i = 0; i < n; ++i) {
            uint256 burnId = burnIds[i];
            if (burnId == survivorId) revert CannotComposeWithSelf(burnId);
            if (ownerOf(burnId) != msg.sender) revert NotShapeOwner(burnId, msg.sender);
            ShapeData storage b = _shapes[burnId];
            if (b.isBlack) revert TokenIsBlack(burnId);

            total += Denominations.amountAt(b.denomIndex);
            origins += b.originCount;

            // Fold order-invariantly (XOR), so burnIds calldata order cannot affect the gene.
            burnSeedFold ^= uint256(b.seed);
            if (b.inkGene > best) best = b.inkGene;
            if (b.inkGene < worst) worst = b.inkGene;
            uint256 bUnits = Denominations.unitsAt(b.denomIndex);
            sumW += uint256(b.inkGene) * bUnits;
            unitsTotal += bUnits;

            // Snapshot the input verbatim, then burn it. Re-minted by `decompose` under this id.
            rec.inputs.push(ComposeInput({
                seed: b.seed,
                id: uint96(burnId),
                originCount: b.originCount,
                denomIndex: b.denomIndex,
                inkGene: b.inkGene
            }));

            delete _shapes[burnId];
            _burn(burnId);
            emit ShapeAbsorbed(survivorId, burnId);
        }

        // The summed backing must land on a denomination, or the composition is rejected.
        uint256 newIndex = Denominations.requireIndexOf(total);

        uint8 centerGene = InkGenes.center(sumW, unitsTotal);
        uint8 newGene = InkGenes.geneAtCompose(
            s.seed, burnSeedFold, s.inkGene, oldIndex, uint8(newIndex), best, worst, centerGene
        );

        totalSupply -= n;
        s.denomIndex = uint8(newIndex);
        s.originCount = uint32(origins); // <= total/UNIT <= 10000 by the capacity invariant
        s.inkGene = newGene;

        emit Composed(survivorId, burnIds, uint8(newIndex), uint32(origins));
        emit InkGene(survivorId, newGene);
        emit MetadataUpdate(survivorId);
        return survivorId;
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

    function _splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
        private
        returns (uint256[] memory newIds)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert EmptyRecomposition();

        if (ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        ShapeData storage p = _shapes[tokenId];
        if (p.isBlack) revert TokenIsBlack(tokenId);

        uint256 parentBacking = Denominations.amountAt(p.denomIndex);
        bytes32 parentSeed = p.seed;
        uint256 remaining = p.originCount;
        uint8 parentGene = p.inkGene;

        uint256 sum;
        for (uint256 i = 0; i < k; ++i) {
            sum += Denominations.amountAt(outDenoms[i]);
        }
        if (sum != parentBacking) revert SplitMismatch(parentBacking, sum);

        // -------- effects --------
        delete _shapes[tokenId];
        _burn(tokenId);

        uint256 firstId = totalMinted + 1;
        totalMinted = firstId + k - 1;
        totalSupply += k - 1; // burned one, minting k

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
                seed: _childSeed(parentSeed, i),
                denomIndex: outDenoms[i],
                originCount: uint32(give),
                isBlack: false,
                inkGene: parentGene
            });
        }
        // Sum of capacities == parentBacking/UNIT >= parent origin count, so the fill exhausts it.
        assert(remaining == 0);

        emit Split(tokenId, parentSeed, newIds, outDenoms, oc);
        for (uint256 i = 0; i < k; ++i) {
            emit InkGene(newIds[i], parentGene);
            emit ShapeFragmentCreated(tokenId, newIds[i], parentSeed, i);
        }

        // -------- interactions --------
        for (uint256 i = 0; i < k; ++i) {
            _safeMint(recipient, newIds[i]);
        }
    }

    /// @inheritdoc IShapes
    /// @dev The inverse of `compose`. Pops the survivor's top compose record and reverses that one
    ///      merge: the survivor reverts to its pre-compose denomination, origin count and gene (its
    ///      id and seed never changed), and every burned input is re-minted verbatim under its
    ///      original id and seed. `totalMinted` is not bumped — the input ids are reused, not freshly
    ///      issued, which is collision-free because fresh mints always exceed `totalMinted` and an id
    ///      belongs to at most one live record (DECOMPOSE_SPEC.md). LIFO: stacked composes on one
    ///      survivor unwind newest first. Backing is conserved, so `redeemableBacking` is untouched.
    ///      All accounting precedes the `_safeMint` loop so a receiver callback observes consistent
    ///      state.
    function decompose(uint256 survivorId)
        external
        nonReentrant
        returns (uint256[] memory restoredIds)
    {
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
        if (n == 0) revert ZeroQuantity();
        restoredIds = new uint256[][](n);
        for (uint256 i = 0; i < n; ++i) {
            restoredIds[i] = _decomposeTo(survivorIds[i], recipient);
        }
    }

    function _decomposeTo(uint256 survivorId, address recipient)
        private
        returns (uint256[] memory restoredIds)
    {
        if (ownerOf(survivorId) != msg.sender) revert NotShapeOwner(survivorId, msg.sender);
        ShapeData storage s = _shapes[survivorId];
        if (s.isBlack) revert TokenIsBlack(survivorId);

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
            restoredIds[i] = iid;
            genes[i] = inp.inkGene;
        }

        totalSupply += m; // compose burned m inputs; decompose re-mints them, survivor stays
        stack.pop(); // clears the record and its inputs array

        emit Decomposed(survivorId, restoredIds, s.denomIndex, s.originCount);
        emit InkGene(survivorId, s.inkGene);
        for (uint256 i = 0; i < m; ++i) {
            emit InkGene(restoredIds[i], genes[i]);
            emit ShapeRevived(survivorId, restoredIds[i]);
        }
        emit MetadataUpdate(survivorId);

        // -------- interactions --------
        for (uint256 i = 0; i < m; ++i) {
            _safeMint(recipient, restoredIds[i]);
        }
    }

    /// @inheritdoc IShapes
    /// @dev Sends a fixed 100 ETH to a fixed unspendable address, moving the backing out of
    ///      `redeemableBacking` into `sacrificedBacking`. CEI: the token is marked Black before
    ///      the transfer, which is last.
    function blacken(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
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
        emit MetadataUpdate(tokenId);

        // -------- interactions --------
        (bool sent,) = UNSPENDABLE.call{value: APEX_BACKING}("");
        if (!sent) revert EthTransferFailed(UNSPENDABLE, APEX_BACKING);
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

    function _shapeState(bytes32 seed, uint8 denomIndex, uint32 originCount, uint8 inkGene, bool black)
        private
        pure
        returns (ShapeState memory state)
    {
        uint256 faceValue = Denominations.amountAt(denomIndex);
        state = ShapeState({
            seed: seed,
            denominationIndex: denomIndex,
            originCount: originCount,
            inkGene: inkGene,
            isBlack: black,
            formation: _formation(denomIndex, originCount, black),
            faceValueWei: faceValue,
            redeemableValueWei: black ? 0 : faceValue
        });
    }

    /// @inheritdoc IShapes
    function shapeState(uint256 tokenId) external view returns (ShapeState memory) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return _shapeState(d.seed, d.denomIndex, d.originCount, d.inkGene, d.isBlack);
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

    /// @dev The state `compose` would produce, without caller ownership. Applies compose's
    ///      validation: existence, not-Black, no self-burn, no duplicate burn id, and a summed
    ///      backing that lands on a denomination. Duplicate detection is O(n^2) over calldata.
    function _previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        private
        view
        returns (ComposeResult memory result)
    {
        uint256 n = burnIds.length;
        if (n == 0) revert EmptyRecomposition();

        ownerOf(survivorId); // reverts if the survivor does not exist
        ShapeData storage s = _shapes[survivorId];
        if (s.isBlack) revert TokenIsBlack(survivorId);

        uint256 total = Denominations.amountAt(s.denomIndex);
        uint256 origins = s.originCount;
        uint8 oldIndex = s.denomIndex;
        uint256 survivorUnits = Denominations.unitsAt(s.denomIndex);
        uint8 best = s.inkGene;
        uint8 worst = s.inkGene;
        uint256 sumW = uint256(s.inkGene) * survivorUnits;
        uint256 unitsTotal = survivorUnits;
        uint256 burnSeedFold;

        for (uint256 i = 0; i < n; ++i) {
            uint256 burnId = burnIds[i];
            if (burnId == survivorId) revert CannotComposeWithSelf(burnId);
            for (uint256 j = 0; j < i; ++j) {
                if (burnIds[j] == burnId) revert DuplicateComposeInput(burnId);
            }
            ownerOf(burnId); // reverts if this burn id does not exist
            ShapeData storage b = _shapes[burnId];
            if (b.isBlack) revert TokenIsBlack(burnId);

            total += Denominations.amountAt(b.denomIndex);
            origins += b.originCount;
            burnSeedFold ^= uint256(b.seed);
            if (b.inkGene > best) best = b.inkGene;
            if (b.inkGene < worst) worst = b.inkGene;
            uint256 bUnits = Denominations.unitsAt(b.denomIndex);
            sumW += uint256(b.inkGene) * bUnits;
            unitsTotal += bUnits;
        }

        uint8 newDenomIndex = uint8(Denominations.requireIndexOf(total));
        uint8 centerGene = InkGenes.center(sumW, unitsTotal);
        uint8 newGene = InkGenes.geneAtCompose(
            s.seed, burnSeedFold, s.inkGene, oldIndex, newDenomIndex, best, worst, centerGene
        );
        result = ComposeResult({
            seed: s.seed, denomIndex: newDenomIndex, originCount: uint32(origins), inkGene: newGene
        });
    }

    /// @inheritdoc IShapes
    function previewCompose(uint256 survivorId, uint256[] calldata burnIds)
        external
        view
        returns (ShapeState memory result)
    {
        ComposeResult memory p = _previewCompose(survivorId, burnIds);
        return _shapeState(p.seed, p.denomIndex, p.originCount, p.inkGene, false);
    }

    /// @inheritdoc IShapes
    function previewSplit(uint256 tokenId, uint8[] calldata outDenoms)
        external
        view
        returns (ShapeChildPreview[] memory children)
    {
        uint256 k = outDenoms.length;
        if (k < 2) revert EmptyRecomposition();

        _requireOwned(tokenId);
        ShapeData storage p = _shapes[tokenId];
        if (p.isBlack) revert TokenIsBlack(tokenId);

        uint256 parentBacking = Denominations.amountAt(p.denomIndex);
        uint256 sum;
        for (uint256 i = 0; i < k; ++i) {
            sum += Denominations.amountAt(outDenoms[i]);
        }
        if (sum != parentBacking) revert SplitMismatch(parentBacking, sum);

        children = new ShapeChildPreview[](k);
        uint256 remaining = p.originCount;
        for (uint256 i = 0; i < k; ++i) {
            uint256 cap = Denominations.unitsAt(outDenoms[i]);
            uint256 give = remaining < cap ? remaining : cap;
            remaining -= give;
            children[i] = ShapeChildPreview({
                seed: _childSeed(p.seed, i),
                denominationIndex: outDenoms[i],
                originCount: uint32(give),
                inkGene: p.inkGene,
                faceValueWei: Denominations.amountAt(outDenoms[i])
            });
        }
        assert(remaining == 0);
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

    function _childSeed(bytes32 parentSeed, uint256 childIndex) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentSeed, childIndex));
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

    /// @inheritdoc IShapes
    function isSupportedDenomination(uint256 amountWei) external pure returns (bool) {
        return Denominations.isSupported(amountWei);
    }

    /// @inheritdoc IShapes
    function gridForAmount(uint256 amountWei) external pure returns (uint256 cols, uint256 rows) {
        return Denominations.gridAt(Denominations.requireIndexOf(amountWei));
    }

    /// @inheritdoc IShapes
    function modulesForAmount(uint256 amountWei) external pure returns (uint256) {
        (uint256 cols, uint256 rows) = Denominations.gridAt(Denominations.requireIndexOf(amountWei));
        return cols * rows;
    }

    /// @notice EIP-2981 royalty, permanently zero.
    /// @dev Declared rather than omitted so a marketplace reading the standard is told the rate
    ///      instead of falling back to its own default.
    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        return (address(0), 0);
    }

    /// @inheritdoc IShapes
    function contractURI() external view returns (string memory) {
        return IShapeCollection(collection).contractURI();
    }

    /// @inheritdoc IShapes
    function unicodeCard(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return IShapeRenderer(renderer).renderUnicode(d.seed, Denominations.amountAt(d.denomIndex), d.inkGene);
    }

    /// @notice Fully onchain metadata. Base64 JSON containing a base64 SVG.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return IShapeRenderer(renderer)
            .tokenURI(
                d.seed,
                Denominations.amountAt(d.denomIndex),
                tokenId,
                d.originCount,
                d.isBlack,
                d.inkGene,
                _composeStack[tokenId].length
            );
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
        return interfaceId == type(IShapes).interfaceId || interfaceId == type(IShapeValue).interfaceId
            || interfaceId == type(IShapeRecomposition).interfaceId
            || interfaceId == type(IShapeProvenance).interfaceId
            || interfaceId == type(IShapeSimulation).interfaceId
            || interfaceId == type(IERC2981).interfaceId
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

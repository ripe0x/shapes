// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IShapes} from "./interfaces/IShapes.sol";
import {IShapeRenderer} from "./interfaces/IShapeRenderer.sol";
import {Denominations} from "./lib/Denominations.sol";

/// @title Shapes
/// @notice ETH in, Shape out. Shape burned, the same ETH out.
///
/// @dev A Shape wraps an exact amount of ETH at one of nine fixed denominations. Whoever owns
///      the token owns the right to unwrap its ETH. The token is otherwise an ordinary
///      transferable ERC721.
///
///      The contract does not lend, stake, invest or otherwise use the ETH it holds. There is
///      exactly one code path that moves ETH out of the reserve — `_settle`, reached only from
///      `redeem` and `redeemBatch` — and it burns the corresponding token first.
///
///      The one administrative power is cosmetic: the owner may replace the renderer, and may
///      permanently lock it. The renderer is read only by `tokenURI`; it can never touch ETH,
///      backing, redemption or ownership. So the owner can change how a Shape looks, never what
///      it is worth or who controls it, and once `lockRenderer` is called even that ends. The
///      owner may renounce ownership at any time.
///
///      Deliberately absent: pause, emergency withdrawal, treasury, asset recovery, backing
///      modification, token seizure, mint-fee or fee-recipient change, upgradeability, proxy,
///      allowlist, supply cap, royalties. No admin path reaches the reserve.
///
///      Reentrancy: the four functions that move ETH or mint — `mint`, `mintBatch`, `redeem`,
///      `redeemBatch` — are guarded. The inherited ERC721 transfer and approval functions are
///      not, and deliberately so; they move no ETH. One consequence worth knowing: a receiver
///      can redeem a Shape from inside its own `onERC721Received` during a `safeTransferFrom`.
///      Accounting stays exact, but an integrator that assumes the token still exists after a
///      safe transfer can be griefed into reverting.
///
///      Reserve invariant: `address(this).balance >= redeemableBacking()` always holds. Equality
///      holds in normal operation. Ethereum can force ETH into any address through mechanisms
///      outside `receive`, so the invariant is stated as an inequality; any such surplus is
///      permanently inaccessible, which is strictly preferable to opening a withdrawal path
///      that could reach the reserve.
contract Shapes is ERC721, ReentrancyGuard, Ownable, IShapes, IERC4906 {
    /* ------------------------------ state ------------------------------ */

    /// @dev Per token: a visual seed, a denomination index, a provenance credit and a terminal
    ///      flag. Storing the index rather than a wei amount makes an out-of-ladder backing value
    ///      unrepresentable. `originCount` is the count of independent direct-mint events credited
    ///      to this token (one per mint, conserved across composition and decomposition).
    ///      `isBlack` marks a sacrificed token. The last three pack into one slot.
    struct ShapeData {
        bytes32 seed;
        uint8 denomIndex;
        uint32 originCount;
        bool isBlack;
    }

    mapping(uint256 tokenId => ShapeData) private _shapes;

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
    address private constant BURN = 0x000000000000000000000000000000000000dEaD;

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

    /// @param feeBps_ Mint fee in basis points of the backing, charged on top of it. 100 is 1%.
    ///        May be zero. A fee above BPS_DENOMINATOR (100%) is rejected; the fee never enters
    ///        backing and redemption is unaffected regardless, but a fee exceeding the backing
    ///        itself is a deployment mistake, not a design.
    /// @param feeRecipient_ Where fees are forwarded. It MUST be able to receive ETH.
    ///        This is the single most consequential constructor argument: because it is
    ///        immutable, a recipient that reverts on receipt — or that later starts
    ///        reverting — disables minting permanently, with no recovery. Redemption is
    ///        unaffected and the reserve is never at risk, but the contract becomes
    ///        redeem-only. Prefer an EOA, or a splitter audited for a non-reverting,
    ///        low-gas `receive`. Do not pass a contract whose payable path can be disabled.
    /// @param renderer_ The onchain renderer. Replaceable by the owner until locked, so a
    ///        rendering bug is recoverable; an address with no renderer code is refused here and
    ///        by `setRenderer`, so `tokenURI` can never be pointed at a codeless address.
    constructor(uint256 feeBps_, address feeRecipient_, address renderer_)
        ERC721("Shapes", "SHAPE")
        Ownable(msg.sender)
    {
        require(feeBps_ <= BPS_DENOMINATOR, "fee exceeds 100%");
        require(feeRecipient_ != address(0), "fee recipient is zero");
        _requireRendererHasCode(renderer_);
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        renderer = renderer_;
    }

    /// @inheritdoc IShapes
    function mintFeeFor(uint256 amountWei) public view returns (uint256) {
        return (amountWei * feeBps) / BPS_DENOMINATOR;
    }

    /// @inheritdoc IShapes
    /// @dev Owner only, and only while unlocked. The new renderer must carry code, so metadata
    ///      cannot be pointed at a codeless address. Purely cosmetic: no token's backing,
    ///      redeemability or owner is affected.
    function setRenderer(address newRenderer) external onlyOwner {
        if (rendererLocked) revert RendererIsLocked();
        _requireRendererHasCode(newRenderer);
        renderer = newRenderer;
        emit RendererUpdated(newRenderer);
    }

    /// @inheritdoc IShapes
    /// @dev Owner only, one way. After this the renderer can never change again, matching the
    ///      original immutable guarantee, and the owner's only remaining power is to renounce.
    function lockRenderer() external onlyOwner {
        if (rendererLocked) revert RendererIsLocked();
        rendererLocked = true;
        emit RendererLocked();
    }

    /// @dev Metadata has no fallback path, so refuse a renderer with no code outright rather
    ///      than discovering it after the fact, at construction and on every replacement.
    function _requireRendererHasCode(address renderer_) private view {
        require(renderer_ != address(0), "renderer is zero");
        require(renderer_.code.length != 0, "renderer has no code");
    }

    /* ------------------------------ minting ----------------------------- */

    /// @inheritdoc IShapes
    function mint(uint256 amountWei, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokenId)
    {
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

        // One entropy root per batch; each token's seed is derived from it and its own id, so
        // every token in a batch gets a distinct seed.
        //
        // Deliberately, NOTHING the caller controls feeds this root — not msg.sender, not the
        // recipient, not the quantity. Including any of them would let a minter enumerate
        // candidate values off chain, for free, until the artwork came out the way they
        // wanted. That matters most at 50 and 100 ETH, where a card is one or two modules and
        // a handful of tries is enough to select any trait combination.
        //
        // What remains is the same construction Art Blocks uses for its own token hashes:
        // pseudorandom, atomic at mint, derived from block data. A determined minter can
        // still grind by minting through a contract that reverts unless the outcome suits
        // them, which costs gas and yields one attempt per block. That residual is accepted
        // and documented (SPEC.md D3e) rather than papered over: the seed has no economic
        // effect, since redemption value is set by denomination alone.
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
            _shapes[tokenId] =
                ShapeData({seed: seed, denomIndex: uint8(denomIndex), originCount: 1, isBlack: false});
            emit ShapeMinted(tokenId, to, amountWei, seed, 1);
        }

        // -------- interactions --------
        // Fees are forwarded immediately and in aggregate; they never join the reserve.
        // Doing this before the mint loop means that by the time any ERC721 receiver callback
        // runs, `address(this).balance` already equals `redeemableBacking` — an integrator reading
        // the reserve from inside a callback sees a consistent figure rather than one
        // inflated by fees still in transit.
        if (fees != 0) {
            (bool sent,) = feeRecipient.call{value: fees}("");
            if (!sent) revert MintFeeTransferFailed(feeRecipient, fees);
            emit MintFeePaid(feeRecipient, fees, quantity);
        }

        // Minting after all storage writes, and behind the reentrancy guard, so a receiver
        // callback cannot corrupt accounting.
        //
        // Note for integrators: during a batch, `totalSupply` and `redeemableBacking` already
        // reflect the whole batch while only some tokens exist. Do not read supply from
        // inside `onERC721Received`; it is a snapshot of the batch's end state, not its
        // progress. Write reentrancy is blocked regardless.
        for (uint256 i = 0; i < quantity; ++i) {
            _safeMint(to, firstTokenId + i);
        }
    }

    /* ---------------------------- redemption ---------------------------- */

    /// @inheritdoc IShapes
    /// @dev Owner only. Approval grants the right to move a Shape, not to unwrap it — though
    ///      note that an approved operator can always transfer a Shape to itself and redeem
    ///      in the same transaction, so approving an operator is economically equivalent to
    ///      granting it redemption rights. The owner-only check narrows nothing in practice;
    ///      it keeps the payout destination unambiguous and the accounting simple.
    function redeem(uint256 tokenId) external nonReentrant {
        uint256 amountWei = _burnForRedemption(tokenId);

        totalSupply -= 1;
        redeemableBacking -= amountWei;

        emit ShapeRedeemed(tokenId, msg.sender, amountWei);
        _settle(msg.sender, amountWei);
    }

    /// @inheritdoc IShapes
    function redeemBatch(uint256[] calldata tokenIds)
        external
        nonReentrant
        returns (uint256 totalWei)
    {
        uint256 n = tokenIds.length;
        if (n == 0) revert ZeroQuantity();

        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = tokenIds[i];
            uint256 amountWei = _burnForRedemption(tokenId);
            totalWei += amountWei;
            emit ShapeRedeemed(tokenId, msg.sender, amountWei);
        }

        totalSupply -= n;
        redeemableBacking -= totalWei;

        _settle(msg.sender, totalWei);
    }

    /// @dev Checks and effects for a single redemption: ownership, read the backing, clear the
    ///      token state, burn. A duplicate id in a batch fails here on its second appearance,
    ///      because the token no longer exists.
    function _burnForRedemption(uint256 tokenId) private returns (uint256 amountWei) {
        address owner = _requireOwned(tokenId);
        if (owner != msg.sender) revert NotShapeOwner(tokenId, msg.sender);
        if (_shapes[tokenId].isBlack) revert TokenIsBlack(tokenId);

        amountWei = Denominations.amountAt(_shapes[tokenId].denomIndex);

        delete _shapes[tokenId];
        _burn(tokenId);
    }

    /// @dev The only path by which ETH leaves this contract. Reached only after the
    ///      corresponding tokens are burned and the accounting is updated. A failed transfer
    ///      reverts the whole redemption.
    function _settle(address to, uint256 amountWei) private {
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
    function compose(uint256 survivorId, uint256[] calldata burnIds)
        external
        nonReentrant
        returns (uint256)
    {
        uint256 n = burnIds.length;
        if (n == 0) revert EmptyRecomposition();

        if (ownerOf(survivorId) != msg.sender) revert NotShapeOwner(survivorId, msg.sender);
        ShapeData storage s = _shapes[survivorId];
        if (s.isBlack) revert TokenIsBlack(survivorId);

        uint256 total = Denominations.amountAt(s.denomIndex);
        uint256 origins = s.originCount;

        for (uint256 i = 0; i < n; ++i) {
            uint256 bid = burnIds[i];
            if (bid == survivorId) revert CannotComposeWithSelf(bid);
            if (ownerOf(bid) != msg.sender) revert NotShapeOwner(bid, msg.sender);
            ShapeData storage b = _shapes[bid];
            if (b.isBlack) revert TokenIsBlack(bid);

            total += Denominations.amountAt(b.denomIndex);
            origins += b.originCount;
            delete _shapes[bid];
            _burn(bid);
        }

        // The summed backing must land on a denomination, or the composition is rejected.
        uint256 newIndex = Denominations.requireIndexOf(total);

        totalSupply -= n;
        s.denomIndex = uint8(newIndex);
        s.originCount = uint32(origins); // <= total/UNIT <= 10000 by the capacity invariant

        emit Composed(survivorId, burnIds, uint8(newIndex), origins);
        emit MetadataUpdate(survivorId);
        return survivorId;
    }

    /// @inheritdoc IShapes
    /// @dev Burns the input and mints fresh outputs whose backing sums to the input's, so
    ///      `redeemableBacking` is untouched. Child seeds derive from the parent seed deterministically,
    ///      fixing the full decompose tree at mint. All accounting precedes the `_safeMint` loop so
    ///      a receiver callback observes consistent state.
    function decompose(uint256 tokenId, uint8[] calldata outDenoms)
        external
        nonReentrant
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

        uint256 sum;
        for (uint256 i = 0; i < k; ++i) sum += Denominations.amountAt(outDenoms[i]);
        if (sum != parentBacking) revert DecompositionMismatch(parentBacking, sum);

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
                seed: keccak256(abi.encodePacked(parentSeed, i)),
                denomIndex: outDenoms[i],
                originCount: uint32(give),
                isBlack: false
            });
        }
        // Sum of capacities == parentBacking/UNIT >= parent origin count, so the fill exhausts it.
        assert(remaining == 0);

        emit Decomposed(tokenId, newIds, outDenoms, oc);

        // -------- interactions --------
        for (uint256 i = 0; i < k; ++i) {
            _safeMint(msg.sender, newIds[i]);
        }
    }

    /* ------------------------------ sacrifice ---------------------------- */

    /// @inheritdoc IShapes
    /// @dev Third and last path that moves ETH out. The amount (100 ETH) and destination (an
    ///      unspendable address) are fixed; unlike redemption the ETH does not return to the
    ///      caller. Moves the backing out of the redeemable reserve into `sacrificedBacking`, so
    ///      the reserve invariant tightens rather than breaks. CEI: the transfer is last and the
    ///      token is already marked Black, so the (unspendable) recipient can observe no callback.
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
        (bool sent,) = BURN.call{value: APEX_BACKING}("");
        if (!sent) revert EthTransferFailed(BURN, APEX_BACKING);
    }

    /* ------------------------------- views ------------------------------ */

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
    function isComplete(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        uint256 units = Denominations.unitsAt(d.denomIndex);
        return !d.isBlack && units > 1 && d.originCount == units;
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

    /// @notice Fully onchain metadata. Base64 JSON containing a base64 SVG.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        ShapeData storage d = _shapes[tokenId];
        return IShapeRenderer(renderer).tokenURI(
            d.seed, Denominations.amountAt(d.denomIndex), tokenId
        );
    }

    /// @dev Refuses to place a Shape in this contract's own custody.
    ///      `Shapes` can never be `msg.sender`, so a token held here could never be redeemed:
    ///      its backing would be stranded while `redeemableBacking` went on counting it. The
    ///      reserve invariant would survive, but the token's redeemability — the whole point
    ///      of the object — would not. `safeTransferFrom` already fails here because the
    ///      receiver check reverts; this closes the plain `transferFrom` path too, and the
    ///      mint path along with it.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        if (to == address(this)) revert SelfCustodyRejected(tokenId);
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, IERC165)
        returns (bool)
    {
        return interfaceId == type(IShapes).interfaceId
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

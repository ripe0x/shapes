// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
///      Deliberately absent: owner, admin, pause, emergency withdrawal, treasury, asset
///      recovery, backing modification, token seizure, metadata or renderer replacement,
///      upgradeability, proxy, allowlist, supply cap, royalties.
///
///      Reentrancy: the four functions that move ETH or mint — `mint`, `mintBatch`, `redeem`,
///      `redeemBatch` — are guarded. The inherited ERC721 transfer and approval functions are
///      not, and deliberately so; they move no ETH. One consequence worth knowing: a receiver
///      can redeem a Shape from inside its own `onERC721Received` during a `safeTransferFrom`.
///      Accounting stays exact, but an integrator that assumes the token still exists after a
///      safe transfer can be griefed into reverting.
///
///      Reserve invariant: `address(this).balance >= totalBacking()` always holds. Equality
///      holds in normal operation. Ethereum can force ETH into any address through mechanisms
///      outside `receive`, so the invariant is stated as an inequality; any such surplus is
///      permanently inaccessible, which is strictly preferable to opening a withdrawal path
///      that could reach the reserve.
contract Shapes is ERC721, ReentrancyGuard, IShapes {
    /* ------------------------------ state ------------------------------ */

    /// @dev Per token, the minimum possible: a visual seed and a denomination index.
    ///      Storing the index rather than a wei amount makes an out-of-ladder backing value
    ///      unrepresentable rather than merely rejected at the boundary.
    struct ShapeData {
        bytes32 seed;
        uint8 denomIndex;
    }

    mapping(uint256 tokenId => ShapeData) private _shapes;

    /// @inheritdoc IShapes
    uint256 public totalBacking;
    /// @inheritdoc IShapes
    uint256 public totalSupply;
    /// @inheritdoc IShapes
    uint256 public totalMinted;

    /* ---------------------------- immutables ---------------------------- */

    /// @inheritdoc IShapes
    uint256 public immutable mintFee;
    /// @inheritdoc IShapes
    address public immutable feeRecipient;
    /// @inheritdoc IShapes
    address public immutable renderer;

    /// @param mintFee_ Fixed fee per NFT minted, charged on top of backing. May be zero.
    /// @param feeRecipient_ Where fees are forwarded. It MUST be able to receive ETH.
    ///        This is the single most consequential constructor argument: because it is
    ///        immutable, a recipient that reverts on receipt — or that later starts
    ///        reverting — disables minting permanently, with no recovery. Redemption is
    ///        unaffected and the reserve is never at risk, but the contract becomes
    ///        redeem-only. Prefer an EOA, or a splitter audited for a non-reverting,
    ///        low-gas `receive`. Do not pass a contract whose payable path can be disabled.
    /// @param renderer_ The onchain renderer. Stored immutably; there is no setter, so an
    ///        address without renderer code would break `tokenURI` for every token forever.
    constructor(uint256 mintFee_, address feeRecipient_, address renderer_)
        ERC721("Shapes", "SHAPE")
    {
        require(feeRecipient_ != address(0), "fee recipient is zero");
        require(renderer_ != address(0), "renderer is zero");
        // A renderer is immutable and metadata has no fallback path, so refuse an address
        // with no code outright rather than discovering it after the first mint.
        require(renderer_.code.length != 0, "renderer has no code");
        mintFee = mintFee_;
        feeRecipient = feeRecipient_;
        renderer = renderer_;
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
        uint256 fees = mintFee * quantity;
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
        totalBacking += backing;

        for (uint256 i = 0; i < quantity; ++i) {
            uint256 tokenId = firstTokenId + i;
            bytes32 seed = keccak256(abi.encodePacked(batchRoot, tokenId));
            _shapes[tokenId] = ShapeData({seed: seed, denomIndex: uint8(denomIndex)});
            emit ShapeMinted(tokenId, to, amountWei, seed);
        }

        // -------- interactions --------
        // Fees are forwarded immediately and in aggregate; they never join the reserve.
        // Doing this before the mint loop means that by the time any ERC721 receiver callback
        // runs, `address(this).balance` already equals `totalBacking` — an integrator reading
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
        // Note for integrators: during a batch, `totalSupply` and `totalBacking` already
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
        totalBacking -= amountWei;

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
        totalBacking -= totalWei;

        _settle(msg.sender, totalWei);
    }

    /// @dev Checks and effects for a single redemption: ownership, read the backing, clear the
    ///      token state, burn. A duplicate id in a batch fails here on its second appearance,
    ///      because the token no longer exists.
    function _burnForRedemption(uint256 tokenId) private returns (uint256 amountWei) {
        address owner = _requireOwned(tokenId);
        if (owner != msg.sender) revert NotShapeOwner(tokenId, msg.sender);

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

    /* ------------------------------- views ------------------------------ */

    /// @inheritdoc IShapes
    function backingOf(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        return Denominations.amountAt(_shapes[tokenId].denomIndex);
    }

    /// @inheritdoc IShapes
    function seedOf(uint256 tokenId) public view returns (bytes32) {
        _requireOwned(tokenId);
        return _shapes[tokenId].seed;
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
    ///      its backing would be stranded while `totalBacking` went on counting it. The
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
        return interfaceId == type(IShapes).interfaceId || super.supportsInterface(interfaceId);
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

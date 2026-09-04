# Minting

Four entrypoints create Shapes. Each one takes a denomination in wei, charges the flat fee per Shape on top, and mints with `_safeMint`.

```solidity
function mint(uint256 amountWei) external payable returns (uint256 tokenId);
function mintTo(uint256 amountWei, address to) external payable returns (uint256 tokenId);
function mintBatch(uint256 amountWei, uint256 quantity) external payable returns (uint256 firstTokenId);
function mintBatchTo(uint256 amountWei, uint256 quantity, address to) external payable returns (uint256 firstTokenId);
```

## Rules

- **Amount.** `amountWei` must be one of the nine denominations, else `UnsupportedDenomination(amountWei)`. Check with `isSupportedDenomination` or use `denominationAt(index)`.
- **Payment.** `msg.value` must equal `quantity * (amountWei + mintFee())` exactly. Over and under both revert `IncorrectPayment(expected, provided)`. Read `mintFee()` in the same transaction or immediately before; the admin can change it up to `unit()`.
- **Timing.** Every entrypoint reverts `MintNotOpen` while `block.timestamp < mintStart()`. Mainnet `mintStart` is `1788462000`.
- **Quantity.** A batch of zero reverts `ZeroQuantity`. There is no upper bound other than gas. A batch of `n` costs the same as `n` single mints.
- **Recipient.** `to` receives the tokens through `onERC721Received`, so a contract recipient must implement `IERC721Receiver`. Minting to the Shapes contract itself reverts `SelfCustodyRejected`. The recipient does not affect the seed.
- **Ids.** A batch takes `quantity` consecutive ids starting at `firstTokenId`, which equals `totalMinted()` before the call. Each token gets a distinct seed derived from the batch root and its id.

## What a mint creates

Each new token has `originCount == 1`, formation `Direct`, a seed, an ink gene derived from the seed and denomination, and no stored modules (its geometry derives from the seed). Its `valueOf` equals `amountWei` from the moment it exists.

## Fees

The fee never enters backing. It is credited to `feeRecipient()` as of the mint, kept outside the reserve, and paid out when anyone calls `withdrawFees(recipient)`. `pendingFees()` is the total owed across recipients; `feesOwedTo(recipient)` is one balance.

## Events

Per mint transaction:

| Event | Count |
| --- | --- |
| `Transfer(address(0), to, tokenId)` | One per token |
| `ShapeMinted(tokenId, to, amountWei, seed, originCount = 1)` | One per token |
| `InkGene(tokenId, gene)` | One per token |
| `MintFeeAccrued(amountWei)` | Once, when the fee is nonzero |

`ShapeMinted` is emitted only by minting. Split children and decompose restores emit their own events; see [Events](/docs/events).

## Example: a contract that mints

```solidity
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IShapesMint {
    function mintFee() external view returns (uint256);
    function mintTo(uint256 amountWei, address to) external payable returns (uint256);
}

contract Vault is IERC721Receiver {
    IShapesMint constant SHAPES = IShapesMint(0x6fe9193276bf7abcbee44ab7afd717d637d6faf0);

    function mintInto(uint256 amountWei) external payable returns (uint256 tokenId) {
        uint256 fee = SHAPES.mintFee();
        require(msg.value == amountWei + fee, "exact payment");
        tokenId = SHAPES.mintTo{value: msg.value}(amountWei, address(this));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
```

The receiver hook runs after Shapes has written the batch's final state, so reading `totalSupply()` or `valueOf(tokenId)` inside it returns the post-mint values.

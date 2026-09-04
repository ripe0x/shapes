# Trust model

What an integrator can rely on, what the admin can change, and what an external call into Shapes can do to your contract.

## The reserve

```
address(this).balance >= redeemableBacking() + pendingFees()
```

Equality holds in normal use; ETH forced in by `selfdestruct` or block rewards is stranded above it. Direct transfers to the contract revert `DirectDepositRejected`. ETH enters only through the mint entrypoints and leaves through exactly three paths:

1. Redemption and `burn`, which pay a destroyed token's backing to its owner or a chosen recipient.
2. `burnBacking`, which sends an apex Shape's 100 ETH to `0x…dEaD`.
3. `withdrawFees(recipient)`, which pays one recipient its own accrued mint fees.

There is no pause, upgrade, proxy, emergency withdrawal, asset recovery, allowlist, supply cap or royalty. `royaltyInfo` is declared and returns zero.

## Roles

| Role | Read | Can |
| --- | --- | --- |
| Token owner | `ownerOf(tokenId)` | Transfer, approve, redeem, burn, compose, decompose, split, burn backing |
| Collection owner | `owner()` | Nothing. Attribution that follows the owner token |
| Admin | `admin()` | Change presentation until locked, set and lock the two pointers, redirect future fees, set the fee within the cap, transfer or renounce the role |
| Artist | `artist()` | Nothing. Attribution of the deployer, plus one EIP-712 attestation |

An approved ERC-721 operator can transfer a Shape but cannot redeem, burn or recompose it; those check `msg.sender == ownerOf`.

## What the admin can change

| Setting | Bound | Freeze |
| --- | --- | --- |
| `renderer()` | Must have code and support `IShapeRenderer` and `IShapeGeometry` | `lockPresentation()` |
| `collection()` and its copy | Must support `IShapeCollection` and report this Shapes from `shapes()` | `lockPresentation()` |
| `positions()` pointer | Zero, or code answering ERC-165 for `IShapePositionResolver` | `lockPointer(0)` |
| `market()` pointer | Zero, or code answering ERC-165 for `IShapeAuctionHouse` | `lockPointer(1)` |
| `mintFee()` | At most `unit()` (0.01 ETH on mainnet) | `renounceAdmin()` |
| `feeRecipient()` | Not zero, not the Shapes address | `renounceAdmin()` |

A renderer change alters how tokens look, not what they are worth. Locking freezes the stored address, not the target's code. Check `presentationLocked()`, `positions().locked` and `market().locked` if your integration depends on a pointer staying put.

## External calls Shapes makes

Shapes calls out in these places. Everything else is internal.

| Call | When | Effect on the caller |
| --- | --- | --- |
| `onERC721Received` on the recipient | Every mint (`_safeMint` to the caller or `to`), every split child, every restored decompose input, and `safeTransferFrom` | Your contract must implement `IERC721Receiver` to receive Shapes from these paths |
| ETH transfer to the redeemer or recipient | `redeem*`, `burn` | A recipient that reverts makes the redemption revert; the token survives |
| ETH transfer to a fee recipient | `withdrawFees` | Only that recipient's withdrawal fails |
| `renderer()`, `collection()` and a new pointer target | Metadata views, plus one ERC-165 probe when the admin sets a pointer | Never on a token state change |
| `positionOf` on the positions target | `positionOf(tokenId)` only, with a 50,000 gas stipend | A revert or bad return yields zero; no state change calls a pointer |

## Reentrancy

The mint, redemption, fee and recomposition entrypoints carry a reentrancy guard. Admin functions, `attestArtist` and the inherited ERC-721 transfer and approval functions do not. State is written before every receiver callback, so a callback sees the finished batch; during `safeTransferFrom` the receiver may redeem the Shape inside its own `onERC721Received`. Do not assume a token still exists after a safe transfer returns.

## Presentation copy

The token name prefix and descriptions live on the collection contract and are validated so they cannot break the metadata JSON. A copy edit is two transactions, `ShapeCollection.setMetadataCopy` then `Shapes.refreshMetadata`, which emits ERC-4906 `BatchMetadataUpdate` and ERC-7572 `ContractURIUpdated` so marketplaces re-read.

## Seeds are not randomness

Seeds derive from the token ordinal and block data and can be searched by minting more tokens at one fee per try. Never use a seed as a random source in your own contract.

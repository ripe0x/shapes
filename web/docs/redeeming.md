# Redeeming

Redemption destroys a Shape and pays exactly its backing. There is no partial redemption and no way to add ETH to an existing Shape.

```solidity
function redeem(uint256 tokenId) external;
function redeemTo(uint256 tokenId, address payable recipient) external;
function redeemBatch(uint256[] calldata tokenIds) external returns (uint256 totalWei);
function redeemBatchTo(uint256[] calldata tokenIds, address payable recipient) external returns (uint256 totalWei);
function burn(uint256 tokenId) external;   // IERC721Value (draft ERC-8060)
```

## Rules

- **Owner only.** `msg.sender` must be `ownerOf(tokenId)`, else `NotShapeOwner(tokenId, caller)`. An approved operator cannot redeem; it must transfer the token to itself first.
- **Payout.** `redeem` and `burn` pay the caller. `redeemTo` and `redeemBatchTo` pay `recipient`, which cannot be zero (`InvalidRecipient`). A batch makes a single transfer of the total after burning every token.
- **Black Shapes.** `redeem*` reverts `TokenIsBlack` for a Black Shape. `burn` accepts one and destroys it with no ETH call. For a normal Shape `burn` and `redeem` are identical.
- **Failure.** If the ETH transfer fails the whole call reverts `EthTransferFailed(to, amountWei)`. The tokens survive. The payout is a plain `call` with all remaining gas, so a contract recipient may run logic in `receive`, under the reentrancy guard.
- **Batches.** An empty array reverts `ZeroQuantity`. A repeated id reverts the second time, because the token no longer exists.
- **Owner token.** Redeeming or burning the owner token ends collection ownership permanently: `owner()` returns zero, `ownerToken()` reverts `NoOwnerToken`, and `OwnerTokenMoved(tokenId, type(uint256).max)` is emitted.

## Accounting

Each redemption lowers `totalSupply` by one and `redeemableBacking` by the payout, before the ETH leaves. The token's state, stored modules and any inert compose records it left behind are cleared or unreachable; its id is never reissued. The ETH is sent last, under the reentrancy guard.

## Events

| Event | When |
| --- | --- |
| `Transfer(owner, address(0), tokenId)` | Every redeemed or burned token |
| `ShapeRedeemed(tokenId, to, amountWei, originCount)` | Every redeemed or burned token; `amountWei` is 0 for a Black Shape |
| `OwnerTokenMoved(tokenId, type(uint256).max)` | When the owner token is destroyed |

`originCount` on `ShapeRedeemed` lets an event-only indexer track the global origin balance without a pre-burn read.

## Reading the payout first

`valueOf(tokenId)` and `backingOf(tokenId)` return the exact wei `redeem` will pay. Both revert for a token that does not exist and return zero for a Black Shape. `exists(tokenId)` never reverts.

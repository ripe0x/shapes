# Building on Shapes

Patterns for a contract that holds, moves or reshapes Shapes, and the hooks Shapes offers to an ecosystem contract.

## Receive Shapes

Every path that gives your contract a Shape uses `_safeMint` or `safeTransferFrom`: `mintTo`, `mintBatchTo`, `splitTo`, `decomposeTo`, and any user transfer. Implement `IERC721Receiver` and return its selector, or the call reverts `ERC721InvalidReceiver`.

```solidity
function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
    external returns (bytes4)
{
    require(msg.sender == address(SHAPES), "not Shapes");
    // Shapes has finished writing state: valueOf(tokenId) and totalSupply() are final here.
    return IERC721Receiver.onERC721Received.selector;
}
```

`operator` is the account that called Shapes; `from` is zero for a mint, split child or decompose restore. The hook may call back into Shapes; the mutating entrypoints carry a reentrancy guard, so a nested mint or redeem inside a mint or decompose reverts, while a redeem inside a plain `safeTransferFrom` succeeds.

## Act on Shapes you hold

`redeem`, `burn`, `compose`, `decompose`, `split` and `burnBacking` check `msg.sender == ownerOf`. Approval is not enough. A contract that manages Shapes for users must hold them itself, or have the user act. A vault that holds a Shape can redeem it and receive the ETH in `receive`, compose it with others it holds, or split it and receive the children.

`redeemTo`, `redeemBatchTo`, `splitTo` and `decomposeTo` let the holder direct the output to another address in one call, so a vault can redeem straight to its user.

## Pick a denomination

Convert user amounts with the ladder reads rather than a local table:

```solidity
uint8 n = SHAPES.denominationCount();          // 9
for (uint8 i = 0; i < n; ++i) {
    if (SHAPES.denominationAt(i) == amountWei) { /* index i */ }
}
```

`isSupportedDenomination(amountWei)` is the yes/no form. To make change, split into indices; to consolidate, compose into a survivor whose summed backing is a denomination.

## Check what a contract is

`supportsInterface` distinguishes the Shapes token from any other ERC-721 and advertises the slices of the surface. A payment contract that only redeems can check `IShapeValue`; a recomposition workflow checks `IShapeRecomposition`. Ids are on [Interfaces](/docs/interfaces).

## Read before you act

`shapeState(tokenId)` gives every fact in one call. `exists(tokenId)` never reverts. `previewCompose` and `previewSplit` show outcomes; simulate the mutating call from the acting account to test ownership. Read `mintFee()` inside the transaction that pays it.

## Positions

Shapes carries an optional **positions** pointer: an address the admin sets and can lock, answering `IShapePositionResolver`:

```solidity
interface IShapePositionResolver {
    function positionOf(uint256 tokenId) external view returns (address);
}
```

`Shapes.positionOf(tokenId)` forwards to it with a 50,000 gas stipend and returns zero on any failure. It is a discovery hook: a way for the canonical positions layer, once one exists, to say where a Shape's external position lives. Shapes never calls the target on a state change and gives it no authority. Read `positions()` for `(target, locked)`; zero target means none is configured. Anyone may build a positions contract; the pointer names the canonical one.

## The market pointer and the auction house

`market()` names the canonical auction house, `ShapeAuctionHouse`, an independent contract with no authority over Shapes. It runs English auctions for any ERC-721 in which bids are sets of Shapes: a bid escrows cards whose backing sums to the bid amount, in 0.01 ETH units, and the house can mint cards from ETH for a bidder. Outbid cards are pulled back by the bidder, the lot by the winner, the winning cards by the seller. The interface is `IShapeAuctionHouse` (`createAuction`, `bid`, `settle`, `claimLot`, `withdraw`, `claimProceeds`, `minimumBid`, `getAuctionFor`, `hasAuctionFor`). Its full NatSpec is on the [Contracts](/contracts) page. The owner token #0 was listed in auction 0 at deployment.

## Presentation contracts

`renderer()` and `collection()` are readable by anyone. A contract can render any card from raw inputs through `IShapeRenderer` and `IShapeGeometry`, and `IShapeCollection.cardFor(seed, denomIndex)` previews a card no token exists for. See [Geometry and rendering](/docs/geometry).

## Before you rely on it

- **Approval is trust.** An approved operator can transfer a Shape to itself and redeem it, so approving a contract for a Shape hands over that Shape's full ETH value. Ask for the minimum approval a flow needs, and expect users to be asked the same.
- **Price by value, not traits.** Artwork, ink gene and provenance carry no redemption value. `redeemableValueWei` is the number.
- **Give value-moving calls gas headroom.** Every state-changing entrypoint runs behind a reentrancy guard whose slot is reset at the end of the call, earning a refund. `eth_estimateGas` reports the amount net of that refund, slightly below what the execution needs mid-flight, so a contract or script that forwards a hard gas limit must add a margin over the bare estimate. Wallets add one automatically.
- **Never accept a Black Shape as payment.** `valueOf` is zero and `isBlack` is true.
- **Artist status is not authority.** `artist()`, `artistSignature()` and `artistReleaseHash()` are attribution. An ERC-1271 attestation was valid when `attestArtist` ran; a later wallet change can make a fresh check fail.

## Things Shapes will not do

- Hold a Shape itself. Minting or transferring to the Shapes address reverts.
- Accept ETH outside a mint. Direct transfers revert.
- Pay royalties. `royaltyInfo` returns zero.
- Call your contract on a state change, other than the ERC-721 receiver hook and the redemption payout.
- Freeze, escrow, wrap or seize a token. Those are for contracts built on top.

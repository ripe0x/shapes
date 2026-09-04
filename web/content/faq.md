# Questions

Everything below is checkable against the deployed contracts. Developers should read the [docs](/docs).

## Basics

### What is a Shape?

A Shape is an ERC-721 token that holds an exact amount of ETH. There are nine amounts: 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50 and 100 ETH. Whoever holds a Shape can burn it and receive exactly that ETH. Its artwork and metadata are generated entirely onchain from the token's own seed.

### Is a Shape an investment?

No. Wrapping ETH in a Shape earns nothing. The contract does not lend, stake or invest the ETH, and it makes no promise about what a Shape is worth to anyone else. It guarantees one thing: burn the token, receive the ETH.

### Can I lose money on a Shape?

Redemption always returns the exact backing, so the ETH inside a Shape cannot shrink. Two things sit outside that. The 0.001 ETH mint fee is spent at mint and is not part of the backing, and what a buyer will pay for a Shape on the open market is a market question the contract has no view on.

## Value and redemption

### How much ETH does a Shape hold?

One of the nine denominations, and never anything in between. `valueOf(tokenId)` returns the exact wei the current owner receives by redeeming it. The value comes from the denomination alone, so every 1 ETH Shape redeems for exactly 1 ETH whatever it looks like.

### What happens when I redeem?

The token is burned and its exact backing is paid to you in the same transaction. Not a share of a pool, not an appraisal, the same wei. `redeemTo` pays a different address, and `redeemBatch` burns several tokens and makes one transfer of the total. See [Redeeming](/docs/redeeming).

### Who can redeem a Shape?

Only the current owner. An approved operator can transfer a Shape but cannot redeem it, though it can always transfer the token to itself first and redeem it then. Redemption rights follow the token, so a previous owner has none.

### Is there a fee to redeem, transfer or sell?

No. The mint fee is the only fee the protocol charges. There is no burn fee, no transfer fee and no recurring protocol fee, and `royaltyInfo` returns zero.

### Can the contract run out of ETH?

The contract holds at least what it owes, always: `address(this).balance >= redeemableBacking() + pendingFees()`. Every wei counted by `redeemableBacking()` belongs to one live Shape. The rule is asserted as a stateful invariant over fuzzed sequences of every operation, including hostile counterparties that reject ETH or reenter.

### Can anyone take the ETH out of the contract?

There is no emergency withdrawal, no treasury withdrawal, no redemption pause, no token seizure and no upgrade path. ETH leaves by exactly three routes: a redemption or burn paying a destroyed token's backing to its owner, the fixed 100 ETH `burnBacking` send to `0x…dEaD`, and a fee recipient withdrawing its own accrued mint fees. No administrative function reaches any of them. See [Trust model](/docs/trust-model).

### Can I add ETH to a Shape, or take out part of it?

No. Redemption is all or nothing, and there is no way to top up an existing Shape. Backing moves between Shapes only through compose, decompose and split, which never change the total.

### What is a Black Shape?

A Black Shape is a 100 ETH Shape whose backing was deliberately destroyed. Only the owner of a Complete 100 ETH Shape, one assembled from all 10000 direct mints, can call `burnBacking`, which sends exactly 100 ETH to `0x…dEaD` and marks the token Black. It keeps its id, owner, seed and geometry, renders inverted, stays transferable, and can be burned for zero. It cannot be redeemed, composed, split or made Black again, and there is no reverse. See [Black Shapes](/docs/black-shapes).

## Minting

### What does it cost to mint?

The backing you choose plus a flat 0.001 ETH fee for each Shape created. A 1 ETH Shape costs 1.001 ETH and redeems for exactly 1 ETH. The payment must be exact: over and under both revert.

### Where does the mint fee go?

To the fee recipient set at deployment, the Splits wallet `0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72`. Fees are credited outside the reserve and never join any token's backing. Anyone can call `withdrawFees(recipient)` to forward a recipient's own balance to it.

### Can the mint fee change?

Yes, within a bound. The admin can call `setMintFee` up to a compile-time cap of one denomination unit, which is 0.01 ETH on mainnet, and can redirect where future fees accrue. Neither touches backing, redemption or fees already credited. Read `mintFee()` in the transaction that pays it.

### When did minting open, and does it close?

Minting opened at the immutable `mintStart` timestamp, `1788462000`, which is 3 September 2026 at 15:00 ET. No admin path can read or change it. There is no close, no supply cap and no allowlist.

### Can I choose what my Shape looks like?

There is no picker. Each token's seed derives from block data and the token's own mint ordinal, and not from who mints it or who receives it. A determined minter can still search for a seed by advancing the ordinal within one transaction, at roughly the mint fee per attempt. This is documented and accepted rather than fixed, because the seed has no economic effect: value comes from the denomination alone.

### Can I mint several at once, or to another address?

`mintBatch` mints many in one transaction, each with its own id and its own seed, for the same total as the equivalent single mints. `mintTo` and `mintBatchTo` send the Shapes to another address. A contract recipient must implement `onERC721Received`. See [Minting](/docs/minting).

## Composing, decomposing and splitting

### What does composing do?

`compose` merges several Shapes you own into one survivor of your choosing. The survivor keeps its id and its seed and becomes the summed denomination; the other inputs are consumed. The sum has to land on the ladder, so five 0.01 make a 0.05 and ten 0.1 make a 1. See [Composing](/docs/composing).

### What does decomposing do?

`decompose` reverses a survivor's most recent compose exactly. Every consumed input comes back under its original id, seed and state, and the survivor returns to what it was. Composes stack, so reversing two of them takes two calls, newest first. See [Decomposing](/docs/decomposing).

### What does splitting do?

`split` burns one Shape and mints fresh Shapes whose backing sums exactly to it. A 1 ETH Shape can become two 0.5, or ten 0.1, or a hundred 0.01. A split is final, though the children can be composed back into a new survivor. Each child records the parent it came from. See [Splitting](/docs/splitting).

### Do any of these move ETH or charge a fee?

No. Compose, decompose and split rearrange which token holds which backing and never move ETH out of the contract, never change the total backing, and charge no fee. You pay gas and nothing else.

### What are origins, and what is a Complete Shape?

An origin is one direct mint. Every minted Shape carries one, compose sums them onto the survivor, decompose hands them back and split distributes them. A Shape is Complete when it carries one origin for every 0.01 ETH it holds, so a 1 ETH Complete Shape was built from 100 separate mints. Complete is what the 100 ETH apex needs before `burnBacking` will accept it.

### What is the owner token?

Exactly one live Shape carries collection ownership, and `owner()` returns whoever holds it. It started as Shape #0 and is otherwise ordinary: composing it moves ownership to the survivor, decomposing returns it, splitting gives it to the first child. Redeeming or burning it ends collection ownership permanently, and no other token inherits. Holding it grants no administrative rights.

## The art

### Where does the artwork live?

Onchain, in full. `tokenURI` returns a data URI whose image is an SVG the renderer draws at call time from the token's stored state. There is no IPFS, no external image, no font file and no server, so nothing about a Shape can rot or be withheld.

### Why does a bigger Shape have fewer marks?

The grid contracts as the denomination rises. A 0.01 ETH Shape fills a 5 × 5 grid with 25 marks; 1 ETH is 3 × 3; 100 ETH is a single mark alone on a black field. Nothing is added to compensate for the space. See [Geometry and rendering](/docs/geometry).

### What decides how a Shape looks?

The denomination sets the grid, and the seed decides which of ten primitives lands in each cell, whether it is drawn solid or outlined, and how it is rotated. One size and one stroke weight are drawn per card and shared by every mark on it, so a card reads as a single decision.

### What is the ink gene?

A seven-state property, `Void` through `Solid`, that sets the probability each mark on the card is drawn solid rather than outlined. It is assigned at mint, moves toward the pooled inputs on a compose, is restored by a decompose and is copied to every split child. The `Ink` trait reports the gene; the `Fill` trait reports how the card actually painted.

### Can a Shape's artwork change after it is minted?

The seed and the denomination are fixed at mint, and the renderer is deterministic for the same inputs. Two things can still change the picture. Compose and split write sampled marks onto the token, which is the point of them. And the admin can replace the renderer, which redraws every token, until `lockPresentation()` freezes it permanently; `presentationLocked()` reports whether that has happened.

## Ownership and trust

### Who controls Shapes?

Three roles, none of which can reach the ETH. The admin configures presentation, two optional pointers and the mint fee within its cap, and can transfer or renounce the role. The artist is the deployer, recorded permanently as attribution and nothing else. The owner token is the public ownership signal, also attribution only. See [Trust model](/docs/trust-model).

### What can the admin not do?

It cannot move ETH, change any token's backing, pause or block redemption, seize a token, change `mintStart`, mint, or take fees already credited to someone else. The reserve, the denominations and the redemption path have no admin access at all.

### Can the contract be upgraded or paused?

No. There is no proxy and no upgrade path. The linked libraries are baked into the bytecode at deploy time with no setter, so their logic cannot be redirected either. There is no pause of any kind.

### Are there royalties?

No. Shapes declares ERC-2981 and `royaltyInfo` returns zero, so no marketplace is asked for a fee on a sale.

### Has Shapes been audited?

An independent adversarial review was run against the contracts with a mandate to build working exploits, and an independent AI auditor ran a second pass. No path was found that removes redeemable ETH without burning the corresponding token for its exact value. No Critical or High finding was reported; the findings that were made are fixed and pinned with regression tests. That review states plainly that it is not a substitute for a professional audit, and no professional audit was commissioned. Every finding, and the risks accepted deliberately, are written up in `SECURITY.md` in the repository.

## The auction house

### What is the Shape auction house?

A separate contract that runs English auctions for any ERC-721, where bids are made of Shapes. It has no authority over Shapes and Shapes has no knowledge of it, beyond naming it as the canonical market pointer. Anyone can build an alternative.

### How does a bid made of Shapes work?

A bid escrows cards whose backing sums to the bid, counted in 0.01 ETH units, and a bidder can pay ETH instead, which the house mints into the smallest set of cards for that amount at one mint fee per card. The clock starts at the first bid rather than at listing, and a bid placed near the end pushes the end out. Nothing is pushed: losing bidders pull their cards back, the winner pulls the lot, the seller pulls the winning cards.

### What is auction 0?

The owner token, Shape #0, listed in the auction house at deployment. Whoever wins it becomes the collection owner in the `owner()` sense, with no administrative rights attached.

## Technical

### Where are the contracts?

Mainnet Shapes is `0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`, deployed at block 25898721. The renderer, the collection, the auction house and the linked libraries are listed on [Deployments](/docs/deployments), and the [Contracts](/contracts) page shows every function with its documentation and calls the read functions live.

### Where is the ABI, and is there an indexer?

The ABI is in `deployments/1.json` in the repository and on the [Contracts](/contracts) page. A Ponder indexer follows mainnet and serves token state, lineage and an activity feed over GraphQL at `https://shapes-indexer-mainnet.fly.dev/graphql`. See [Indexer](/docs/indexer).

### Does Shapes implement ERC-8060?

It implements the current draft `IERC721Value` interface, `valueOf` plus `burn`, and advertises it through ERC-165. The proposal is a draft and may still change, and an immutable deployment cannot follow later changes.

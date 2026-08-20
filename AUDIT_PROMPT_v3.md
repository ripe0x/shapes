# Audit brief — the auction layer, the collection contract, and the id allocator

You are auditing Solidity that holds other people's ETH. Report findings; do not fix them.

## What to audit, exactly

```
repository  github.com/ripe0x/shapes
branch      main
```

Audit `main` at its tip, and **record the commit hash you used at the top of your report**. This
brief no longer pins one: the repository moved under two previous audits and a pinned hash went
stale faster than the brief could be updated. A finding still has to be attributable to a fixed
tree, so the hash you record is what makes it so.

```bash
git fetch origin && git checkout origin/main
git rev-parse HEAD            # put this in your report
forge build
forge test                    # expect 0 failures; 4 fork tests skip without an RPC
FOUNDRY_PROFILE=ci forge test # deeper fuzz and invariant runs
./script/check-docs.sh        # every selector named in the docs exists on the contract
```

**`AUDIT_PROMPT_v2.md` remains in scope and is not superseded.** It covers the token core:
recomposition, provenance, the Black state, ink genes. Read it first.

**Two audits have already run against this layer.** Their findings are closed, and the closures
are described below rather than left for you to rediscover. Where a closure removed a capability
rather than guarded it, that is stated: those are the places to check the removal is actually
total.

## What is new since the v2 brief

Four things, in descending order of how much they can cost if wrong.

1. **`src/ShapeAuctionHouse.sol`**. Escrows any ERC721 as the lot plus Shape cards as bids, and
   is the only contract here holding assets belonging to people other than its caller. **The lot
   is no longer restricted to Shapes, and delivery is now a pull.** See the section below.
2. **The id allocator changed.** Token ids now issue from 0 rather than 1, and `totalMinted` is a
   count rather than the highest id. This interacts with `decompose`, which re-mints
   already-issued ids.
3. **`src/ShapeCollection.sol`**. Contract-level metadata and seeded card previews. Reads
   `block.prevrandao`, so it is the one piece of presentation that is not a pure function.
4. **`mint` split into `mint`/`mintTo` and `mintBatch`/`mintBatchTo`**, and **`restore` was
   removed** along with the `_splitRecords` mapping and four `Restore*` errors. A split is now
   final.
5. **Owner-editable metadata copy**, with validation on set. New authority on a previously
   copy-free contract, and a JSON-injection channel that had to be closed.
6. **A contract title**: `titleHolder`, `titleSince`, `transferTitle`. One holder, no authority
   beyond passing it on, independent of `owner()`. Read by nothing else.
7. **Token 0 is minted by the deploy script**, in the same broadcast as deployment.

## Where the v2 brief is now stale

- It describes `restore` and `splitRecordOf`. Both are gone. If you find a reference to them
  anywhere in the tree outside `INK_GENES_DRAFT.md` and `REVIEW_PROMPT_INK_GENES.md`, which are
  historical records, that is a finding.
- It describes `blacken`. That is now `sacrifice`.
- It describes `mint(amountWei, to)`. That signature no longer exists.
- Its id-collision argument was rewritten for 0-based ids. `DECOMPOSE_SPEC.md` carries the
  current version.

## The invariants

Everything in `AUDIT_PROMPT_v2.md` still holds. These are the additions.

**I1. A fresh mint can never reproduce a revived id.** Ids issue from 0 and `totalMinted` counts
them, so the highest ever issued is `totalMinted - 1`. `mint`, `mintBatch` and `split` take
`totalMinted` itself. `decompose` re-mints previously burned ids and deliberately does not advance
the counter, so a revived id is at most `totalMinted - 1` and therefore always below the next
fresh one.

A violation does not corrupt state silently: OpenZeppelin's `_mint` reverts on an existing token.
It bricks `decompose` or minting outright, permanently, with no recovery. Treat any path to it as
critical rather than as a liveness nit.

**I2. Every card the auction house holds belongs to exactly one escrow entry.** A card that
belongs to none is stranded forever; a card that belongs to two is claimable twice, and a Shape
card is redeemable for real ETH by whoever holds it.

**I3. The house never pushes an asset.** Outbid bidders pull, and so does the winner: the lot is
delivered by `claimLot`, not by `settle`. If any path pushes an ERC721 to an address chosen by
someone else, a hostile receiver or a hostile collection can revert it and freeze the auction.

**I5. No outcome depends on a foreign contract.** `settle` and `cancelAuction` must be unfailable
given their preconditions: they call nothing. A lot that reverts on transfer must not be able to
prevent an outcome being recorded, a seller claiming proceeds, or a losing bidder withdrawing.

**I6. The lot has exactly one exit, taken at most once.** `claimLot` is the only path out for a
lot, `lotClaimed` gates it, and the recipient is the winner when one exists and the seller when
none does. A lot claimable twice is a stolen asset; one claimable by neither is a locked one.

**I4. Bid value comes from `backingOf`, never from a denomination.** A Black Shape reads as
100 ETH by denomination and zero by backing. Valuing off the denomination would let a worthless
token win an auction.

## Attack surfaces, in the order I would probe them

### The auction house

Still where I would spend most of the time. Two rounds have been through it, so the shallow
findings are gone; what is left is whatever the closures did not fully cover.

**Already found and closed — verify the closure, do not re-derive the finding:**

- A seller-supplied ERC721 whose `transferFrom` returned without moving anything let the seller
  collect a real winning bid for a lot that never changed hands. A second contract that permitted
  the inbound transfer and reverted the outbound one stranded the leader's escrow with neither
  settlement nor withdrawal reachable.

  **This closure was reverted and replaced, and the replacement is the single largest thing to
  attack in this round.** Restricting the lot to Shapes was treating the second finding as a
  property of the lot being unknown, when it was a property of the house *pushing* the lot.
  `settle` and `cancelAuction` now record an outcome and transfer nothing; the lot leaves only
  through `claimLot`, pulled by the winner, or by the seller when the auction closed unsold.
  `createAuction` takes an `nft` address again.

  The claim to break is that the lot's collection is reachable from exactly two functions,
  `createAuction` and `claimLot`, and that every other path moves Shapes alone. If you can reach
  an arbitrary `nft` from `settle`, `withdraw`, `claimProceeds`, `bid` or `cancelAuction` — by any
  route, including reentrancy from within `createAuction`'s or `claimLot`'s transfer — the
  containment argument fails and the original H-02 is back.

  The first finding is **accepted and unfixable**: a collection lying about `transferFrom` lies
  about `ownerOf`. Do not report it. Do report any way it harms someone other than the bidder who
  chose that auction.
- The mint fee is forwarded before minting, so a contract fee recipient ran code while the house's
  `_minting` flag was set and could hand it an untracked card. **Closed by also requiring
  `from == address(0)`.**
- A Shape pushed in by a plain `transferFrom` is held with no escrow entry and no way out. **Not
  closed. Accepted and documented** in `SECURITY.md`: the alternatives are coupling `Shapes` to
  the house, or an administrative path into everyone else's escrow. Do not re-report it; do report
  a way for it to affect anyone other than the sender.

- **Escrow accounting.** `_takeCards`, `_mintCards` and `_release` are the whole of it. Can a
  bidder end up able to withdraw cards they did not deposit, or the seller claim cards that are
  not the winning bid? Can a card enter `_escrow` without its id being appended, or be appended
  twice?
- **`_release` clears state before transferring.** Verify that ordering actually holds under every
  entry point, and that `withdraw` and `claimProceeds` cannot both reach the same escrow entry.
- **The leader cannot withdraw.** The check is `msg.sender == a.highestBidder`. Confirm that
  covers both the live auction and the settled one, and that no state transition leaves an escrow
  entry unreachable by anyone.
- **The card cap bounds the escrow, not the call.** An unbounded escrow makes `_release` exceed
  block gas, locking a bidder's own cards forever. I fixed this once; check I fixed it everywhere,
  including the ETH path where cards are minted rather than transferred in.
- **The ETH path.** `_mintCards` computes a minimal card set, calls `mintBatch` once per tier, and
  records the ids the mint reports. Can the fee arithmetic be made to under- or overpay? Can the
  recorded ids diverge from the ids actually minted?
- **`onERC721Received`.** It returns the magic value only for Shapes and only while `_minting` is
  set. Can that flag be observed set by anything other than the house's own mint? Can a token
  reach the house by any other route and be stranded?
- **Timing.** The clock starts at the first bid. Can `endTime` be moved inward? Can an auction be
  settled before it ends, or an unbid auction be settled at all? Can `cancelAuction` run after a
  bid?
- **The lot pull.** `claimLot` reads `highestBidder` to decide between the winner and the seller,
  relying on `settle` requiring a bid and `cancelAuction` requiring none. Can an auction reach a
  settled state where that partition is wrong, and the lot goes to the wrong party? Can a lot be
  claimed while the auction is live, or after being claimed once?
- **Foreign reentrancy.** `createAuction` and `claimLot` call a contract the seller chose.
  `settle` and `cancelAuction` are deliberately not `nonReentrant`, because they make no external
  call. Confirm that is true of them, and that the guard on the two that do call out cannot be
  escaped.
- **The increment.** `_minimumBid` rounds up to a whole unit and floors at one. Can it be made to
  demand an amount no combination of denominations can express, deadlocking the auction?
- **Reentrancy.** Every external entry point is `nonReentrant`. The lot is escrowed with
  `transferFrom`, not `safeTransferFrom`. Confirm no callback path reaches a second entry, and
  that a malicious lot contract cannot exploit the transfer of a token it controls.

### The id allocator

- Every path that issues or reuses an id: `_mintBatch`, `split`, `decompose`. Construct any
  sequence where a fresh mint and a revived id collide.
- Token 0 specifically. It is the collection's first token, and 0 is the classic id to be
  mishandled as a sentinel. I found none in the contract; look again, including in
  `ShapeAuctionHouse` and `ShapeCollection`.
- `setRenderer` emits `BatchMetadataUpdate(0, totalMinted - 1)` behind a non-zero guard. Confirm
  the guard cannot be bypassed.

### The collection contract

- `seed()` is `block.prevrandao` folded with the block number. Confirm nothing economically
  meaningful depends on it: it drives presentation only, and a validator able to influence
  `prevrandao` should gain nothing.
- `imageFor` and `cardFor` are unbounded loops building strings. Establish the gas ceiling and
  whether a caller can push it past what an `eth_call` will serve.
- It is reachable from `Shapes.contractURI`. Confirm a reverting or gas-exhausting collection
  cannot brick anything on the token beyond `contractURI` itself.

### The metadata copy

- Owner-editable strings land inside a JSON document served from `tokenURI` and `contractURI`.
  Validation on set closed a JSON-injection channel and rejects malformed UTF-8. Try to get a
  quote, a backslash, a control character or an invalid continuation byte through, or to make the
  document parse as something other than intended.
- Confirm the copy cannot affect backing, redemption, ownership or any id.

### The contract title

- `titleHolder` is read by exactly one function, `transferTitle`. Confirm nothing else gates on
  it, in any contract.
- Confirm a title transfer moves no ETH, calls nothing, and changes no token, accounting figure
  or configuration, and that no core operation moves the title.
- It is independent of `owner()` in both directions, including after renunciation. Confirm neither
  role can reach the other.
- It is a bearer instrument with no recovery, deliberately. Do not report the absence of recovery;
  do report any way for someone other than the holder to move it.

### Cross-contract

- `Shapes` has no knowledge of the house. Confirm that is actually true and that the house holds
  no privileged position: no approval it can exploit, no role, no callback the token honours.
- `setCollection` is gated by `rendererLocked`, the same flag as `setRenderer`. Confirm one lock
  really does freeze both, and that neither can be changed after it.

## Bugs I found in my own review — the class matters more than the instances

I wrote the auction house and reviewed it before writing tests. Four real bugs, none of which a
test suite written from the same assumptions would have caught:

1. The card cap bounded one call rather than the cumulative escrow.
2. ETH sent alongside a cards-only bid was accepted and then unreachable.
3. The ETH path predicted the ids `mintBatch` would issue instead of using the returned value.
4. A doc comment described behaviour the code did not have.

All four are the same shape: **an assumption stated in a comment that the code did not enforce.**
Read the comments as claims to be falsified, not as documentation.

## What is already tested — find the gaps, do not re-derive

- `test/AuctionHouse.t.sol` (34 plus 8 in `ForeignLotTest`): Black Shape rejection against a real
  sacrificed apex, a hostile bidder that refuses ERC721s, escrow exactness across a contested
  auction, the increment ceiling, anti-sniping, a fuzz over the minimal card set, and a foreign
  ERC721 sold end to end through both the card and ETH bid paths.
- `test/AuctionSecurity.t.sol`: a lying lot running alongside an honest auction, and a lot jammed
  after the bids are in. Both assert on what is *unaffected*, which is where to look for a gap.
- `test/TokenIds.t.sol` (12) and `invariant_EveryLiveIdIsBelowTheCounter`: the allocator, at
  65,536 calls under CI depth.
- `test/Token0.t.sol` (6): who can take #0, that a Shape cannot be minted into the house, and the
  mint/mintTo split.
- `test/Collection.t.sol` (11): per-block variation, seeded reproducibility, capability checks.
- `test/Invariants.t.sol`: solvency, backing conservation, origin conservation, ladder membership.

## Known and accepted, do not report as findings

- **Token id 0 is first-come.** Minting is permissionless; nothing reserves it. Deliberate.
- **The winner can burn the lot.** If the lot is a Shape, `redeem` destroys it for its backing.
  Deliberate.
- **A lot can be listed by a seller whose collection is worthless or fraudulent.** Permissionless
  listing. The interface names the collection; the contract cannot judge it.
- **A winner who cannot receive the lot has still paid for it.** `claimLot` remains callable
  forever, so a paused collection resolves itself. A permanently hostile one does not, and that
  loss stays with the bidder who chose the auction.
- **The renderer is not locked at launch**, so the owner can change every token's artwork and the
  collection metadata until they choose to lock. Deliberate, and disclosed.
- **The ETH bidding path costs the 1% Shapes mint fee**; the card path does not. Deliberate.
- **The house charges no fee.** A percentage of a card set is not representable on the
  denomination lattice.
- **`decompose` is permanently reversible.** There is no `seal`. Deliberate.
- **A split is final.** Composing the pieces back yields a different artwork. Deliberate.

## Deliverable

For each finding: severity, the exact file and line at the commit you recorded, a concrete failing
sequence with values rather than a description of a category, the invariant it breaks, and the
smallest change that would close it.

Rank by what it costs if exploited. A path that permanently locks someone's escrowed cards ranks
above one that merely reverts. Say plainly when you are uncertain rather than padding the list;
an empty section is a better answer than a speculative one.

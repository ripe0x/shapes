# Audit brief — the auction layer, the collection contract, and the id allocator

You are auditing Solidity that holds other people's ETH. Report findings; do not fix them.

## What to audit, exactly

```
repository  github.com/ripe0x/shapes
branch      main
commit      185bd0f   (Merge pull request #21 from ripe0x/claude/token-zero-tests)
```

Check it out at that commit and audit that tree. Do not audit `main` at HEAD if HEAD has moved;
findings must be attributable to a fixed state. This brief itself lands after `185bd0f`, which
changes nothing about the code under audit: it is the only difference, and it is documentation.

```bash
git fetch origin
git checkout 185bd0f
forge build
forge test                    # 295 pass, 0 fail, 4 skipped (fork tests, no RPC)
FOUNDRY_PROFILE=ci forge test # deeper fuzz and invariant runs
```

**`AUDIT_PROMPT_v2.md` remains in scope and is not superseded.** It covers the token core:
recomposition, provenance, the Black state, ink genes. Read it first. This brief covers what
changed after it was written, and states where its claims are now stale.

## What is new since the v2 brief

Four things, in descending order of how much they can cost if wrong.

1. **`src/ShapeAuctionHouse.sol`** (6,500 bytes). New contract. Escrows ERC721 lots and Shape
   cards, and is the only contract here that holds assets belonging to people other than its
   caller. Nothing in the repo has audited it.
2. **The id allocator changed.** Token ids now issue from 0 rather than 1, and `totalMinted` is a
   count rather than the highest id. This interacts with `decompose`, which re-mints
   already-issued ids.
3. **`src/ShapeCollection.sol`** (4,366 bytes). New contract. Contract-level metadata and seeded
   card previews. Reads `block.prevrandao`, so it is the one piece of presentation that is not a
   pure function.
4. **`mint` split into `mint`/`mintTo` and `mintBatch`/`mintBatchTo`**, and **`restore` was
   removed** along with the `_splitRecords` mapping and four `Restore*` errors. A split is now
   final.

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

**I3. The house never pushes an asset.** Outbid bidders pull. If any path pushes an ERC721 to an
address chosen by someone else, a hostile receiver can revert it and freeze the auction.

**I4. Bid value comes from `backingOf`, never from a denomination.** A Black Shape reads as
100 ETH by denomination and zero by backing. Valuing off the denomination would let a worthless
token win an auction.

## Attack surfaces, in the order I would probe them

### The auction house

This is where I would spend most of the time. It holds redeemable cards and has had no review
beyond my own.

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

- `test/AuctionHouse.t.sol` (34): Black Shape rejection against a real sacrificed apex, a hostile
  bidder that refuses ERC721s, escrow exactness across a contested auction, the increment ceiling,
  anti-sniping, and a fuzz over the minimal card set.
- `test/TokenIds.t.sol` (12) and `invariant_EveryLiveIdIsBelowTheCounter`: the allocator, at
  65,536 calls under CI depth.
- `test/Token0.t.sol` (6): who can take #0, that a Shape cannot be minted into the house, and the
  mint/mintTo split.
- `test/Collection.t.sol` (11): per-block variation, seeded reproducibility, capability checks.
- `test/Invariants.t.sol`: solvency, backing conservation, origin conservation, ladder membership.

## Known and accepted, do not report as findings

- **Token id 0 represents backed collectible ownership of the contract.** It is minted atomically to the deployer,
  carries no permissions, and otherwise follows the ordinary Shape lifecycle. The first
  permissionless artwork is #1. Deliberate.
- **The winner can burn the lot.** If the lot is a Shape, `redeem` destroys it for its backing.
  Deliberate.
- **The renderer is not locked at launch**, so the admin can change every token's artwork and the
  collection metadata until they choose to lock. Deliberate, and disclosed.
- **The ETH bidding path costs the 1% Shapes mint fee**; the card path does not. Deliberate.
- **The house charges no fee.** A percentage of a card set is not representable on the
  denomination lattice.
- **`decompose` is permanently reversible.** There is no `seal`. Deliberate.
- **A split is final.** Composing the pieces back yields a different artwork. Deliberate.

## Deliverable

For each finding: severity, the exact file and line at commit `185bd0f`, a concrete failing
sequence with values rather than a description of a category, the invariant it breaks, and the
smallest change that would close it.

Rank by what it costs if exploited. A path that permanently locks someone's escrowed cards ranks
above one that merely reverts. Say plainly when you are uncertain rather than padding the list;
an empty section is a better answer than a speculative one.

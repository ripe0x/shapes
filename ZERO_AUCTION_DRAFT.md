# Token 0 and the Shape Auction House — Draft Spec (v0.3, for discussion)

Status: DRAFT. Strawman numbers are marked ⚙ (tunable before freeze, immutable after). No
code written yet.

Baseline: `origin/main` at `c9eb8a2`. This worktree branches from `0c17835` and is about
thirty commits behind; the gap renamed the old `decompose` to `split` and added a new
`decompose` as compose's exact inverse. Read §6 before trusting any recomposition vocabulary.

Scope: a release mechanism for token 0 of the collection, in which bids arrive as Shape
cards and the artist is paid in Shapes. Plus a general auction contract others can reuse,
and a separate list of what this exercise revealed about `Shapes` itself.

**Decided**

- Token 0 is a Shape, in the collection. Not a companion 1-of-1.
- **Token ids start at 0.** Built: `_mintBatch` and `split` issue `totalMinted`, and
  `totalMinted` counts ids issued rather than naming the highest one.
- **Token 0 is minted at 0.01 ETH**, the lowest denomination: a 5×5 grid, 25 modules,
  maximum density. Every later addition can only make it sparser.
- **Token 0's seed is one draw.** No grinding. Whatever the mint returns is the piece.
- Bids are **escrowed**, not absorbed. Token 0 does not change denomination during the
  auction. The artist is paid in the winning bid's cards.
- Outbid bidders get back the exact token ids they deposited, which is trivial once nothing
  is composed.
- **The auction clock starts at the first bid**, not at creation.
- **Auction settings.** Reserve 0.01 ETH (`reserveUnits = 1`), duration 24h, minimum increment
  5%, extension window 15 minutes, 64 cards per bid. A reserve of one unit is the smallest the
  lattice allows and is equivalent to no reserve: with the increment rule's one-unit floor, the
  first bid already has to be at least 0.01 ETH. The piece can therefore sell for 0.01 ETH if
  nobody else bids.
- **No observer hook.** An optional per-auction callback on each new high bid was specced and
  cut: nothing in this release reacts to a bid, and it put an external call into arbitrary code
  inside the bid path of a contract holding escrowed, redeemable cards. Anything wanting to react
  reads the events.
- **The auction requires no changes to `Shapes`.** §6 lists what is already shipped.
- **`ShapeAuctionHouse` ships, and is audited in the same engagement as `Shapes`**, scoped as a
  second contract. It escrows redeemable cards, so it needs the same scrutiny.
- **The renderer is not locked at launch.** `setRenderer` and `setCollection` stay open, so a
  rendering bug is fixable. The cost is a live owner power over every token's artwork. See R14.
- **No `seal`.** A one-way freeze on a token's compose history was designed and rejected: it
  costs a renderer signature change, a new trait pair and a new permanent state, to buy a
  capability nothing in the release needs. Compose stays reversible forever. See §6/F1.

The absorption design and why it was dropped is recorded in §2, because the reasoning
produced most of §6.

---

## 1. What the ladder already gives you

Properties of the existing `Denominations` table, not of anything new.

```
0.01   0.05   0.1   0.5   1   5   10   50   100   ETH
```

**L1. Every bid amount is a whole multiple of 0.01 ETH.** `UNIT` is 0.01 ETH and every
denomination is a whole multiple of it. The bid space is a lattice, not a continuum.

**L2. Every multiple of 0.01 ETH up to 100 ETH is expressible**, trivially as *n* cards of
0.01. No amount on the lattice is unassemblable.

**L3. In units of 0.01 ETH the ladder is `1, 5, 10, 50, 100, 500, 1000, 5000, 10000`.** The
standard 1-5-10-50-100 currency system, which is canonical: greedy selection always produces
a minimum-card set. One canonical breakdown per amount, cheap to compute on chain.

**L4. Greedy never needs more than 20 cards** for any amount below 100 ETH. Worst case is
99.99 ETH: `50 + 10×4 + 5 + 1×4 + 0.5 + 0.1×4 + 0.05 + 0.01×4`. Exactly 100 ETH is one card.

**L5. Any minimum increment is satisfiable if rounded up to a whole unit.** With L2, an
increment rule can never deadlock the auction by demanding an unassemblable amount.

**L6. Card count and module count trade against each other.** Many cards implies a large
amount implies mostly sparse cards. Worst case across a full greedy breakdown is 256 modules
over 20 cards.

**L7. A bid's ETH value does not determine what the seller receives.** Two 1 ETH cards are
identical at redemption and different as objects: different seed, ink gene, and
`originCount`, so different `isComplete` status and different distance from a Black Shape.
See R8.

**L8. A minimal card set has no composable subset.** Greedy takes at most one card from each
"5" tier (0.05, 0.5, 5, 50) and at most four from each "1" tier (0.01, 0.1, 1, 10). No subset
of such a set sums to a ladder amount: 4×1 is 4, 5+4×1 is 9, 50+4×10 is 90, none of which are
denominations. **To compose at all you must first hold redundancy.** A holder whose cards are
in canonical form has no move.

---

## 2. Why token 0 does not absorb bids

Recorded so it does not get relitigated. The mechanism was: each leading bid composes into
token 0, raising its denomination and contracting its artwork, and is uncomposed back out
when outbid.

**Reversible `compose` is no longer a blocker: it already exists.** On `origin/main`,
`decompose(survivorId)` pops the survivor's most recent compose and re-mints every burned
input under its original id and seed, and `decomposeTo` sends them straight to a named
recipient. An absorbing auction could unwind an outbid leader in one call. This was the
objection in earlier drafts and it is now void.

**Absorbed ETH is not a payment.** It sits inside token 0 and the winner receives it back as
backing, so the artist is paid nothing unless the bid is split into a deposit and a premium
with ranking on premium only. Ranking on the total is actively broken: a 4.98 ETH bid absorbs
0.99 and pays the artist 3.99, while a 4.99 ETH bid absorbs 4.99 and pays the artist nothing.

**Absorption lands on rungs, not on prices.** `compose` requires the summed backing to land
exactly on the ladder, because `ShapeData.denomIndex` stores an index rather than a wei
amount, which is what makes an out-of-ladder backing unrepresentable rather than merely
rejected. So token 0 could only ever sit on one of eight rungs above its start, and each bid
would have to be split into a rung delta and a remainder.

**Nothing can make the absorption stick.** Compose is permanently reversible, so the winner
can `decompose` token 0 on delivery, take the deposit back, and keep token 0 at its base
denomination. The final price cannot set the artwork permanently; it sets it only while the
current owner leaves the capital in. See §6/F1.

Reserve accounting was never the problem. `compose`, `decompose` and `split` move no ETH, so
the reserve invariant holds throughout. The two live objections are **payment** and
**permanence**, both above. Neither is about cost or capability any more.

What survives from the exercise is §6.

---

## 3. `ShapeAuctionHouse`

Sells any ERC721. Bids are always denominated in Shape cards.

An audit of `185bd0f` found two ways a seller-supplied lot contract could be abused, and both were
reproduced. A `transferFrom` that returns without moving anything let the seller collect a real
winning bid for a lot that never changed hands. One that reverted only on the way out stranded the
leader's escrow, with neither settlement nor withdrawal reachable.

The lot was restricted to Shapes as the first response. It is not restricted now, because the
second finding was a symptom of the house pushing the lot rather than of the lot being unknown.
Settlement records an outcome and moves nothing; the lot leaves through `claimLot`, pulled by the
party the outcome names. A lot that refuses to move therefore blocks its own delivery and nothing
else: the seller still claims the winning cards, every outbid bidder still withdraws, and both of
those paths move Shapes alone.

The first finding has no on-chain fix. A collection that lies about `transferFrom` lies about
`ownerOf` too, and no check distinguishes it from an honest one. What the contract offers instead
is a bound on who can be hurt: the lot's address is reached from `createAuction` and `claimLot`
and nowhere else, so the loss falls on the bidder who chose that auction and reaches no other
auction, seller or bidder. This is the exposure every permissionless marketplace carries, and the
mitigation is the same one: the interface shows the collection address, and the bidder checks it.

### 3.0 What it depends on

`origin/main` splits the Shapes surface into stable capability interfaces
(`src/interfaces/IShapeCapabilities.sol`). The house should depend on the narrowest ones it
can:

- `IShapeValue` for `backingOf`, `shapeState`, `unit`, `denominationAt`, `denominationCount`.
  This is the whole valuation path.
- `IShapeProvenance` for `originCountOf` and `isComplete`, which is what R8 wants surfaced.
- `IERC721` for `transferFrom` and `safeTransferFrom`.
- `IShapes` for `mintBatch` and `mintFeeFor` only. There is no mint capability interface, so
  the ETH on-ramp is the one place the house needs the full interface.

The house needs **nothing** from `IShapeRecomposition`. It never composes, decomposes or splits.

`shapeState(tokenId)` returns seed, denomination index, origin count, ink gene, black flag,
formation, face value and redeemable value in one call, so a bid's full display data is one
read per card rather than five.

### 3.1 State

```solidity
struct Auction {
    address seller;
    address nft;
    uint256 tokenId;
    uint64  endTime;
    uint32  extensionWindow;   // 900s
    uint16  minIncrementBps;   // 500 (5%)
    uint64  reserveUnits;
    uint64  highestUnits;
    address highestBidder;
    bool    settled;
}

mapping(uint256 auctionId => Auction) public auctions;
mapping(uint256 auctionId => mapping(address bidder => uint256[])) private _escrow;
mapping(uint256 auctionId => mapping(address bidder => uint64)) public bidUnits;
```

All values in `UNIT` (0.01 ETH) multiples per L1. `uint64` covers 1.8e17 ETH. `Shapes` is an
immutable constructor argument.

### 3.2 Creating an auction

```solidity
function createAuction(
    address nft,
    uint256 tokenId,
    uint64  duration,
    uint64  reserveUnits,
    uint16  minIncrementBps,
    uint32  extensionWindow
) external returns (uint256 auctionId);
```

`nft` must have code. The lot is escrowed with `transferFrom`, never `safeTransferFrom`, so the
house takes no `onERC721Received` callback for it, and the house checks it holds the token
afterwards. That check binds an honest collection; nothing binds a dishonest one.

The seller may `cancelAuction` only while there is no bidder. Cancelling records the close and
returns nothing: the seller pulls the lot back with `claimLot`, the same function a winner uses.

The clock starts on the first bid rather than at creation (⚙), so the auction cannot expire
unsold because nobody was watching on day one.

### 3.3 Bidding

```solidity
function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei)
    external payable nonReentrant;
```

1. Auction exists, not settled, not ended.
2. For each card: read `v = shapes.backingOf(id)`, require `v > 0`, then
   `shapes.transferFrom(msg.sender, address(this), id)`. Accumulate `v`.
   - `backingOf` returns **0 for a Black Shape**, so `v > 0` is what rejects one. This is not
     optional. A Black Shape still carries `denomIndex == 8` internally, so valuing off the
     denomination would price a non-redeemable token at 100 ETH. See R1.
   - Duplicate ids need no explicit check; the second `transferFrom` reverts.
3. If `ethBackingWei > 0`: require it is a whole `UNIT` multiple, compute the greedy
   breakdown (L3), require `msg.value == ethBackingWei + fee`, and call
   `shapes.mintBatch(amount, count, address(this))` once per tier present, at most 8 calls.
   The aggregate fee is exactly `ethBackingWei * feeBps / 10000`, because 1% of every
   denomination is a whole number of wei and the fee is linear in backing.
4. `newUnits = bidUnits[id][msg.sender] + accumulated / UNIT`. A bidder topping up an existing
   escrowed bid adds to it rather than replacing it, so nobody has to withdraw and re-bid.
5. Require

   ```
   newUnits >= max(reserveUnits,
                   highestUnits + max(ceilToUnit(highestUnits * minIncrementBps / 10000), 1))
   ```

   The unit ceiling and the `max(..., 1)` floor are what make L5 hold.
6. Write the new leader. If `block.timestamp > endTime - extensionWindow`, set
   `endTime = block.timestamp + extensionWindow`.

Cap cards per bid at 64.

### 3.4 Refunds are pull, never push

An outbid bidder's cards do not move. They stay in `_escrow` until claimed:

```solidity
function withdraw(uint256 auctionId) external nonReentrant;
```

Callable by any bidder who is not the standing leader, and by the loser of a settled auction.

This is not a style preference. Pushing up to 20 ERC721 transfers to an arbitrary address
inside `bid` would let a bidder with a reverting `onERC721Received` freeze the auction at
their own bid permanently.

The seller pulls too: `claimProceeds(auctionId)` after settlement.

### 3.5 Settlement

```solidity
function settle(uint256 auctionId) external nonReentrant;
```

Permissionless once `block.timestamp >= endTime` and a bid exists. Transfers the sold token
to the leader and marks settled. The winning cards stay escrowed until the seller pulls them.
With no bids, the seller reclaims the token.

### 3.6 ERC721 receipt

`onERC721Received` returns the magic value only when `msg.sender == address(shapes)` and a
transient flag set inside the ETH path of `bid` is live. Everything else reverts, so
unsolicited Shapes cannot be stranded, and bidding by raw `safeTransferFrom` is unsupported.
Bidding stays a single atomic transaction with a single comparison against the standing bid.

`Shapes._update` refuses transfers to `address(shapes)` only, so the house holding Shapes is
fine.

### 3.7 No protocol fee

The house charges nothing. A percentage fee is **structurally unrepresentable**: a bid is a
set of indivisible cards, and 5% of a lattice amount is not necessarily on the lattice (5% of
0.01 ETH is 0.0005 ETH, which no card can hold). Carving one out would mean decomposing the
winning set at settlement.

The only fee anywhere is the 1% `Shapes` mint fee on the ETH bidding path.

---

## 4. Worked example

Token 0 minted by the artist at ⚙ 0.01 ETH and escrowed. A 1.5 ETH bid, which is 150 units:

| Path | Bidder sends | House does |
|---|---|---|
| Cards | one 1 ETH card, one 0.5 ETH card | escrows 2 cards |
| Cards | one 1 ETH card, five 0.1 ETH cards | escrows 6 cards |
| Cards | 150 cards of 0.01 ETH | rejected, over the 64 card cap |
| ETH | `ethBackingWei = 1.5e18`, `msg.value = 1.515 ETH` | mints 1 + 0.5 to itself |
| Mixed | one 1 ETH card, `ethBackingWei = 0.5e18`, `msg.value = 0.505 ETH` | escrows 1, mints 1 |

All five are the same 150 unit bid. The house compares totals only. The winner receives token
0; the artist receives the cards and can hold them as objects or redeem them at par.

### 4.1 What the winner can do with token 0 afterwards

Token 0 keeps its id through every operation except being burned. The relevant one:

**Adding ETH while keeping id 0 is `compose`, with token 0 as the survivor.**

```solidity
shapes.compose(0, cardIds);   // token 0 survives, keeps id and seed, grows to the summed denomination
```

`compose` keeps the survivor's id and seed by definition. Only the denomination changes, and
with it the density of the artwork. Two constraints:

- **The owner must hold the cards first.** `compose` burns caller-owned tokens; it takes no
  ETH and charges no fee. So adding value is two steps: `mint`/`mintBatch` the cards (backing
  plus the 1% mint fee), then `compose` them into token 0. Buying existing cards on the
  secondary market works identically and pays no mint fee.
- **The total must land on a rung.** Token 0 starts at 0.01, so the first addition must be
  0.04 (to 0.05), 0.09 (to 0.1), 0.49, 0.99, 4.99, 9.99, 49.99 or 99.99. The rung table is in
  §2.2. `previewCompose` confirms the outcome before signing, and `composeMany` climbs
  several rungs in one transaction.

**It is reversible.** `decompose(0)` pops the most recent compose, returns token 0 to its
previous denomination, and re-mints every input card under its original id and seed. LIFO, so
repeated additions unwind newest first. `composeDepth(0)` reports how many are still
reversible. This is permanent: there is no way to give up the option, so every compose token 0
ever receives can be unwound by whoever owns it at the time.

**What would destroy id 0:** `redeem` (burns it, pays out the backing) and `split` (burns it
into fresh fragment ids). `sacrifice` keeps the id and inverts the artwork, but only applies at
100 ETH apex Complete and permanently sacrifices the backing.

So the piece is a ratchet the owner controls in both directions, and the one thing that ends
it is a deliberate burn.

---

## 5. Deployment order

1. Deploy `ShapeRenderer` and `Shapes`.
2. Artist mints token 0. One draw at the seed (R11).
3. Verify the renderer. Do not `lockRenderer`: presentation stays fixable.
4. Deploy `ShapeAuctionHouse`.
5. Artist calls `createAuction`, escrowing token 0.
6. Bidding, then `settle`.

Ids start at 0: `_mintBatch` and `split` issue `totalMinted`, so the highest id issued is
`totalMinted - 1`. The collision argument that guards `decompose`'s revived ids holds unchanged,
because a fresh mint still takes an id above every one already issued.

---

## 6. Findings for `Shapes`, independent of the auction

**Baseline: `origin/main` at `c9eb8a2`.** This worktree branches from `0c17835`, roughly
thirty commits behind, and the gap includes `f17eb9a` "Reversible compose: rename shatter to
split, add decompose as compose's exact inverse". Most of what an earlier draft of this
section proposed already exists.

**Outcome: no additions proposed.** F1 and F2 were designed and rejected. F3 is an open
aesthetic question that predates this work. F4, F5 and F7 are documentation. F6 is the only
code change suggested, and it is a deletion.

### Already shipped, do not rebuild

- **Reversible compose.** `compose` writes a per-survivor LIFO `ComposeRecord` stack holding
  each burned input's full `(id, seed, denomIndex, originCount, inkGene)`.
  `decompose(survivorId)` pops the top record, reverts the survivor to its pre-compose
  denomination, origin count and gene, and re-mints every input **under its original id and
  seed**. `totalMinted` is untouched because ids are reused rather than issued. See
  `DECOMPOSE_SPEC.md`.
- **The vocabulary changed.** The old free-form shatter is now `split` / `splitTo`, its event
  is `Split`, its error is `SplitMismatch`, and its preview is `simulateSplit` /
  `previewSplit`. The name `decompose` now means compose's exact inverse. Any spec text
  written against the old names is wrong.
- **Batching.** `composeMany`, `decomposeMany`, `decomposeManyTo`, all non-payable, and
  `DECOMPOSE_SPEC.md` explicitly rejects a generic `multicall(bytes[])` for the
  `msg.value`-reuse hazard against payable `mint`/`mintBatch`.
- **Recipient-directed everything.** `decomposeTo`, `splitTo`, `redeemTo`,
  `redeemBatchTo`.
- **A Black Shape's denomination is readable.** `ShapeState.faceValueWei` survives sacrifice;
  `redeemableValueWei` is zero for a Black Shape and otherwise equals face value. Reached via
  `shapeState(tokenId)`.
- **Previews and introspection.** `previewCompose`, `previewSplit`,
  `composeDepth`, `formationOf`, `shapeState`, `childSeed`, `denominationAt`,
  `denominationCount`, `unit`, `unicodeCard`, and the split capability interfaces
  `IShapeValue` / `IShapeRecomposition` / `IShapeProvenance`.

### F1. Compose is permanently reversible, and that is accepted

Any owner of a survivor can `decompose` it back down at any time, forever. There is no
irreversible variant of `compose` and no way to surrender the option.

Consequence, recorded because it closes off a whole family of designs: **a price can never
bind an artwork.** Any scheme where a token's denomination is meant to be settled by an
external event, an auction included, can be undone by whoever holds the token afterwards. A
Shape's density is only ever as monumental as its current owner chooses to keep it.

A `seal` was designed (a monotonic compose-depth floor, plus `Sealed` and `Sealed Depth`
traits mirroring the `Compose Depth` plumbing) and rejected as more complexity than value: a
renderer signature change, a trait pair, new permanent per-token state, and a partially-sealed
state to explain, all to buy a capability nothing in the release needs. `Shapes` has no
upgrade path, so this is a decision not to have it rather than a deferral.

### F2. `previewCompose` reverts instead of answering, and that is fine

`previewCompose` mirrors `compose`'s validation, so it reverts rather than returning a
boolean. A `canCompose` returning `(bool ok, ShapeState result)` was considered and rejected,
because there is no consumer that needs it.

Nothing about a compose requires a chain call to predict. Validity is: every token exists and
is not Black, the survivor is not in its own burn set, no id repeats, and the summed backing
lands on the ladder. All of that is computable from data a client already holds, against a
fixed nine-entry table. The one non-trivial part, the resulting ink gene, is mirrored in
`preview/src/canonical/ink.ts` as `geneAtCompose` and held byte-identical to `InkGenes.sol`
by the parity suite, so a client computes that off chain too.

That leaves contract integrators, for whom `try/catch` around a `staticcall` is routine and
cheap. No identified consumer, an immutable contract, and a real off-chain answer already in
the repo. Not worth a function.

### F3. `split` is final and identity-lossy

`split` burns its input and issues fresh ids. There is no reassembly path: identity carries up
through compose, can return through decompose, and ends at a split. This is a deliberate product
choice, so auction and custody UIs must warn before submitting a split.

### F4. The split origin partition is caller-ordered, and now previewable

Origins fill each output to capacity in listed order, so `outDenoms` ordering silently decides
which fragment inherits the provenance. `previewSplit` returns each child's `originCount`
before committing, which mitigates most of the footgun. Remaining action is documentation at
the call site in `IShapes`, not a contract change.

### F6. `simulateCompose` and `simulateSplit` are redundant, and one of them misleads

The contract is otherwise clean: every one of the fifteen events is emitted, every custom
error is used, no state variable is unread, and `solc` reports no dead code (the only warnings
in the build are two unused fuzz parameters in `test/ShapeRenderer.t.sol`). Runtime size is
19,390 bytes with 5,186 to spare, so this is about surface area, not bytes.

Two functions do not earn their place.

**`simulateCompose` is a strict subset of `previewCompose`.** Both call `_previewCompose`;
`simulateCompose` returns two of its fields, `previewCompose` returns the whole `ShapeState`.
No production consumer: it appears in the test suite and in `IShapeSimulation`, and the
preview app's own comment at `preview/src/chain/ChainApp.tsx:66` says it derives post-compose
ink locally "without a round trip to the chain's `simulateCompose` view".

**`simulateSplit` still carries a narrower form of the bug it was patched for.** Its NatSpec
concedes it is "trivially `inkGeneOf(tokenId)`... included for interface symmetry with
`simulateCompose`", so it exists for symmetry with the other redundant function.
`test/Shapes.t.sol:1436` records an audit finding where it reported success for a split that
would revert, fixed by adding a Black guard. But it takes no `outDenoms`, so it still cannot
check the two conditions `split` actually fails on most often: `SplitMismatch` when the
outputs do not sum to the parent's backing, and `EmptyRecomposition` below two outputs. Used
as a pre-flight check it returns a false green for both.

`previewSplit` dominates it completely: same `_requireOwned` and `TokenIsBlack` guards, plus
the sum check, plus every child's seed, denomination, origin count and gene.

Removing both means deleting them from `IShapes`, from `IShapeSimulation` in
`IShapeCapabilities.sol`, and from the tests that cover them, and dropping the stale
`simulateSplit` entry at `preview/src/chain/abi.ts:25`, which is declared but never called.

### F7. `DuplicateComposeInput`'s NatSpec names the wrong function

`IShapes.sol:143` says the error is "`simulateCompose` only". The check is at
`Shapes.sol:987`, inside `_previewCompose`, which `previewCompose` also calls. The comment is
wrong today and stays wrong whether or not F6 is taken.

### F5. L8 belongs in the documentation

A holder whose cards are in canonical (minimal) form cannot compose anything, because no
subset of a greedy set sums to a denomination. Composing requires first accumulating
redundancy: five 0.01s, or four 1s plus another. Users hit this immediately and it is a
property of the ladder rather than of the code.

## 7. Issues, honestly

**R1. The Black Shape trap.** A Black Shape has had its 100 ETH sacrificed and is
non-redeemable, but still carries `denomIndex == 8` internally. Any valuation reading the
denomination instead of `backingOf` accepts a worthless token as a 100 ETH bid. `backingOf`
returns 0 for Black, so a correct implementation is safe. Sharpest edge in the design. Named
test required. Note F1 is the constructive other half of this.

**R2. The house is a custody contract holding claims on real ETH.** Escrowed cards are
redeemable for exactly their backing. A bug here loses other people's ETH, not just their
JPEGs. Same discipline as `Shapes`: no admin path, no pause, no recovery function, pull-based
everything, reentrancy guards, its own audit. Largest new risk surface in the plan.

**R3. The ETH path costs 1% and the card path does not.** An ETH bidder pays the mint fee to
conjure cards; a bidder holding cards pays nothing. Losing ETH bidders therefore pay 1% for
the privilege of losing. They keep the cards, which redeem at par, so the 1% is the whole cost
and not a loss of principal, and it is the same 1% they would have paid minting normally.
Still an asymmetry, and it belongs in the UI rather than buried.

**R4. If the artist is also the `feeRecipient`, they earn 1% on every ETH bid**, including
losing bids and their own. A shill-bidding incentive with a direct payout. Disclose it.

**R5. Gas.** A 20 card bid is 20 transfers. A 20 card ETH bid is 20 mints plus the `_safeMint`
callbacks, on the order of 2M gas. The 64 card cap bounds it, the UI must show the cost before
signing, and greedy breakdowns are minimal by L3 and should be the default.

**R6. Bidders lock real ETH with no yield for the auction duration.** Standard for auctions,
but the locked thing here is unusually liquid, which makes the lock more visible.

**R7. Split fragments cannot be reassembled.** Escrowing or releasing them does not change that;
the original token and artwork identity ended when it was split.

**R8. Equal bids are not equal objects (L7).** Two 1 ETH bids redeem identically and are
different objects: origins are what make a Shape `Complete` and what gate `sacrifice`, so a bid
paid in Complete-density cards is materially better to receive than one paid in origin-1
cards at the same price.

Two ways to handle it, and they are not the same size:

- **Display only (recommended).** The house ranks strictly on wei, exactly as §3.3 already
  specifies. No contract change of any kind. The site reads `shapeState` per escrowed card
  and shows each bid's total `originCount` beside its ETH, so the difference is visible when
  the bids are compared. Pure front end.
- **Ranking.** Origins become part of who wins: a tiebreak, a minimum origin density to bid,
  or a blended score. This one is a contract change and a real design problem, because it
  needs an exchange rate between ETH and origins, and any rate is arbitrary and therefore
  gameable at the margin. It turns the auction into a two-dimensional contest.

Recommendation: display only for v1. The information is the valuable part; making it binding
is a separate project.

**R9. Bidding is a mint with a refund.** On the ETH path a loser walks away holding freshly
minted cards. The residual grinding vector is SPEC.md D3e (revert unless the seed suits, one
attempt per block) and is not made worse here, because a reverted bid leaves auction state
untouched.

**R10. The winner can burn token 0.** It is a Shape backed by real ETH, so `redeem` destroys
the genesis piece for its backing. Preventing it needs a special case in `redeem`. Recommend
accepting it: it is the collection's own ethos applied to its first object.

**R11. Token 0's artwork is one draw.** `_mintBatch` excludes every caller-controlled input
from the seed, deliberately, so the artist cannot choose the genesis composition. The
sanctioned escape is the D3e residual: mint through a contract that reverts unless the outcome
suits, one attempt per block, gas per attempt. Decide before launch whether that is acceptable
or whether the first draw stands.

**R14. The owner can change every token's artwork for as long as they hold ownership.** The
renderer is deliberately not locked at launch, so `setRenderer` and `setCollection` stay live.
Backing, redeemability and ownership are untouchable either way, but artwork mutability is a real
power and an auditor will name it. Disclose it, and either renounce ownership or lock at a moment
of your choosing once the renderer has proven itself.

**R12. Marketplaces cache metadata.** Not load-bearing now that nothing about token 0 changes
during the auction, but relevant to the site's own display of the bid.

---

## 8. Open questions

None. Everything the auction needs from `Shapes` is deployed, and every setting is fixed. The
house itself is the only thing left to build.

---

## 9. Do-not list

- Do not value a bid card by its denomination. Use `backingOf`, which returns 0 for Black
  Shapes (R1).
- Do not push refunds. Outbid means the cards sit still until their owner pulls them (§3.4).
- Do not accept unsolicited ERC721s in `onERC721Received` (§3.7).
- Do not add a percentage protocol fee to the house. It is not representable on the card
  lattice (§3.8).
- Do not add a pause, an admin withdrawal, or a recovery function to a contract that escrows
  redeemable cards (R2).
- Do not leave the split record keyed by `parentSeed` if F3 is taken. A live decompose
  survivor keeps its seed alive, so a second split would overwrite the first record and
  orphan its children permanently. Rekey to `tokenId`.
- Do not use OpenZeppelin `Multicall` on `Shapes`. `mint` and `mintBatch` are payable and one
  `msg.value` would be counted by every call in the batch (F5).

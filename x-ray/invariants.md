# Invariant Map

> Shapes | 55 guards | 20 inferred | 3 not enforced on-chain

---

## 1. Enforced Guards (Reference)

Per-call preconditions. Heading IDs below (`G-N`) are anchor targets from x-ray.md attack surfaces.

#### G-1
`require(feeBps_ <= BPS_DENOMINATOR, "fee exceeds 100%")` · `Shapes.sol:242` · Bounds the immutable mint fee at construction so it can never exceed 100% of backing; no setter exists afterward.

#### G-2
`require(feeRecipient_ != address(0), "fee recipient is zero")` · `Shapes.sol:243` · The initial recipient cannot be zero. Admin may later redirect future fees, also only to a nonzero address; a reverting target blocks minting until corrected or forever after renunciation.

#### G-3
`require(renderer_.code.length != 0) / UnsupportedRenderer` · `Shapes.sol:349-355` · Prevents `tokenURI` from pointing at a codeless or non-`IShapeRenderer` address, applied at construction and on every `setRenderer`.

#### G-4
`if (rendererLocked) revert RendererIsLocked()` · `Shapes.sol:264` · Enforces the one-shot renderer lock inside `setRenderer` (see I-3).

#### G-5
`if (rendererLocked) revert RendererIsLocked()` · `Shapes.sol:276` · Same lock, checked inside `lockRenderer` itself to prevent a double-lock event.

#### G-6
`if (rendererLocked) revert RendererIsLocked()` · `Shapes.sol:313` · `setCollection` shares the renderer lock; presentation freezes as one unit.

#### G-7
`if (positionResolverLocked) revert PositionResolverIsLocked()` · `Shapes.sol:322` · Enforces the one-shot resolver lock inside `setPositionResolver` (see I-4).

#### G-8
`if (positionResolverLocked) revert PositionResolverIsLocked()` · `Shapes.sol:332` · Same lock, checked inside `lockPositionResolver`.

#### G-9
`if (msg.value != backing + fees) revert IncorrectPayment(...)` · `Shapes.sol:440` · Enforces exact ETH-for-Shape payment; the mint-side half of reserve solvency (see E-1).

#### G-10
`if (recipient == address(0)) revert InvalidRecipient(recipient)` · `Shapes.sol:538` · Prevents a redemption payout from being burned to the zero address.

#### G-11
`if (recipient == address(0)) revert InvalidRecipient(recipient)` · `Shapes.sol:552` · Same check for the batch redemption path.

#### G-12
`if (owner != msg.sender) revert NotShapeOwner(...)` · `Shapes.sol:579` · Redemption is owner-only, which fixes the payout destination unambiguously.

#### G-13
`if (d.isBlack && !allowBlack) revert TokenIsBlack(tokenId)` · `Shapes.sol:581` · Blocks `redeem` from paying ETH for a Black (zero-value) Shape; only `burn` (`allowBlack=true`) may destroy one, for zero.

#### G-14
`if (!sent) revert EthTransferFailed(to, amountWei)` · `Shapes.sol:596` · Reverts the whole redemption or sacrifice if the ETH transfer fails, so token state and reserve accounting never desync from a failed payout.

#### G-15
`if (ownerOf(tokenId) != msg.sender) revert NotShapeOwner` / `if (d.isBlack) revert TokenIsBlack` · `Shapes.sol:653,655` · Shared ownership+liveness gate reused by compose, split, decompose and sacrifice.

#### G-16
`if (burnId == survivorId) revert CannotComposeWithSelf(burnId)` · `Shapes.sol:719` · A compose survivor cannot also appear in its own burn set.

#### G-17
`Denominations.requireIndexOf(acc.total)` · `Shapes.sol:745` · Rejects a compose whose summed backing doesn't land on a valid denomination; this guard is also what makes backing conservation exact (see I-11).

#### G-18
`if (k < 2) revert EmptyRecomposition()` · `Shapes.sol:850` · A split must produce at least two outputs.

#### G-19
`if (sum != parentBacking) revert SplitMismatch(...)` · `Shapes.sol:821` · Enforces exact backing conservation across a split (see I-12).

#### G-20
`if (depth == 0) revert NoComposeRecord(survivorId)` · `Shapes.sol:988` · `decompose` requires a reversible compose record to pop.

#### G-21
`if (d.denomIndex != APEX_INDEX || d.originCount != Denominations.unitsAt(APEX_INDEX)) revert NotApexComplete` · `Shapes.sol:1043` · `sacrifice` is gated to a Complete 100 ETH apex only, never a Fragment/Composed/Direct token at that denomination.

#### G-22
`if (to == address(this)) revert SelfCustodyRejected(tokenId)` · `Shapes.sol:1319` · Blocks any transfer (including mint) that would leave a Shape owned by `Shapes` itself, which could never be redeemed since the contract can never be `msg.sender`.

#### G-23
`revert DirectDepositRejected()` · `Shapes.sol:1337,1341` · `receive`/`fallback` both revert; the only way ETH enters the reserve is through `mint`/`mintBatch`.

#### G-24
`CopyValidation.requireJsonSafe(...)` · `Shapes.sol:290-291,302-303` · Keeps admin-editable copy (name/description) from breaking or restructuring the token/collection metadata JSON, and requires well-formed UTF-8.

#### G-25
`if (resolver_ != address(0) && resolver_.code.length == 0) revert InvalidPositionResolver()` · `Shapes.sol:323-325` · A configured (nonzero) resolver must carry code; Shapes never calls or inspects that code further.

#### G-28
`if (nft.code.length == 0) revert LotHasNoCode(nft)` · `ShapeAuctionHouse.sol:90` · Names the reason a void-call collection would otherwise appear to accept a transfer.

#### G-29
`if (!IERC165(nft).supportsInterface(ERC721_INTERFACE_ID)) revert LotNotERC721(nft)` · `ShapeAuctionHouse.sol:94` · Rejects a wrong lot address, the common listing mistake; does not bind a collection that lies about its interface.

#### G-30
`if (_auctionIdByToken[nft][tokenId] != 0) revert AuctionAlreadyExistsForToken` · `ShapeAuctionHouse.sol:95` · Prevents double-listing a token already escrowed under a live, unclaimed auction.

#### G-31
`if (msg.sender != tokenOwner && msg.sender != getApproved(tokenId) && !isApprovedForAll(...)) revert NotTokenOwnerOrApproved` · `ShapeAuctionHouse.sol:100-105` · Only the lot's owner or an approved operator may list it.

#### G-32
`if (duration == 0 || duration > MAX_DURATION) revert DurationOutOfRange()` · `ShapeAuctionHouse.sol:108` · Bounds the clock so no bidder's escrow can be held indefinitely.

#### G-33
`if (extensionWindow > duration) revert ExtensionWindowTooLong()` · `ShapeAuctionHouse.sol:109` · The anti-sniping window may not exceed the duration it extends.

#### G-34
`if (IERC721(nft).ownerOf(tokenId) != address(this)) revert LotNotReceived()` · `ShapeAuctionHouse.sol:131` · Confirms the lot transfer actually landed; catches a `transferFrom` that returns without moving anything.

#### G-35
`if (msg.sender != a.seller || a.highestBidder != address(0) || a.settled) revert InvalidAuction()` · `ShapeAuctionHouse.sol:143` · Cancellation is seller-only, only before any bid, only before settlement. `cancelAuction` itself is now `nonReentrant` (see G-37).

#### G-36
`if (msg.sender == a.seller) revert SellerCannotBid()` · `ShapeAuctionHouse.sol:163` · A seller cannot bid its own lot with a second address's Shapes (see I-8).

#### G-37
`if (a.settled) revert AuctionAlreadySettled(auctionId)` · `ShapeAuctionHouse.sol:164,175` · Checked both before and after `_takeBid`. This re-check was originally the only defense against a bid landing on an auction settled via reentrancy from the Shapes fee recipient during card minting, and that gap was filed as a low. It was not: against a fee-recipient contract that is also the auction's seller, the sequence let the reentrant `cancelAuction` set `settled = true`, the outer `bid` then record the victim as `highestBidder` regardless, and the seller sweep the victim's escrowed cards through `claimProceeds` — a victim who cannot `withdraw` because they lead. `settle` and `cancelAuction` now both carry `nonReentrant` (SECURITY.md), closing the path structurally: the reentrant `cancelAuction` call reverts inside the fee recipient's own `receive`, which fails the mint fee transfer and unwinds the whole `bid` with `MintFeeTransferFailed`. This re-check remains as belt and braces. Pinned by `test_L1_AFeeRecipientSellerCannotStealAnEscrowedBid` (`test/AuctionSecurity.t.sol`).

#### G-38
`if (a.endTime != 0 && block.timestamp >= a.endTime) revert AuctionOver(auctionId)` · `ShapeAuctionHouse.sol:165` · A bid cannot land after the auction's deadline.

#### G-39
`if (newUnits < required) revert BidTooLow(newUnits, required)` · `ShapeAuctionHouse.sol:178` · A bid must clear the reserve or the standing bid plus its minimum increment.

#### G-40
`if (a.settled) revert AuctionAlreadySettled` / `if (a.endTime == 0 || block.timestamp < a.endTime) revert AuctionStillRunning` · `ShapeAuctionHouse.sol:205-206` · `settle` requires the auction to have received a bid and to have actually ended. `settle` is now `nonReentrant` too (see G-37); the guard is not load-bearing today since `settle` calls nothing external, but it holds the same rule on both auction-closing paths.

#### G-41
`if (!a.settled) revert AuctionStillRunning` / `if (a.lotClaimed) revert LotAlreadyClaimed` · `ShapeAuctionHouse.sol:218-219` · `claimLot` requires settlement and blocks a second claim (see I-10).

#### G-42
`if (msg.sender != recipient) revert NotLotRecipient(auctionId, msg.sender)` · `ShapeAuctionHouse.sol:222` · Only the winner (or the seller of an unsold, cancelled auction) may claim the lot.

#### G-43
`if (msg.sender == a.highestBidder) revert NothingToWithdraw` · `ShapeAuctionHouse.sol:236` · The standing leader's cards are the live bid and cannot be withdrawn early.

#### G-44
`if (!a.settled) revert AuctionStillRunning` / `if (msg.sender != a.seller) revert NothingToWithdraw` · `ShapeAuctionHouse.sol:245-246` · Proceeds are seller-only and only after settlement.

#### G-45
`if (a.seller == address(0)) revert AuctionNotFound(auctionId)` · `ShapeAuctionHouse.sol:287` · An auction struct with a zero seller was never created.

#### G-46
`if (held.length + n > MAX_CARDS_PER_BID) revert TooManyCards(...)` · `ShapeCardEscrow.sol:61` · Bounds a bidder's card-side escrow (see I-7).

#### G-47
`if (value == 0) revert WorthlessCard(id)` · `ShapeCardEscrow.sol:65` · Rejects a Black (zero-backing) Shape from being escrowed as bid value.

#### G-48
`if (backingWei % Denominations.UNIT != 0) revert NotAUnitMultiple(backingWei)` · `ShapeCardEscrow.sol:77,200` · An ETH-side bid amount, and any amount asked of `cardsFor`, must be a whole multiple of the 0.01 ETH unit.

#### G-49
`if (msg.value != expected) revert IncorrectPayment(expected, msg.value)` · `ShapeCardEscrow.sol:80` · The ETH sent for an ETH-backed bid must exactly cover backing plus the Shapes mint fee.

#### G-50
`if (cardIds.length == 0 && ethBackingWei == 0) revert EmptyBid()` · `ShapeCardEscrow.sol:116` · A bid must carry cards or ETH.

#### G-51
`if (ethBackingWei == 0 && msg.value != 0) revert IncorrectPayment(0, msg.value)` · `ShapeCardEscrow.sol:118` · Prevents ETH sent alongside a cards-only bid from being stranded with no code path to spend it.

#### G-52
`if (count == 0) revert NothingToWithdraw(auctionId, from)` · `ShapeCardEscrow.sol:134` · `_release` refuses to run over an empty escrow entry.

#### G-53
`if (msg.sender != shapes || !_minting || from != address(0)) revert UnsolicitedToken(from)` · `ShapeCardEscrow.sol:176` · Only a Shapes mint in progress (`from == address(0)`) may deposit a card into escrow; a plain push is refused.

#### G-54
`if (renderer_.code.length == 0) revert RendererHasNoCode(renderer_)` · `ShapeCollection.sol:40` · The collection's renderer pointer must carry code at construction (immutable thereafter).

#### G-55
`if (denomIndex >= Denominations.COUNT) revert DenominationIndexOutOfRange(denomIndex)` · `ShapeCollection.sol:135` · Bounds a caller-supplied denomination index for the seeded preview card.

---

## 2. Inferred Invariants (Single-Contract)

Inferred invariants are derived from structural analysis of the source code. Each block below cites one of five extraction methods in its `Derivation` field:

- **Δ-pair (delta-pair) analysis** — two or more storage variables in the same function body that change by equal-and-opposite amounts, implying a conservation law.
- **Guard lift** — a `require`/`if-revert` on a storage variable, promoted to a global property by checking every other write site of that variable enforces an equivalent guard.
- **State-machine edge** — a storage variable that transitions through discrete values with no reverse path.
- **Temporal predicate** — a check tied to `block.timestamp`/`block.number` or a stored deadline.
- **NatSpec-stated global property** — a developer-asserted invariant in a comment, confirmed or contradicted by the structural scan.

Each block is classified `Conservation` · `Bound` · `Ratio` · `StateMachine` · `Temporal`.

---

#### I-1

`Conservation` · On-chain: **Yes**

> `redeemableBacking == Σ backingOf(t)` over every live, non-Black Shape `t`.

**Derivation** — guard-lift + write-sites: `redeemableBacking` has exactly four write sites — `Shapes.sol:468` (`+= backing` in `_mintBatch`), `:542` (`-= amountWei` in `_redeemTo`), `:564` (`-= totalWei` in `_redeemBatchTo`), `:1049` (`-= APEX_BACKING` in `sacrifice`) — each paired in the same function with the token-existence change it represents (mint credits exactly the backing of the tokens it creates; redemption debits exactly the summed backing of the tokens it destroys; sacrifice debits exactly the one apex token it zeroes). `compose`/`split`/`decompose` touch no write site of `redeemableBacking`, consistent with their own backing-conservation guarantees (I-11, I-12). Also stated in NatSpec, `Shapes.sol:55-57`.

**If violated** — the reserve counter would understate or overstate the ETH actually owed, corrupting E-1's solvency check.

---

#### I-2

`Bound` · On-chain: **Yes**

> `feeBps ∈ [0, 10000]` (0%–100%).

**Derivation** — guard-lift: `require(feeBps_ <= BPS_DENOMINATOR, "fee exceeds 100%")` (`Shapes.sol:242`) is the sole write site, since `feeBps` is `immutable` with no setter anywhere in scope.

**If violated** — not reachable; would require a new constructor path.

---

#### I-3

`StateMachine` · On-chain: **Yes**

> `rendererLocked`: `false@constructor → true@Shapes.sol:277`, one-shot, no reverse edge.

**Derivation** — edge: the only write site is `lockRenderer` (`Shapes.sol:277`), itself guarded by `if (rendererLocked) revert RendererIsLocked()` (G-5), so a second lock call reverts rather than toggling.

**If violated** — `setRenderer`/`setCollection` would remain callable after the owner declared presentation permanent.

---

#### I-4

`StateMachine` · On-chain: **Yes**

> `positionResolverLocked`: `false → true@Shapes.sol:333`, one-shot, may lock while the resolver is still zero.

**Derivation** — edge: sole write site `lockPositionResolver` (`Shapes.sol:333`), guarded by G-8.

**If violated** — the resolver pointer could still be redirected after a permanent-lock claim.

---

#### I-6

`StateMachine` · On-chain: **Yes**

> `ShapeData.isBlack`: `false → true@Shapes.sol:1048` per token, one-shot, no path back to `false` for the same token id.

**Derivation** — edge: the only write site setting `isBlack = true` on an existing token is `sacrifice` (`Shapes.sol:1048`); every other write of a `ShapeData` struct (mint, compose-survivor, split-child, decompose-restore) constructs a *fresh* struct literal with `isBlack: false`, which is initialization, not a reset of a previously-Black token — `_requireCallerOwnsLive` (G-15) and `_burnForRedemption`'s Black gate (G-13) together prevent a Black token from ever reaching compose/split/decompose/sacrifice again.

**If violated** — a sacrificed (zero-value) token could become redeemable again, or re-enter recomposition with stale zero-value semantics.

---

#### I-7

`Bound` · On-chain: **Yes**

> A bidder's `_escrow[auctionId][bidder]` array length never exceeds `MAX_CARDS_PER_BID` (64).

**Derivation** — guard-lift: both write sites that grow `held` — `_takeCards` (`ShapeCardEscrow.sol:61`) and `_mintCards` (`ShapeCardEscrow.sol:84-86`) — check `held.length + n > MAX_CARDS_PER_BID` before pushing; the only other write site, `_release` (`ShapeCardEscrow.sol:137`), deletes the array entirely rather than growing it.

**If violated** — `withdraw`/`claimProceeds` could face an unbounded loop over `held`, though the cap makes this unreachable.

---

#### I-8

`Bound` · On-chain: **Yes**

> `Auction.highestBidder != Auction.seller`, always, for every auction.

**Derivation** — guard-lift: the sole write site of `highestBidder` is `bid` (`ShapeAuctionHouse.sol:181`), preceded by `if (msg.sender == a.seller) revert SellerCannotBid()` (`ShapeAuctionHouse.sol:163`, G-36).

**If violated** — a seller could become its own auction's winner and claim its own lot back while holding the winning cards.

**Note** — the contract's own NatSpec (`ShapeAuctionHouse.sol:160-162`) states this is a floor-setting deterrent, not a complete one: a seller controlling a second address defeats it economically. That is accepted design, not a code gap in this invariant.

---

#### I-9

`StateMachine` · On-chain: **Yes**

> `Auction.settled`: `false → true`, one-shot, no reverse edge.

**Derivation** — edge: two write sites, `cancelAuction` (`ShapeAuctionHouse.sol:147`) and `settle` (`ShapeAuctionHouse.sol:208`), both preceded by `if (a.settled) revert AuctionAlreadySettled(...)` in every function that reads it as a precondition (G-35, G-37, G-40); both functions are now also `nonReentrant`, so neither write site is reachable from inside another call into the house (G-37).

**If violated** — `bid` could land on a closed auction, or an auction could be both cancelled and settled.

---

#### I-10

`StateMachine` · On-chain: **Yes**

> `Auction.lotClaimed`: `false → true@ShapeAuctionHouse.sol:224`, one-shot.

**Derivation** — edge: sole write site `claimLot` (`ShapeAuctionHouse.sol:224`), guarded by G-41; state is set before the `IERC721.transferFrom` interaction, so a lot collection that calls back finds nothing left to claim twice.

**If violated** — the lot could be transferred out of the house more than once.

---

#### I-11

`Conservation` · On-chain: **Yes**

> `backingOf(survivor_after compose) == Σ backingOf(survivor_before, burn₁, …, burnₙ)`.

**Derivation** — Δ-pair: `acc.total` accumulates `Denominations.amountAt(oldIndex)` for the survivor (`Shapes.sol:698`) and `Denominations.amountAt(b.denomIndex)` for each burned input (`Shapes.sol:666`) before the loop completes; `uint256 newIndex = Denominations.requireIndexOf(acc.total)` (`Shapes.sol:745`) then `s.denomIndex = uint8(newIndex)` (`Shapes.sol:759`) — so `backingOf(survivor_after) = Denominations.amountAt(newIndex) = acc.total` exactly.

**If violated** — a compose could mint or destroy backing without moving ETH, breaking E-1's assumption that compose is reserve-neutral.

---

#### I-12

`Conservation` · On-chain: **Yes**

> `Σ backingOf(children of a split) == backingOf(parent_before)`.

**Derivation** — guard-lift: `_requireSplitSumMatches` (`Shapes.sol:816-822`, G-19) requires `Σ Denominations.amountAt(outDenoms[i]) == parentBacking` before any child is minted or the parent is burned.

**If violated** — a split could mint children whose combined backing diverges from the parent's, again breaking E-1.

---

#### I-13

`Conservation` · On-chain: **Yes**

> `Σ give[i]` (per-child origin allocation) `== originCount` of the parent being split, exactly.

**Derivation** — guard-lift + runtime assertion: `_allocateSplitOrigins` (`Shapes.sol:827-843`) fills each child's capacity from `remaining` in listed order and ends with `assert(remaining == 0)` — an executable check, not only a code-review inference.

**If violated** — origin credits could be created or lost across a split, corrupting E-2.

---

#### I-14

`Conservation` · On-chain: **Yes**

> `survivor.originCount_after compose == Σ originCount(survivor_before, burn₁, …, burnₙ)`.

**Derivation** — Δ-pair: `acc.origins` accumulates `s.originCount` (`Shapes.sol:699`) and each `b.originCount` (`Shapes.sol:667`); `s.originCount = uint32(acc.origins)` (`Shapes.sol:760`) is the only write, with no other term added or subtracted.

**If violated** — origin credits could be created or destroyed by composing, corrupting E-2.

---

#### I-15

`Temporal` · On-chain: **Yes**

> `Auction.endTime`, once nonzero, is monotonically non-decreasing — it only ever moves forward.

**Derivation** — temporal predicate: the sole write site is `bid` (`ShapeAuctionHouse.sol:185-189`) — `endTime == 0` sets it to `block.timestamp + duration` (first bid starts the clock); otherwise it only advances further when `block.timestamp + extensionWindow > endTime`. No write site decreases `endTime` or resets it to zero.

**If violated** — an auction's deadline could be pulled earlier or reset, letting a late bidder be shut out unfairly or the clock restarted indefinitely.

---

## 3. Inferred Invariants (Cross-Contract)

Trust assumptions that span contract boundaries. Each block cites both caller-side and callee-side code, both inside the scope files.

---

#### X-1

On-chain: **Yes**

> `ShapeCardEscrow._takeCards` assumes `IShapes(shapes).backingOf(id)` returns the token's exact redeemable ETH, and returns `0` if and only if the token is Black — used to reject a Black card as bid value.

**Caller side** — `ShapeCardEscrow.sol:64-65` — `uint256 value = IShapes(shapes).backingOf(id); if (value == 0) revert WorthlessCard(id);`

**Callee side** — `Shapes.sol:1083-1087` — `backingOf` returns `d.isBlack ? 0 : Denominations.amountAt(d.denomIndex)`; `d.isBlack`'s only write site is `sacrifice` (I-6), and `Denominations.amountAt` never returns 0 for a valid index — so the zero-iff-Black assumption holds for every reachable state.

**If violated** — a live, non-Black token with zero backing (impossible under the current denomination ladder) could be escrowed as if worthless, or a Black token could be smuggled in as if valuable.

---

#### X-2

On-chain: **Yes**

> `ShapeCardEscrow._mintCards` assumes `IShapes(shapes).mintFeeFor(amount)` is exactly what `Shapes._mintBatch` itself will require as payment for the same `amount`, so the escrow's precomputed `cost` (`ShapeCardEscrow.sol:93`) never diverges from `Shapes`'s own `IncorrectPayment` check.

**Caller side** — `ShapeCardEscrow.sol:93,99` — `uint256 cost = (amount + IShapes(shapes).mintFeeFor(amount)) * count;` then `IShapes(shapes).mintBatchTo{value: cost}(amount, count, address(this));`

**Callee side** — `Shapes.sol:257-259,439-440` — `mintFeeFor` is `(amountWei * feeBps) / BPS_DENOMINATOR`, a pure function of the immutable `feeBps`; `_mintBatch` computes and checks against the identical function, so both call sites can never disagree.

**If violated** — not reachable without a second, divergent fee computation being introduced in one of the two call sites.

---

#### X-3

On-chain: **No**

> `ShapeLens.previewCompose`/`previewSplit` assume the `GeometrySampling`, `ComposeCompute` and `InkGenes` library addresses linked into `ShapeLens`'s own bytecode are bit-identical to the ones linked into `Shapes`'s bytecode, so a preview is guaranteed to match the real `compose`/`split` outcome.

**Caller side** — `ShapeLens.sol:15-19` (NatSpec) states this bit-identity as the contract's entire premise; `ShapeLens.sol:156-172` and `:157-172` call `InkGenes.center`/`ComposeCompute.composeSampleAndGene` exactly as `Shapes._compose` does (`Shapes.sol:747-756`).

**Callee side** — `Shapes.sol` and `ShapeLens.sol` are each compiled and linked independently; nothing in either contract's constructor, storage or any function records or checks the other's linked library addresses. Forge resolves each contract's library links at that contract's own build/deploy time (per `GeometrySampling.sol:16-20`, `InkGenes.sol:12-15`).

**If violated (i.e., the gap is exploited or simply mis-deployed)** — a `ShapeLens` built from a different commit, or with any of the three libraries redeployed, would silently return a `previewCompose`/`previewSplit`/`shapeState` result that diverges from what `Shapes` itself would produce or has stored — with no revert, no event, and no on-chain signal that the mismatch exists.

---

## 4. Economic Invariants

Higher-order properties derived from combinations of §2 and §3 invariants.

---

#### E-1

On-chain: **Yes** (stated as `>=`, not `==`)

> `address(this).balance >= redeemableBacking()`, the protocol's stated reserve invariant (`Shapes.sol:55-57`; SECURITY.md).

**Follows from** — I-1 (`redeemableBacking == Σ backingOf(live tokens)`) + G-9 (exact mint payment: `msg.value == backing + fees`, with `fees` forwarded out in the same call at `Shapes.sol:481-489`, before any `_safeMint` receiver callback runs) + the checks-effects-interactions ordering on every ETH-out path (`redeemableBacking`/`sacrificedBacking` decremented at `Shapes.sol:542`/`564`/`1049` strictly before the paired `_sendEth` call at `Shapes.sol:545`/`566`/`1057`).

**If violated** — a redemption could pay out more ETH than the contract holds, or a shortfall could go undetected; SECURITY.md reports this held under 25,600 fuzzed hostile-actor calls including reentrant, ETH-rejecting and token-rejecting counterparties. Because the stated relation is `>=`, forced ETH (`selfdestruct`, coinbase, pre-deploy funding) can only ever create untouchable surplus, never a shortfall — no code path reads raw `address(this).balance` for accounting.

---

#### E-2

On-chain: **Yes**

> Total origin credits in circulation are conserved: `Σ originCountOf(live tokens) + Σ originCount(inputs held in un-decomposed ComposeRecords) == totalMinted` (every `ShapeMinted` always carries `originCount == 1`, `IShapes.sol:24-29`), decreasing only through `redeem`/`redeemBatch`/`burn`, which read and discard a token's `originCount` immediately before deleting it (`Shapes.sol:584`).

**Follows from** — I-13 (split conserves origins exactly, runtime-asserted) + I-14 (compose conserves origins exactly) + `decompose`'s verbatim restoration of each burned input's stored `originCount` with no arithmetic (`Shapes.sol:1006-1010`).

**If violated** — the `Formation`/`Complete` metadata trait and `sacrifice`'s apex-completeness gate (G-21, which checks `originCount == unitsAt(APEX_INDEX)`) could be satisfied or denied incorrectly, though no ETH value is at stake since origin count has no direct economic weight beyond gating `sacrifice`.

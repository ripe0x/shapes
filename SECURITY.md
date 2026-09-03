# Shapes — adversarial review

An independent adversarial review was run against the contracts after implementation, with a
mandate to construct working exploits rather than to read sympathetically. Everything below
that is marked *confirmed* was demonstrated with an executable Foundry test.

**Headline: no path was found that removes redeemable ETH without either burning the corresponding
token for its exact current value or performing the explicit 100 ETH burnBacking that first changes
an apex Complete to zero value.** The reserve invariant held under every attack attempted, including
25,600 hostile-actor fuzz calls with reentrant, ETH-rejecting and token-rejecting
counterparties.

---

## Assets sent to the auction house unasked

`ShapeAuctionHouse` refuses ERC721s that arrive through `safeTransferFrom`: `onERC721Received`
returns the magic value only for a Shape, only while the house's own bid path is minting, and only
when `from` is the zero address, so only a mint can land. A plain `transferFrom` calls no receiver
hook and cannot be refused by any contract, so a Shape can still be pushed into the house by its
owner. It is then held with no escrow entry naming it and no function that releases it.

This is accepted, not fixed. The alternatives are worse: teaching `Shapes` about the house couples
the token to a contract it otherwise knows nothing about, and a recovery function is an
administrative path into a contract holding other people's redeemable cards, which is the one
thing this house does not have. The loss is confined to whoever pushed the token, is entirely
self-inflicted, and mirrors how the reserve invariant already treats ETH forced in by paths that
bypass `receive`: stated as an inequality and left permanently inaccessible.

## The threat model

Shapes holds user ETH and has no administrator with any power over the reserve. A separate,
transferable admin can administer presentation (renderer plus collection metadata, locked
together), independently lockable positions and market pointers, the destination of future mint
fee withdrawals, and the mint fee amount itself within a compile-time cap of one denomination unit (`unit()`). It
cannot reach backing, redemption, already-accrued fees, or token ownership, and has no path to
read or change `mintStart`, the immutable timestamp that gates public minting. Shape #0 represents
backed collectible ownership exposed through `owner()`, but its holder has no
administrative authority. Neither configuration domain is read
by a reserve path. The immutable `artist()` and one-time signature stored directly in Shapes are
attribution only and are never read for authorization, fees, ownership or reserve accounting.
The linked `EIP712Signature` library is stateless verification code, not an attribution contract.
`RecompositionOps` and `AdminOps` are linked libraries: stateless at their own address, ownerless, holding no
ETH and no admin surface. `ShapeAuctionHouse` and the `ShapeCardEscrow` base it inherits hold
escrowed cards and lots, not the reserve; `Shapes` has no knowledge of either. There is one
thing that must never happen: a holder unable to redeem a live Shape for exactly the ETH it
wraps. Everything else is secondary.

Formally, at all times:

```
address(this).balance >= redeemableBacking() + pendingFees()
redeemableBacking()        == sum of backingOf(t) over all live t
backingOf(t)               == valueOf(t)
```

Both are asserted as stateful invariants over fuzzed sequences of mint, batch mint, transfer,
redeem, batch redeem, forced-ether injection and raw calldata pokes, plus a third invariant
that snapshots state, redeems *every* live Shape in turn, and asserts each pays out in full.

---

## Findings and what was done

### 1. Seed grinding — identity enumeration fixed, ordinal grinding accepted

*Confirmed.* The original entropy root included `msg.sender`, the recipient and the quantity.
Every other input is knowable before the transaction is sent, so a minter could enumerate
candidate recipients off chain, at zero cost, until the artwork suited them. The reviewer
selected a specific 100 ETH composition (solid triangle, 270°, p ≈ 3.5%) in **85 free tries**.
At 50 and 100 ETH a card is one or two modules, so trait selection was effectively total.

**Fix (partial):** all *identity* inputs removed from the root. The seed now derives only from
`prevrandao`, the prior blockhash, block number, timestamp, chain id, the contract address and
the token id. Regression tests `test_SeedIsIndependentOfMinterAndRecipient`,
`test_SeedIsIndependentOfQuantity` and `test_EnumeratingRecipientsCannotChangeTheArtwork` (64
recipients, identical output) pin that the recipient no longer moves the seed.

**Residual — grinding is not one-attempt-per-block; it is one transaction.** The root folds
`firstTokenId`, which equals `totalMinted`, and a minter can advance `totalMinted` permanently
inside a single transaction by minting throwaway dust Shapes and redeeming them in the same call:
the backing returns in full, only the mint fee is spent. Since every other root input is fixed
within a block, the mint ordinal is a free knob, and hundreds of candidates fit in one block. The
per-token seed also keys on `tokenId`, the same purchasable value. So the ~3.5% trait above is
reachable in one transaction at roughly the mint fee times a few dozen dust mints; at `mintFee == 0`
only gas is spent. This is accepted, not mitigated: the seed has no economic effect — redemption
value is fixed by denomination, and every Shape of a denomination redeems for the same ETH
regardless of appearance. Trait scarcity is best-effort, not enforced. Commit-reveal would close
it (SPEC.md D3e) and is deliberately not built.

**Ink Genes (SPEC.md D17) inherit this residual unchanged.** The gene is drawn from the same
per-mint seed at mint time only (`InkGenes.geneAtMint`), so it is grindable exactly the way
artwork traits are, at the same one-transaction cost. The four extreme genes (`Void`, `Faint`,
`Rich`, `Solid`) are only ever drawn on a dust (0.01 ETH) mint; every other denomination draws
exclusively from the narrow `{Sparse, Murk, Dense}` band, so a grinder chasing an extreme gene
grinds dust mints — the cheapest possible per candidate. Composing, decomposing and restoring a
Shape never consume fresh randomness for the gene (entropy-at-mint-only, D17), so none of those
paths reopen grinding once a token exists.

### 2. Renderer address never checked for code — fixed

*Confirmed.* Deploying with an EOA or an empty address as the renderer succeeded, producing a
contract that minted and redeemed normally but whose `tokenURI` reverted for every token,
permanently, with no setter. The constructor now requires `renderer_.code.length != 0`, and
the deploy script smoke-tests the renderer through `IShapeRenderer` and asserts every
immutable landed as intended before reporting success.

### 3. A Shape could be stranded in the contract's own custody — fixed

*Confirmed.* `safeTransferFrom` to `address(shapes)` already failed on the receiver check, but
plain `transferFrom` succeeded. Since the contract can never be `msg.sender`, such a token
could never be redeemed: its backing was stranded while `redeemableBacking` went on counting it.
`_update` now rejects `to == address(this)`, closing the transfer path and the mint path.

### 4. Documentation overclaimed the reentrancy guard — fixed

*Confirmed.* The spec said every state-changing external function was guarded. The inherited
ERC721 transfer and approval functions are not, and should not be — they move no ETH. But the
consequence is real and was undocumented: a receiver can redeem a Shape from inside its own
`onERC721Received` during a `safeTransferFrom`. Accounting stays exact (verified: backing,
supply and balance all correct afterwards), so this is a composability hazard rather than a
solvency one. Now documented in SPEC.md D12 and in the `Shapes` contract header.

### 5. Read-only reentrancy window during batch mint — mitigated and documented

*Confirmed.* Inside the first `onERC721Received` of a four-token batch, `totalSupply` read 4
while one token existed, and the contract balance included fees not yet forwarded. Nothing in
`Shapes` reads these and write reentrancy is blocked, so this is integrator-facing only. Mint
fees now accrue to `pendingFees` in the same effects block as the rest of the batch's accounting,
with no external call in the mint path, so
`address(this).balance == redeemableBacking() + pendingFees()` holds during every callback
(`test_ReserveIsConsistentInsideReceiverCallback`). The `totalSupply` skew is inherent to batched
`_safeMint` and is documented at the call site.

### 6. A reverting fee recipient disables minting until admin redirects fees — fixed

*Confirmed against the original push design.* A recipient that reverted on receipt made every
`mint` revert while it remained the target. Redemption was unaffected and no funds were at risk,
but minting itself could stall.

**Fix chosen:** mint fees no longer call out to the recipient at all. They accrue to whichever
recipient `feeRecipient()` names at the time, tracked per recipient (`feesOwedTo`) and summed in
`pendingFees()`, in the mint's own effects block, and only `withdrawFees(recipient)` — a separate,
permissionless, `nonReentrant` call — forwards that recipient's own balance to it. A reverting
recipient now blocks only its own `withdrawFees` call; minting and every other recipient's
withdrawal are unaffected. If `withdrawFees` fails, the balance it targeted is untouched (the
whole call reverts), and `setFeeRecipient` only points future accrual elsewhere — it does not move
what is already owed to the reverting recipient, which stays stuck until that recipient can accept
ETH. The deploy script proves the initial recipient accepts a plain ETH transfer by simulating one
before deploying, rather than requiring an EOA; a contract that accepts plain ETH (a 0xSplits
wallet, for example) passes the same guard an EOA does. Renouncing admin
freezes the final recipient, so its ability to accept ETH should be confirmed first, though a
reverting recipient at that point only strands its own balance, never anyone else's, and never the
reserve.

### 7. No batch size cap — accepted, documented

*Informational.* Measured at ~52k gas per token minted and ~7.9k per token redeemed, so
`mintBatch(0.01 ether, 500, …)` costs about 26.1M gas and approaches the block limit. This is
self-inflicted only: no third party can force anyone into a large batch. Left uncapped rather
than introducing an arbitrary constant; the practical ceiling is roughly 500 mints or 3,500
redemptions per transaction.

### 8. Approval semantics — verified consistent, clarified

*Informational.* `redeem` is owner-only. An approved operator cannot call it, but can always
`transferFrom` to itself and redeem in the same transaction, so approving an operator is
economically equivalent to granting it redemption rights. The owner-only check narrows nothing
in practice; it keeps the payout destination unambiguous. Now stated in the `redeem` NatSpec
so nobody mistakes it for a protection it is not.

### 9. Event ordering — informational

All `ShapeMinted` events for a batch are emitted before any ERC721 `Transfer` (and `Decomposed`/
`Split` are emitted before their outputs' `Transfer`s). A pure log-ordered indexer that resolves
ownership on the lifecycle event, before the `Transfer`, sees a not-yet-existing token; a
read-based indexer is unaffected. Kept as-is (the effects-before-interaction ordering); documented.

### 10. External audit — no Critical/High; three low findings fixed

An independent AI auditor ran the refreshed `AUDIT_PROMPT_v2.md` against `main`. No Critical or High
was found; no path removes ETH without the corresponding burn, forges origins, forges Complete, or
bypasses Black terminality. Three low findings were fixed and pinned with regression tests:

- **The split preview reported success for a Black Shape** while the split itself reverts `TokenIsBlack`. The preview is now `previewSplit` on `Shapes`, which shares the gate with `split` itself.
  The preview now rejects Black tokens too (`test_SimulateDecomposeRejectsBlackToMatchDecompose`).
- **`setRenderer` changed every token's metadata without an ERC-4906 signal.** It now emits
  `BatchMetadataUpdate(0, totalMinted - 1)` (ids start at 0) so marketplaces refresh
  (`test_SetRendererEmitsBatchMetadataUpdate`).
- **`redeemTo`/`redeemBatchTo` to `address(0)` burned the payout.** They now revert
  `InvalidRecipient` (`test_RedeemToRejectsZeroRecipient`). `decomposeTo`/`splitTo` to the zero
  address already reverted through `_safeMint`.

Accepted from the same audit: `setRenderer` validates the renderer by ERC165 claim and code
presence but does not smoke-call it (owner-controlled; the deploy script already smoke-tests the
renderer, and a hostile renderer is cosmetic only — see the Renderer replaceability row); the
`grammarHash` geometry version is therefore only frozen once `lockPresentation` is called; and batch
sizes stay uncapped (self-inflicted, per finding #7).

### 11. A fee-recipient-seller could steal a bidder's escrowed cards — corrected from low to theft, fixed

A delta audit over the changes made since finding 10 (no Critical or High at HEAD) re-examined a
bug originally filed as a low, "a bid can be recorded on an already-settled auction," framed as
mostly self-harm. It was not: against `ShapeAuctionHouse`, a contract that is both the `Shapes`
fee recipient and the seller of one of its own auctions could steal a bidder's escrowed cards.

*Confirmed, with a working proof of concept, against the original push-based fee design.* The
path: the fee-recipient-seller lists a lot; a victim calls `bid`; `_takeBid` minted the victim's
cards through `Shapes.mintBatchTo`, which paid the mint fee to the fee recipient and handed it
control inside its own `receive()`; from there the seller called `cancelAuction`, which passed —
the caller was the seller, there was no highest bidder yet, and the auction was not settled — and
set `settled = true`; the outer `bid` call resumed and recorded the victim as `highestBidder`
regardless; the seller then called `claimProceeds`, which released the highest bidder's escrow to
the seller. The victim could not `withdraw`, because `withdraw` refuses the standing leader.

**Fix, in two layers.** First, `settle` and `cancelAuction` were given `nonReentrant`, so the
protection became a contract-level invariant rather than the inline re-read of `a.settled` in
`bid`; that re-check in `bid` was retained as belt and braces. Second, and structurally: mint fees
no longer call out to the recipient at all. `_takeBid`'s escrow mint accrues the fee to
`Shapes.pendingFees` in its own effects block, so `bid` no longer hands control to any external
contract mid-call — the callback window this finding exploited does not exist. The only remaining
path into `cancelAuction` from a fee-recipient-seller's callback is through `Shapes.withdrawFees`,
called separately and after a bid, by which point `cancelAuction`'s own guard
(`a.highestBidder != address(0)`) rejects it: `withdrawFees` reverts along with the reentrant
attempt, and the bidder's escrow is untouched. `test_L1_AFeeRecipientSellerCannotStealAnEscrowedBid`
and `test_L1_ABidCannotBeRecordedOnAnAuctionCancelledMidCall` now pin these two facts directly: the
callback never fires during `bid`, and the same attempt from `withdrawFees` fails once a bid
exists. The `nonReentrant` guards on `cancelAuction` and `settle` remain as defense in depth
(`test/AuctionSecurity.t.sol`).

### 12. `setFeeRecipient` could redirect already-accrued fees — fixed

*Confirmed against the single shared `pendingFees` counter.* `withdrawFees` read `feeRecipient` at
withdrawal time rather than at accrual time, so an admin could call `setFeeRecipient(attacker)`
then `withdrawFees()` and take every fee that accrued while a different recipient was configured.
`IAdminControl` documented the opposite in two places: the admin "cannot reach ... accrued fees",
and `setFeeRecipient`'s own doc said already-accrued fees are unaffected. Real ETH only, never
backing; bounded by the pending balance at the time of the redirect; requires the admin key.

**Fix.** Fee accrual is now per recipient: `feesOwed[recipient]` credits whoever `feeRecipient()`
names at the moment a batch mint charges its fee, and `pendingFees()` is the running sum across
every recipient. `withdrawFees(recipient)` pays only `recipient`'s own balance and zeroes only
that entry. `setFeeRecipient` still writes one pointer for future accrual and moves nothing:
fees already credited to the outgoing recipient stay owed to it, withdrawable by anyone via
`withdrawFees`, whether or not it is still the configured `feeRecipient`. This also closes the
stranding case from finding #6's caveat: a later recipient's balance is no longer held hostage by
an earlier reverting one. `test/audit/FeeAccounting.t.sol` pins the closure directly
(`test_SetFeeRecipientCannotRedirectAlreadyAccruedFees`,
`test_EachRecipientWithdrawsExactlyItsOwnShare`,
`test_RevertingRecipientBlocksOnlyItsOwnWithdrawal`), and `test/Invariants.t.sol`'s stateful suite
drives `setFeeRecipient` and `withdrawFees` against two known recipients, asserting
`sum(feesOwedTo(r)) == pendingFees()` on every run. See DECISIONS.md D-43.

---

## Verified safe

| Axis | Result |
|---|---|
| Reentrancy | `mint`, `mintBatch`, `redeem`, `burn`, `redeemBatch`, `redeemTo`, `redeemBatchTo`, `compose`, `decompose`, `decomposeTo`, `split`, `splitTo`, `burnBacking`, and `withdrawFees` are guarded; `_payRedemption`, `withdrawFees`'s fee transfer and the backing burn all execute inside the guard, after all effects. The recipient-directed `*To` variants delegate to the same private implementations as their owner-directed forms, so the destination is parameterised but checks-effects-interactions and the guard are identical. The mint path makes no external call beyond `_safeMint`, so reentry attempts from ERC721 callbacks and the redemption payout callback revert; a reentrant attempt from `withdrawFees`'s fee callback likewise reverts. The invariant suite drives the `*To` paths against reverting-ETH, non-receiver and reentrant recipients. |
| Batch mint accounting | `firstTokenId` and `totalMinted` are set before any `_safeMint`, so ids cannot collide even under hypothetical reentry. Seeds distinct within and across same-block batches. |
| Mint-start gate | `mintStart` is set once in the constructor and stored `immutable`; no admin path can read or change it. `_mintBatch` reverts `MintNotOpen()` while `block.timestamp < mintStart`, which covers `mint`, `mintTo`, `mintBatch`, `mintBatchTo`, and the ETH-backed auction bids that mint cards through `ShapeCardEscrow._mintCards` calling `mintBatchTo`. The constructor mint of Shape #0 is unconditional and unaffected, so its transfer, auction listing and redemption all work before `mintStart`. |
| Batch redeem accounting | Duplicate ids revert on the second `_requireOwned`; mixed owners revert; no partial settlement exists — one atomic transaction. |
| Reserve solvency | Three value-bearing `CALL`s exist: `_payRedemption` (reached only after a redemption or draft ERC-8060 burn), `withdrawFees(recipient)`'s transfer (out of that recipient's own `feesOwedTo` balance, decremented before the call, never counted as backing), and `burnBacking` (fixed 100 ETH to an unspendable address, after `redeemableBacking` is decremented). The `*To` variants direct `_payRedemption` and `_safeMint` to an arbitrary recipient but decrement backing before the call, so the same accounting holds. Proven by stateful invariants: `balance >= redeemableBacking + pendingFees`, `sum(feesOwedTo(r)) == pendingFees()` across every recipient a fee has accrued to, backing conservation net of burnBacking, `valueOf == backingOf`, `burnedBacking == 100 ether * blackShapeCount`, and a full drain of every live Shape. |
| ETH out without a burn | Full external surface enumerated, including every inherited OpenZeppelin member. Admin can select the recipient of fees entering in future mint calls, but cannot withdraw ETH already held by Shapes or alter the reserve. Shape #0 ownership grants no permissions. External-library delegate targets are fixed in bytecode and cannot be selected by users or admin; there is no `selfdestruct` or inline assembly in `Shapes.sol`. |
| Administrative isolation | The renderer and collection are called only by metadata reads. Core state-changing operations never call the positions or market target; only `positionOf` queries positions, with bounded gas and failure-to-zero behavior. Reverting targets are regression-tested against the full token lifecycle. `setFeeRecipient` changes one address used for future fee withdrawals; `setMintFee` changes the fee amount within the compile-time cap of one denomination unit. Neither can move already-accrued fees or touch backing, redemption or token ownership. |
| Draft ERC-8060 | `valueOf` exactly aliases `backingOf`; owner-only `burn` destroys a normal Shape for its exact value or a Black Shape for zero. Structural burns never settle ETH. The current draft interface ID is advertised through ERC-165; the proposal is not final and may change. |
| Core state views | `exists` is a non-reverting read of ERC-721 liveness and writes no state. `denomIndexOf` returns the already-stored 0..8 index for a live token and reverts for a nonexistent id; Black remains index 8 even though `backingOf == valueOf == 0`. Neither view calls the renderer, collection, positions or market target. |
| Overflow / truncation | No `unchecked` in `Shapes.sol`. `uint8(denomIndex)` is safe by construction — the index originates only from `Denominations.indexOf`, whose range is 0–8. Decrements are each paired with a successful burn. |
| Denomination validation | Exact `==` comparisons, no ranges, no rounding, no fallthrough. Because the *index* is stored rather than a wei amount, an off-ladder backing value is unrepresentable in storage. |
| Forced ETH | Surplus from `selfdestruct`, coinbase or pre-deploy funding leaves `redeemableBacking` untouched, cannot be extracted, and cannot corrupt accounting — no function reads `address(this).balance`. |
| DoS against the reserve | An owner that rejects ETH causes `_payRedemption` to revert, reverting the whole redemption: the token is never burned and the backing is never lost. |
| Renderer replaceability | The renderer itself is pure: no state, no owner, no setter, verified stable across block number, timestamp, prevrandao, base fee and chain id. On `Shapes` the renderer pointer is admin-replaceable until `lockPresentation`, and both the constructor and `setRenderer` refuse a codeless address. The pointer is read only by `tokenURI`, so a replacement changes appearance only, never backing, redemption or ownership, and after locking it is fixed forever. |
| Positions and market pointers | Both start empty and unlocked, may be replaced or cleared by admin, and may be locked independently at any value including zero. A nonzero target must contain code and answer ERC-165 for the interface its reader calls. Only `positionOf` queries positions; it forwards a fixed gas cap and converts reverts, out-of-gas and malformed results to zero. A hostile target can mislead discovery but cannot affect Shapes state or reserve behavior. The market target is never called by Shapes. |
| Contract ownership | One live Shape is the owner token, tracked by `_ownerToken` and starting as #0, atomically backed and minted to the deployer. `owner()` follows its current holder, returning zero once it is redeemed or burned. Compose moves it from a burned donor to the survivor; decompose restores it to that input; split gives it to the first output; `decomposeTo`/`splitTo` make the recipient the collection owner. No authorization check reads `owner()` or `ownerToken()`. |
| Artist attribution | `artist()` is constructor-set and immutable. Shapes directly stores one nonzero `artistReleaseHash` and the raw `artistSignature`; zero release hash is the unsigned sentinel. The EIP-712 digest binds chain id, exact Shapes address, artist and release hash. The stateless linked `EIP712Signature` library checks canonical ECDSA first so an EIP-7702 delegated EOA can still sign, then ERC-1271 for contract wallets. Anyone may relay, but nobody can replace or clear a successful attestation. For ERC-1271, the permanent proof is validity at execution time because wallet policy may later change. Attribution grants no artist-authorized call. |
| Linked libraries | `RecompositionOps`, `AdminOps`, `GeometrySampling`, `ComposeCompute`, `InkGenes`, `CopyValidation` and `EIP712Signature` are external libraries; forge resolves and deploys each at build/deploy time and bakes its address into the linking contract's bytecode. `CopyValidation` links into `ShapeCollection`; the rest link into `Shapes`. There is no setter for a library address, so their logic cannot be redirected after deployment. Neither `RecompositionOps` nor `AdminOps` holds authority at its own address: every access check runs in Shapes before it delegates, and neither writes ERC-721 state, moves ETH, or touches the owner token or the admin address. Each receives a pointer to one storage struct and can reach nothing else. |

---

## Standing caveats for anyone deploying this

1. **`feeRecipient` should be an EOA.** A reverting recipient blocks only its own `withdrawFees`
   call; minting and every other recipient's withdrawal are never affected. Redirecting
   `feeRecipient` only starts a new accrual for the new recipient — it does not move the blocked
   recipient's own balance, which stays owed to it, unlost, until it can accept ETH. Renouncing
   admin freezes the current recipient permanently.
2. **The mint fee is bounded, not immutable.** The mainnet initial value is 0.001 ETH per Shape and
   the 1/100 testnet build uses 0.00001 ETH per Shape. Admin may change it afterward via
   `setMintFee`, up to the compile-time cap of one compiled denomination unit (`unit()`). The
   deploy script rejects an initial value above that same cap, matching the constructor's own
   enforcement.
3. **The flat fee changes mint-path economics.** It removes denomination-proportional fee parity.
   Direct high-denomination rerolls cost only one flat fee each, while building the same backing
   from many dust mints pays one fee per dust Shape. This does not affect solvency or redemption,
   but it materially lowers high-tier artwork-reroll cost and must be accepted as a
   collectible-economics choice before mainnet. Admin can raise or lower the fee later via
   `setMintFee`, within the cap; that changes the reroll-cost ratio going forward but never
   backing already minted.
4. **The admin can replace the renderer and edit the metadata copy until presentation is locked.**
   Both are cosmetic powers. The renderer is `view`-only and the copy is read only by metadata
   views; neither can touch ETH, backing, redemption or ownership. A compromised admin could point
   `tokenURI` at a renderer producing misleading or offensive metadata, and could set an offensive
   or misleading prefix/description via `ShapeCollection.setMetadataCopy`, whose authority and lock
   are read live from `Shapes`. Copy is validated on set — a `"`, `\`,
   C0 control byte, or over-length value reverts — so it cannot break or restructure the metadata
   JSON, but it is not HTML-escaped: a marketplace that renders `description` as HTML will display
   admin-supplied markup. The description is shared by token and collection metadata; the immutable
   ERC-721 name supplies the collection name. `lockPresentation` freezes the renderer, the
   collection and the copy together and is one way, so after it none of the three can be changed by
   any admin. Until then, hold admin in a multisig; renouncing admin also freezes all three
   permanently at their last values.
5. **The admin can designate canonical positions and market targets until each is locked.** Either
   pointer can be replaced, cleared or permanently locked at zero independently. A configured
   target may be upgradeable or malicious, but has no authority over Shapes. Canonical does not
   mean exclusive. Transfer admin to the intended custody target before configuration.
6. **The owner token moves, and can end collection ownership permanently.** It is an ordinary
   backed Shape: composing it into another survivor, decomposing the compose that absorbed it, or
   splitting it moves it to the survivor, the original input, or the first output respectively, and
   `decomposeTo`/`splitTo` make the chosen recipient the collection owner. Redeeming or `burn()`ing
   the owner token ends collection ownership permanently: `owner()` returns zero and no token
   inherits. This affects the public ownership signal only, never administration.
7. **Artist attestation is one-time and release-bound.** The deployer remains `artist()` forever,
   even after Shape #0 or admin moves. The artist should verify the final chain, Shapes address,
   attribution address and chosen release hash before signing; a mistaken valid attestation cannot
   be replaced. Losing the artist key before signing leaves the child permanently unsigned but does
   not affect any token or reserve behavior.
8. **ERC-8060 support follows an open draft.** The implemented `valueOf`/`burn` interface and
   ERC-165 ID match the current proposal, but an immutable deployment cannot follow later changes.
9. **Artwork and ink traits are selectable to order in one transaction.** A minter advances the
   mint ordinal (`totalMinted`) by minting and redeeming dust in the same call, so the seed is
   grindable at roughly the mint fee per candidate, hundreds per block — not one attempt per block
   (§1). If trait rarity is intended to carry economic weight, this design is not sufficient — but
   for Shapes it does not, because redemption value is set by denomination alone.
10. **This review is not a substitute for a professional audit** before mainnet deployment with
   real value at risk.

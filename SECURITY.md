# Shapes — adversarial review

An independent adversarial review was run against the contracts after implementation, with a
mandate to construct working exploits rather than to read sympathetically. Everything below
that is marked *confirmed* was demonstrated with an executable Foundry test.

**Headline: no path was found that removes redeemable ETH without either burning the corresponding
token for its exact current value or performing the explicit 100 ETH sacrifice that first changes
an apex Complete to zero value.** The reserve invariant held under every attack attempted, including
25,600 hostile-actor fuzz calls with reentrant, ETH-rejecting and token-rejecting
counterparties.

---

## The threat model

Shapes holds user ETH and has no administrator with any power over the reserve. The transferable
owner can administer two value-inert configuration domains: presentation (renderer plus collection
metadata, locked together) and the independently lockable optional position resolver. None is read
by a reserve path. There is one
thing that must never happen: a holder unable to redeem a live Shape for exactly the ETH it
wraps. Everything else is secondary.

Formally, at all times:

```
address(this).balance >= redeemableBacking()
redeemableBacking()        == sum of backingOf(t) over all live t
backingOf(t)               == valueOf(t)
```

Both are asserted as stateful invariants over fuzzed sequences of mint, batch mint, transfer,
redeem, batch redeem, forced-ether injection and raw calldata pokes, plus a third invariant
that snapshots state, redeems *every* live Shape in turn, and asserts each pays out in full.

---

## Findings and what was done

### 1. Seed grinding — fixed

*Confirmed.* The original entropy root included `msg.sender`, the recipient and the quantity.
Every other input is knowable before the transaction is sent, so a minter could enumerate
candidate recipients off chain, at zero cost, until the artwork suited them. The reviewer
selected a specific 100 ETH composition (solid triangle, 270°, p ≈ 3.5%) in **85 free tries**.
At 50 and 100 ETH a card is one or two modules, so trait selection was effectively total.

**Fix:** all caller-controlled inputs removed from the root. The seed now derives only from
`prevrandao`, the prior blockhash, block number, timestamp, chain id, the contract address and
the token id — matching the construction Art Blocks uses for its own token hashes. Regression
tests `test_SeedIsIndependentOfMinterAndRecipient`, `test_SeedIsIndependentOfQuantity` and
`test_EnumeratingRecipientsCannotChangeTheArtwork` (64 recipients, identical output) pin this.

**Accepted residual:** grinding by minting through a contract that reverts unless the outcome
suits the minter. One attempt per block, gas per attempt. Art Blocks has the same residual.
See SPEC.md D3e for why commit-reveal was rejected.

**Ink Genes (SPEC.md D17) inherit this residual unchanged, with one asymmetry worth stating
explicitly.** The gene is drawn from the same per-mint seed at mint time only (`InkGenes.
geneAtMint`), so it is grindable exactly the way artwork traits are: one attempt per block,
gas per attempt, no new attack surface. The asymmetry is in *reachability*, not in the grind
itself — the four extreme genes (`Void`, `Faint`, `Rich`, `Solid`) are only ever drawn on a
dust (0.01 ETH) mint; every other denomination draws exclusively from the narrow `{Sparse,
Murk, Dense}` band (SPEC.md D17). A grinder chasing an extreme gene therefore must grind dust
mints specifically — cheap per attempt, same one-attempt-per-block ceiling, no larger residual
than the pre-existing artwork-trait grind. Composing, decomposing and restoring a Shape never
consume fresh randomness for the gene (entropy-at-mint-only, D17), so none of those paths reopen
grinding once a token exists. An epoch-batched commit-reveal scheme would close the residual
across all traits, ink included; it remains deferred for the same reasons D3e gives for
artwork.

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
`Shapes` reads these and write reentrancy is blocked, so this is integrator-facing only. Fees
are now forwarded **before** the mint loop, so `address(this).balance == redeemableBacking()` holds
during every callback (`test_ReserveIsConsistentInsideReceiverCallback`). The `totalSupply`
skew is inherent to batched `_safeMint` and is documented at the call site.

### 6. A reverting fee recipient permanently disables minting — accepted, documented

*Confirmed.* Because `feeRecipient` is immutable, a recipient that reverts on receipt makes
every `mint` revert forever. Redemption is unaffected and no funds are at risk — the contract
becomes redeem-only. A pull-based fee escrow would remove this, at the cost of extra surface
area in a contract whose whole argument is that it has almost none.

**Mitigation chosen:** make the mistake hard to make rather than recoverable. The constructor
NatSpec states the requirement in the strongest terms, and the deploy script refuses a
contract fee recipient unless `SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT=true` is set explicitly.
Prefer an EOA.

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

- **`simulateDecompose` reported success for a Black Shape** while `decompose` reverts `TokenIsBlack`.
  The preview now rejects Black tokens too (`test_SimulateDecomposeRejectsBlackToMatchDecompose`).
- **`setRenderer` changed every token's metadata without an ERC-4906 signal.** It now emits
  `BatchMetadataUpdate(1, totalMinted)` so marketplaces refresh
  (`test_SetRendererEmitsBatchMetadataUpdate`).
- **`redeemTo`/`redeemBatchTo` to `address(0)` burned the payout.** They now revert
  `InvalidRecipient` (`test_RedeemToRejectsZeroRecipient`). `decomposeTo`/`splitTo` to the zero
  address already reverted through `_safeMint`.

Accepted from the same audit: `setRenderer` validates the renderer by ERC165 claim and code
presence but does not smoke-call it (owner-controlled; the deploy script already smoke-tests the
renderer, and a hostile renderer is cosmetic only — see the Renderer replaceability row); the
`grammarHash` geometry version is therefore only frozen once `lockRenderer` is called; and batch
sizes stay uncapped (self-inflicted, per finding #7).

---

## Verified safe

| Axis | Result |
|---|---|
| Reentrancy | `mint`, `mintBatch`, `redeem`, `burn`, `redeemBatch`, `redeemTo`, `redeemBatchTo`, `compose`, `decompose`, `decomposeTo`, `split`, `splitTo`, and `sacrifice` are guarded; `_payRedemption`, the fee call and the sacrifice all execute inside the guard, after all effects. The recipient-directed `*To` variants delegate to the same private implementations as their owner-directed forms, so the destination is parameterised but checks-effects-interactions and the guard are identical. Reentry attempts from ERC721 callbacks, the payout callback and the fee callback all revert. The invariant suite drives the `*To` paths against reverting-ETH, non-receiver and reentrant recipients. |
| Batch mint accounting | `firstTokenId` and `totalMinted` are set before any `_safeMint`, so ids cannot collide even under hypothetical reentry. Seeds distinct within and across same-block batches. |
| Batch redeem accounting | Duplicate ids revert on the second `_requireOwned`; mixed owners revert; no partial settlement exists — one atomic transaction. |
| Reserve solvency | Three value-bearing `CALL`s exist: `_payRedemption` (reached only after a redemption or draft ERC-8060 burn), the fee forward (money received in the same call, never counted as backing), and `sacrifice` (fixed 100 ETH to an unspendable address, after `redeemableBacking` is decremented). The `*To` variants direct `_payRedemption` and `_safeMint` to an arbitrary recipient but decrement backing before the call, so the same accounting holds. Proven by stateful invariants: `balance >= redeemableBacking`, backing conservation net of sacrifice, `valueOf == backingOf`, `sacrificedBacking == 100 ether * blackCount`, and a full drain of every live Shape. |
| ETH out without a burn | Full external surface enumerated, including every inherited OpenZeppelin member. `Ownable` is inherited and transferable, but its powers reach only value-inert presentation and position-resolver configuration. No `delegatecall`, no `selfdestruct`, no assembly in `Shapes.sol`. |
| Administrative isolation | The renderer and collection are called only by metadata reads; the resolver is called only by `positionOf`. A reverting resolver is regression-tested against the full token lifecycle and metadata. No owner function reaches ETH or token state. |
| Draft ERC-8060 | `valueOf` exactly aliases `backingOf`; owner-only `burn` destroys a normal Shape for its exact value or a Black Shape for zero. Structural burns never settle ETH. The current draft interface ID is advertised through ERC-165; the proposal is not final and may change. |
| Overflow / truncation | No `unchecked` in `Shapes.sol`. `uint8(denomIndex)` is safe by construction — the index originates only from `Denominations.indexOf`, whose range is 0–8. Decrements are each paired with a successful burn. |
| Denomination validation | Exact `==` comparisons, no ranges, no rounding, no fallthrough. Because the *index* is stored rather than a wei amount, an off-ladder backing value is unrepresentable in storage. |
| Forced ETH | Surplus from `selfdestruct`, coinbase or pre-deploy funding leaves `redeemableBacking` untouched, cannot be extracted, and cannot corrupt accounting — no function reads `address(this).balance`. |
| DoS against the reserve | An owner that rejects ETH causes `_payRedemption` to revert, reverting the whole redemption: the token is never burned and the backing is never lost. |
| Renderer replaceability | The renderer itself is pure: no state, no owner, no setter, verified stable across block number, timestamp, prevrandao, base fee and chain id. On `Shapes` the renderer pointer is owner-replaceable until `lockRenderer`, and both the constructor and `setRenderer` refuse a codeless address. The pointer is read only by `tokenURI`, so a replacement changes appearance only — never backing, redemption or ownership — and after locking it is fixed forever. |
| Position resolver | The resolver starts at zero, may be replaced or cleared by the owner, and may be locked forever at any time including while zero. Its returned address is opaque and unvalidated. It may lie or revert, and its own code may be mutable; those failures affect only `positionOf`. Historical and nonexistent IDs are deliberately delegated without an existence check. |

---

## Standing caveats for anyone deploying this

1. **`feeRecipient` should be an EOA.** It is immutable and a reverting recipient is a
   permanent brick on minting.
2. **The mint fee is immutable.** It is `feeBps` basis points of backing (default 100 = 1%). The
   deploy script's sanity ceiling is 1000 bps (10%); overriding it requires an explicit
   environment variable.
3. **The owner can replace the renderer until it is locked.** This is a cosmetic power — the
   renderer is `view`-only and cannot touch ETH, backing, redemption or ownership — but a
   compromised owner could point `tokenURI` at a renderer producing misleading or offensive
   metadata until `lockRenderer` is called. Hold ownership in a multisig, and lock the renderer
   once the artwork is settled. Locking is one-way and permanent.
4. **The owner can designate the canonical position resolver until it is locked.** The pointer
   can be replaced or cleared before locking, and can be permanently locked at zero. A configured
   resolver is a trust root for position discovery and may itself be upgradeable or malicious, but
   it has no authority over Shapes. Transfer ownership to the intended multisig before configuration.
5. **ERC-8060 support follows an open draft.** The implemented `valueOf`/`burn` interface and
   ERC-165 ID match the current proposal, but an immutable deployment cannot follow later changes.
6. **Artwork traits are grindable at one attempt per block.** If trait rarity is intended to
   carry economic weight, this design is not sufficient — but for Shapes it does not, because
   redemption value is set by denomination alone.
7. **This review is not a substitute for a professional audit** before mainnet deployment with
   real value at risk.

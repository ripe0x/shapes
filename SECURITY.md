# Shapes — adversarial review

An independent adversarial review was run against the contracts after implementation, with a
mandate to construct working exploits rather than to read sympathetically. Everything below
that is marked *confirmed* was demonstrated with an executable Foundry test.

**Headline: no path was found that removes ETH from the contract without burning the
corresponding token.** The reserve invariant held under every attack attempted, including
25,600 hostile-actor fuzz calls with reentrant, ETH-rejecting and token-rejecting
counterparties.

---

## The threat model

Shapes holds user ETH and has no administrator with any power over the reserve — the only owner
power is replacing the cosmetic renderer, which no value path touches. There is exactly one
thing that must never happen: a holder unable to redeem a live Shape for exactly the ETH it
wraps. Everything else is secondary.

Formally, at all times:

```
address(this).balance >= redeemableBacking()
redeemableBacking()        == sum of backingOf(t) over all live t
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

All `ShapeMinted` events for a batch are emitted before any ERC721 `Transfer`. Indexers that
assume `Transfer` comes first will mis-order a batch.

---

## Verified safe

| Axis | Result |
|---|---|
| Reentrancy | `mint`, `mintBatch`, `redeem`, `redeemBatch`, `compose`, `decompose`, `blacken` guarded; `_settle`, the fee call and the `blacken` sacrifice all execute inside the guard, after all effects. Reentry attempts from ERC721 callbacks, the payout callback and the fee callback all revert. `compose`/`decompose` make no external call. |
| Batch mint accounting | `firstTokenId` and `totalMinted` are set before any `_safeMint`, so ids cannot collide even under hypothetical reentry. Seeds distinct within and across same-block batches. |
| Batch redeem accounting | Duplicate ids revert on the second `_requireOwned`; mixed owners revert; no partial settlement exists — one atomic transaction. |
| Reserve solvency | Three value-bearing `CALL`s exist: `_settle` (reached only after a burn), the fee forward (money received in the same call, never counted as backing), and the `blacken` sacrifice (fixed 100 ETH to an unspendable address, after `redeemableBacking` is decremented). Proven by stateful invariants: `balance >= redeemableBacking`, backing conservation net of sacrifice, and `sacrificedBacking == 100 ether * blackCount`. |
| ETH out without a burn | Full external surface enumerated, including every inherited OpenZeppelin member. `Ownable` is inherited, but its owner power reaches only `setRenderer`/`lockRenderer` — a `view`-only renderer with no value path. No `delegatecall`, no `selfdestruct`, no assembly in `Shapes.sol`. |
| Overflow / truncation | No `unchecked` in `Shapes.sol`. `uint8(denomIndex)` is safe by construction — the index originates only from `Denominations.indexOf`, whose range is 0–8. Decrements are each paired with a successful burn. |
| Denomination validation | Exact `==` comparisons, no ranges, no rounding, no fallthrough. Because the *index* is stored rather than a wei amount, an off-ladder backing value is unrepresentable in storage. |
| Forced ETH | Surplus from `selfdestruct`, coinbase or pre-deploy funding leaves `redeemableBacking` untouched, cannot be extracted, and cannot corrupt accounting — no function reads `address(this).balance`. |
| DoS against the reserve | An owner that rejects ETH causes `_settle` to revert, reverting the whole redemption: the token is never burned and the backing is never lost. |
| Renderer replaceability | The renderer itself is pure: no state, no owner, no setter, verified stable across block number, timestamp, prevrandao, base fee and chain id. On `Shapes` the renderer pointer is owner-replaceable until `lockRenderer`, and both the constructor and `setRenderer` refuse a codeless address. The pointer is read only by `tokenURI`, so a replacement changes appearance only — never backing, redemption or ownership — and after locking it is fixed forever. |

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
4. **Artwork traits are grindable at one attempt per block.** If trait rarity is intended to
   carry economic weight, this design is not sufficient — but for Shapes it does not, because
   redemption value is set by denomination alone.
5. **This review is not a substitute for a professional audit** before mainnet deployment with
   real value at risk.

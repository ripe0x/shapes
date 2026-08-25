# Shapes — defensive security audit

Commit `4e6b3d8`, Solidity 0.8.28, scope `src/` (~4k SLOC).
Baseline: `forge test` — 306 passed, 4 skipped (fork tests, no `MAINNET_RPC_URL`).
With the PoC suites added: **329 passed, 0 failed, 4 skipped**.

Every Critical/High/Medium finding below is proven by a runnable Foundry test in this repo:
`test/AuditPoC.t.sol`, `test/AuditPoC2.t.sol`, `test/AuditPoC3.t.sol`, `test/AuditPoC4.t.sol`,
`test/AuditPoC5.t.sol`.

```
forge test --match-path 'test/AuditPoC*.t.sol' -vv
```

---

## Findings

### H-1 — High — A winning bid is locked in the auction house forever if the lot's transfer reverts

**Where:** `src/ShapeAuctionHouse.sol:216` (`settle`), `:232` (`withdraw`), `:241` (`claimProceeds`)
**PoC:** `test_PoC_H1_WinnerCardsLockedWhenLotTransferReverts`, `test_PoC_H1b_CancelDoesNotFreeBidders`

**Scenario.** Seller opens an auction on any ERC-721 they influence — pausable, blocklisting,
upgradeable, or purpose-built. Alice wins with 10 ETH of real, redeemable Shapes. Seller then
disables transfers on the lot.

- `settle` reverts inside `IERC721(a.nft).transferFrom(...)`, so `a.settled` never becomes true.
- `withdraw` refuses Alice unconditionally: `msg.sender == a.highestBidder`.
- `claimProceeds` refuses the seller: `!a.settled`.
- `cancelAuction` is closed once any bid lands.

Alice's cards — real claims on 10 ETH held by `Shapes` — sit at the house address with no
function on any contract that can move them. There is no rescue path, no owner, no pause.

**Root cause.** Settlement is a single all-or-nothing step that couples delivery of the lot to
release of the escrow, and the escrow release for the leader is gated only on `settled`, which
only `settle` can set and only in the same call that performs the untrusted transfer.

**Minimal fix.** Decouple the two. Either:

1. Wrap the lot delivery in `try/catch` so `settle` always flips `settled` and records
   `deliveryFailed`, and let the winner reclaim their escrow when delivery failed; or
2. (preferred, no partial-settlement state) add a deadline-based escape: once
   `block.timestamp >= a.endTime + GRACE` and `!a.settled`, allow the highest bidder to
   `withdraw`, which also voids the auction.

Option 2 keeps `settle` atomic and adds one comparison. Whichever is chosen, the invariant to
restore is: *every Shape that enters escrow has at least one reachable path out.*

---

### H-2 — High — The mint seed is selectable to order in one transaction; the "one attempt per block" residual does not hold

**Where:** `src/Shapes.sol:389` (`batchRoot`)
**PoC:** `test_PoC_SeedGrindingInOneTransaction`, `test_PoC_EveryGeneIsReachableOnDemand`,
`test_PoC_ArbitrarySeedPredicateAtApexDenomination`

`batchRoot` folds `prevrandao`, the prior blockhash, block number, timestamp, chain id, the
contract address — and `firstTokenId`. `firstTokenId` is just `totalMinted`, and **anyone can
advance `totalMinted` at will, permanently, for the price of the mint fee**: mint `k` dust
Shapes and redeem them in the same call. The dust comes back in full; only the fee is consumed.
Nothing reverts, so nothing forces the attacker to wait for a new block.

Measured, all inside a single transaction at the deployed default of 100 bps:

| target | throwaways | fee cost | gas |
|---|---|---|---|
| `Solid` ink gene (3% of dust mints) | 11 | 0.0012 ETH | ~1.3M |
| every one of the 7 ink genes, on demand | 0–30 | ≤0.0031 ETH | — |
| a 1-in-256 predicate on the raw seed, **on a 100 ETH mint** | 129 | 0.0129 ETH | 11.2M |

The last row is the attack `SECURITY.md` §1 reports as closed ("the reviewer selected a specific
100 ETH composition … in 85 free tries"). It is not closed; it is cheaper than before, because
it no longer needs a revert-and-retry loop. Roughly 570 candidate seeds fit in one 30M-gas block,
so any trait rarer than ~1-in-500 is one transaction away, and deeper predicates are reachable by
scanning across blocks. At `feeBps == 0` the ETH cost is zero and only gas remains.

`SECURITY.md` §1's stated residual — "one attempt per block, gas per attempt" — is wrong by
about three orders of magnitude. Every seed-derived property is affected: geometry, rotation,
fill, module sequence, and the ink gene, at every denomination.

**No ETH is at risk.** Backing is set by the amount paid, not by the seed. This is an
artwork-and-trait-scarcity finding, ranked High because it fully defeats a protection the
project specifically claims to have fixed, at trivial cost, and trait scarcity is the token's
entire secondary-market proposition.

**Root cause.** The seed is fully determined at mint time by inputs that are all either public
or purchasable. Removing `firstTokenId` from the root does not help — the per-token seed is
`keccak256(batchRoot, tokenId)`, so `tokenId` remains the same purchasable knob.

**Minimal correct fix.** Nothing determined at mint time can close this. The seed must depend on
entropy that does not exist when the mint is signed:

- Store `mintBlock` in `ShapeData` at mint. Leave the seed unset.
- Add a permissionless `reveal(uint256[] calldata tokenIds)` that pins
  `seed = keccak256(blockhash(mintBlock + 1), chainid, address(this), tokenId)` and emits
  ERC-4906. `blockhash` is only available for 256 blocks, so document a fallback for tokens
  revealed late (a fixed, publicly-known degenerate seed, or an EIP-4788 beacon-root read,
  which has a far longer window).
- Treat an unrevealed token as unrendered in `tokenURI`; keep every value path
  (`mint`/`redeem`/`compose`/`split`) independent of the seed so an unrevealed Shape is still
  fully redeemable.

That is a real change with a real cost — new storage, a new entrypoint, a new failure mode, and
another parity pass against `preview/src/canonical/`. If it is not taken, the honest alternative
is to delete the grinding-resistance claim from `SECURITY.md` and `SPEC.md` D3e and state
plainly that traits are selectable by anyone willing to pay the mint fee.

---

### M-1 — Medium — A ladder-legal compose can be permanently impossible to decompose

**Where:** `src/Shapes.sol:564` (`_compose`), `:789` (`_decomposeTo`)
**PoC:** `test_PoC_ComposeCanBecomeIrreversible`, `test_PoC_ComposeDecomposeGasAsymmetry`

`decompose` costs about **1.29×** what the compose it reverses cost (measured: 99 inputs →
5.39M compose, 6.98M decompose). `_burn` earns storage refunds that `_safeMint` does not, and
EIP-3529 caps those refunds at 20% of gas used, so the gap does not close at scale.

Composing a dust survivor with 499 dust inputs is ladder-legal (0.01 + 4.99 = 5 ETH) and costs
**26.87M gas — it fits in a 30M block**. `decompose` on that survivor runs out of gas at a full
30M limit and always will. Any compose with roughly 426–550 inputs lands in this band.

No ETH is lost: the survivor still redeems for the full 5 ETH (asserted in the PoC). What is
lost is the reversibility guarantee `DECOMPOSE_SPEC.md` and `README.md` present as a property of
the verb. `DECOMPOSE_SPEC.md:48` notes the per-input gas gap but stops short of stating that a
compose a user can actually execute may be unreversible.

**Minimal fix.** Make `decompose` resumable rather than all-or-nothing: `decompose(survivorId,
uint256 maxInputs)` pops inputs off the top record incrementally, restoring the survivor's
denomination only when the record empties. That preserves the guarantee at any scale. A cheaper
alternative is a hard cap on `burnIds.length` in `_compose`, chosen so the matching decompose
always fits — that trades a real capability away and needs an arbitrary constant, so the
resumable form is the better answer.

---

### M-2 — Medium — A seller can shill-bid its own auction at zero net cost

**Where:** `src/ShapeAuctionHouse.sol:119` (`bid`)
**PoC:** `test_PoC_SellerCanShillBidAtZeroCost`

`bid` never checks `msg.sender != a.seller`. A seller bids their own cards to set a floor,
watches a real bidder clear it, then `withdraw`s the shill cards intact. Net cost: gas. If the
shill wins, `settle` returns the lot and `claimProceeds` returns the cards — still no cost
beyond gas. There is no reserve-price alternative that is as cheap for the seller to move.

**Fix.** `if (msg.sender == a.seller) revert InvalidAuction();` in `bid`. This is not a complete
defence — the seller can bid from another address — but it removes the free, on-chain-obvious
form and matches what `reserveUnits` already exists to express.

---

### L-1 — Low — The copy validator accepts invalid UTF-8, so the owner can break strict JSON parsers for every token at once

**Where:** `src/Shapes.sol:269` (`_requireJsonSafe`)
**PoC:** `test_PoC_OwnerCopyCanEmitInvalidUtf8`

`_requireJsonSafe` rejects `"`, `\` and C0 controls, and bounds length. Every byte ≥ 0x80 passes
unvalidated, so `setTokenCopy(_, "\xff")` and `setCollectionCopy("\xff", "\xff")` both succeed
and the emitted document is not valid UTF-8. RFC 8259 requires UTF-8 for interchange: Python's
`json.loads` on bytes raises `UnicodeDecodeError`; JavaScript and Go substitute U+FFFD and parse
fine. So the blast radius is real but partial — some consumers break, most degrade.

This contradicts `SECURITY.md`'s standing caveat 3, which states copy "cannot break or
restructure the metadata JSON".

**Fix.** Add a UTF-8 well-formedness walk to `_requireJsonSafe` (reject 0xC0/0xC1/0xF5–0xFF,
require the right number of 0x80–0xBF continuation bytes, reject overlongs and surrogates), or
restrict copy to printable ASCII (0x20–0x7E minus `"` and `\`). ASCII-only is a few lines and
loses nothing the default copy uses.

---

### L-2 — Low — A contract fee recipient can strand a Shape inside the auction house

**Where:** `src/ShapeAuctionHouse.sol:193` (`_minting = true`), `:273` (`onERC721Received`)
**PoC:** `test_PoC_FeeRecipientCanStrandACardInTheHouse`

`onERC721Received` accepts any Shape while `_minting` is true. That flag is open across
`IShapes.mintBatchTo`, and `Shapes._mintBatch` forwards the mint fee with a raw `call` **before**
minting. A contract `feeRecipient` therefore gets control inside the window and can
`safeTransferFrom` one of its own Shapes into the house. The token lands in nobody's `_escrow`,
and no house function can move it out again. Outside the window the same transfer is correctly
refused with `UnsolicitedToken`.

Self-harm only, and the deploy script already refuses a contract fee recipient without
`SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT=true`.

**Fix.** Narrow the window: set `_minting` immediately before each `mintBatchTo` and clear it
immediately after, and additionally require `from == address(this)` in `onERC721Received` so
only the house's own mints are accepted.

---

### L-3 — Low — A hostile position resolver eats the caller's entire gas stipend

**Where:** `src/Shapes.sol:929` (`positionOf`)
**PoC:** `test_HostileResolverCannotBrickAnything`

`positionOf` forwards all remaining gas to the untrusted resolver. A resolver that spins until
5000 gas remain returns successfully having consumed ~197k of a 200k stipend. Core paths are
unaffected — `tokenURI`, `shapeState`, `redeem` all still work with the hostile resolver
installed, which is the property that matters — but an integrator that calls `positionOf` in a
loop can be griefed.

**Fix.** Cap the forwarded gas (`{gas: 50_000}`) and `try/catch` to `address(0)`. This matches
what `SECURITY.md` already claims for the resolver: "It may lie or revert, and those failures
affect only `positionOf`."

---

### L-4 — Low — Auction timing parameters are unbounded

**Where:** `src/ShapeAuctionHouse.sol:148`

`extensionWindow` is a `uint32` with no ceiling. A seller can set it to ~136 years; the first
bid then sets `endTime = block.timestamp + extensionWindow` and every bidder's cards are locked
for the duration, since only `settle` (gated on `endTime`) releases the leader's escrow. Same
for an absurd `duration`. Both are visible at creation and self-selecting, but combined with H-1
they are the second way to lock a bid indefinitely.

**Fix.** Bound both at creation (`duration <= 30 days`, `extensionWindow <= duration`).

---

### Informational

- **I-1 — `SECURITY.md` §10 documents an ERC-4906 range the code does not emit.** The doc says
  `setRenderer` emits `BatchMetadataUpdate(1, totalMinted)`; `src/Shapes.sol:224` emits
  `(0, totalMinted - 1)`. The code is right (ids start at 0); the doc is stale.
  Pinned by `test_BatchMetadataUpdateRangeIsZeroBased`.
- **I-2 — `ShapeAuctionHouse` is absent from the threat model and the invariant suite.**
  `SECURITY.md` covers `Shapes` only, and the `Invariants.t.sol` handler drives
  mint/redeem/compose/split/sacrifice/transfer with no auction actor. Both High findings and
  both Medium-adjacent ones in the house sit in that gap. Add an auction handler asserting
  "every Shape the house holds is in exactly one `_escrow` list" and "every escrowed Shape has a
  reachable exit". `test_HouseEscrowMatchesCustody` is a single-path version of the first.
- **I-3 — Duplicate compose inputs revert with the wrong error.** `_compose` has no explicit
  duplicate check; a repeated id fails at `ownerOf` with `ERC721NonexistentToken`, while
  `previewCompose` reports `DuplicateComposeInput`. Behaviourally correct, confusing to
  integrators.
- **I-4 — `_composeStack[id]` is never cleared when the survivor is burned by `split` or
  `redeem`.** Storage bloat only. `test_SplitOrphansComposeRecordWithoutLosingBacking` proves the
  orphaned record is inert: the id can never be re-minted, because only `decompose` re-mints and
  only from a record that holds the id, and no id is ever in two live records.
- **I-5 — `totalMinted` NatSpec overstates.** `src/interfaces/IShapes.sol:392` calls it "number
  of Shapes ever minted"; `decompose` re-mints ids without bumping it, so it is the id counter,
  not a mint count. `test_NestedComposeStackConservesBackingAndIds` pins the behaviour.
- **I-6 — `createAuction` never verifies the house received the lot.** A fake ERC-721 whose
  `transferFrom` is a no-op opens an auction over nothing and still collects real, ETH-backed
  Shapes via `claimProceeds`. Inherent to a permissionless auction over arbitrary NFTs; worth a
  post-transfer `ownerOf` check, which costs one `staticcall` and closes the trivially-fake case.
- **I-7 — Centralization, stated plainly for a buyer.** The owner can repoint `renderer` and
  `collection` until `lockRenderer`, and can rewrite `tokenNamePrefix` / `tokenDescription` /
  `collectionName` / `collectionDescription` **forever**, including after `lockRenderer`, unless
  ownership is renounced. None of these touch ETH, backing, ids or ownership — verified. Until
  `lockRenderer` is called, the owner can point `tokenURI` at any contract at all.

---

## Core invariants

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | Solvency: `balance >= redeemableBacking`; forced ETH stranded, never redeemable | **Holds** | Only three ETH outflows exist and each decrements backing by exactly what it sends. `balance - redeemableBacking` is monotone non-decreasing. `test_ForcedEthIsStrandedAndNeverCounted`; existing `invariant_ReserveIsSolvent`. |
| 2 | Exact redemption, owner only | **Holds** | `test_EveryDenominationRoundTripsExactly` — all 9 denominations round-trip to the wei. `_burnForRedemption` requires `owner == msg.sender`. |
| 3 | Value conservation across compose / decompose / split | **Holds** | `testFuzz_RecompositionConservesBackingExactly` (512 runs), `test_NestedComposeStackConservesBackingAndIds`, `test_SplitOrphansComposeRecordWithoutLosingBacking`. `split` asserts `sum(outDenoms) == parentBacking`; `decompose` restores from a self-contained snapshot. |
| 4 | Fee correctness, reserve never underfunded | **Holds, exactly** | Every denomination is a whole multiple of 1e16 wei and the divisor is 1e4, so `amount * feeBps / 10000` never truncates for any `feeBps`. `msg.value` must equal `backing + fees` exactly; fees are forwarded before the mint loop and never enter the reserve. |
| 5 | Id lifecycle: dense from 0, never reused after a burn, compose keeps the survivor id | **Holds** | No id is ever in two live compose records: an id enters a record only by being burned by `compose`, and leaves only by `decompose`, which pops that record. Fresh mints take `totalMinted`, above every issued id. `test_NestedComposeStackConservesBackingAndIds`, existing `TokenIds.t.sol` / `Token0.t.sol`. |
| 6 | Black is terminal and accounted | **Holds** | `isBlack` is checked on the survivor and every input of `compose`, on `decompose`, on `split`, on `sacrifice`, and on `redeem` (`allowBlack == false`). Only ERC-8060 `burn` destroys a Black Shape, for zero, decrementing backing by zero. `blackCount` is documented monotonic and is. |
| 7 | Presentation cannot touch value | **Holds** | `renderer`/`collection`/`positionResolver`/copy are read only by `tokenURI`, `contractURI`, `unicodeCard` and `positionOf`. `test_HostileResolverCannotBrickAnything`, `test_LocksAreOneWayAndCopyStaysEditable`. Caveat L-1: copy can degrade the metadata *document* for strict parsers, never the value. |

Area notes: no `delegatecall`, `selfdestruct`, `assembly`, `.transfer` or `.send` anywhere in
`src/`. All ERC-165 ids advertised by `Shapes.supportsInterface` resolve, and every selector of
every advertised capability interface is present in the deployed bytecode
(`test_AdvertisedInterfacesAreImplemented`). Locks are one-way and unbypassable. Batches are
atomic — one bad element reverts the whole call, no partial settlement exists.

---

## Ship / no-ship

**No-ship as-is, and the split is clean.** `Shapes.sol` itself is in good shape: the reserve
invariant holds under every path examined, redemption is exact at every denomination,
recomposition conserves value to the wei, Black is genuinely terminal, and no administrative
lever reaches ETH. Its two open items are H-2, which costs no ETH and can be shipped knowingly
if the grinding-resistance claims in `SECURITY.md` §1 and `SPEC.md` D3e are corrected to match
reality, and M-1, which is a bounded gas-asymmetry gap in a guarantee the docs advertise. The
blocking problem is `ShapeAuctionHouse`: H-1 permanently destroys a winner's escrowed Shapes —
real ETH claims — at near-zero cost to the attacker, with no rescue path in a contract that has
no owner and no pause, and the house was never in the threat model or the invariant suite that
`SECURITY.md` rests on. Fix H-1, bound the auction's timing parameters (L-4), block seller
self-bidding (M-2), and bring the house under the stateful invariant suite; then decide
deliberately on H-2 — either build the reveal, or delete the claim. `Shapes` and
`ShapeRenderer` can ship ahead of the house if you want to decouple them; the house holds no
privileged position over the token, so nothing about the value layer waits on it.

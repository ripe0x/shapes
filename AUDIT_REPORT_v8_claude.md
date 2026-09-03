# Independent audit report: Shapes architecture release

```text
repository  https://github.com/ripe0x/shapes
branch      claude/contracts-page
commit      7f6ccb5  (read at b49f2b1, which adds only AUDIT_PROMPT_v8.md)
scope       src/**, script/Deploy.s.sol, script/deploy.sh
auditor     independent local AI review, against AUDIT_PROMPT_v8.md
```

Adversarial tests written for this audit live in `test/audit/` and are new. Every one of them fails
to exploit; they are kept as documentation of what was tried.

## Evidence reproduced at this commit

| Command | Result |
| --- | --- |
| `forge build --sizes` | compiles; `Shapes` 20,342 runtime (4,234 margin), `ShapeRenderer` 23,256 (1,320) |
| `forge test` | 532 passed, 0 failed, 4 skipped |
| `FOUNDRY_PROFILE=testnet forge test` | 532 passed, 0 failed, 4 skipped |
| `MAINNET_RPC_URL=… forge test --match-contract Fork -vv` | 4 passed |
| `medusa fuzz --config project/experiments/medusa-reserve.json` | 11 tests passed (3 properties, 8 assertion targets), 34,592 calls |
| `script/deploy.sh anvil` then `script/e2e-anvil.sh` | deploy + end-to-end pass; house drains to 0 Shapes and 0 wei |
| `forge test` with `test/audit/` added | 594 passed, 0 failed, 4 skipped (both profiles) |

A passing suite is a claim, not a proof. Everything below is reasoned from the source; the tests
are where a reasoned conclusion was made falsifiable.

## 1. Findings

No Critical, High or Medium finding. No path was found by which a non-admin can move ETH out of the
reserve, mint backing that was never deposited, take a token they do not own, or break
`address(this).balance >= redeemableBacking() + pendingFees()`.

| id | severity | title | path:line | impact |
| --- | --- | --- | --- | --- |
| S-1 | Low | `setFeeRecipient` redirects fees that are already accrued, which the contract's own interface documents as impossible | `src/Shapes.sol:454`, `src/interfaces/IAdminControl.sol:9,29` | when admin and fee recipient are different parties, the admin can take the recipient's entire accrued fee balance |
| S-2 | Low | `lockPresentation` can be taken before `setCollection`, permanently bricking `tokenURI` and `contractURI` | `src/lib/AdminOps.sol:111` | one irreversible admin call leaves every token's metadata permanently reverting; backing untouched |
| S-3 | Low | The presentation lock freezes two pointers, not the contracts behind them; `setRenderer`/`setCollection` admit any contract that answers ERC-165 without exercising it | `src/lib/AdminOps.sol:74,81,89,100,111`, `src/ShapeCollection.sol:94` | an admin can lock in a renderer that reverts, or a collection whose copy stays editable by a third party, and neither is recoverable |
| S-4 | Informational | With a reverting fee recipient set and `renounceAdmin` called, accrued fees are permanently unreachable | `src/Shapes.sol:272,451` | real ETH stranded; requires two deliberate admin acts; reserve unaffected |
| S-5 | Informational | A mint-fee change between an auction bidder's quote and their transaction reverts the bid | `src/ShapeCardEscrow.sol:78,80` | admin-triggered griefing of ETH-backed bids; bounded by the fee cap; no value moves |

### S-1 — `setFeeRecipient` redirects already-accrued fees

**Severity** Low. **Path** `src/Shapes.sol:451-458`, `src/lib/AdminOps.sol:124-129`,
`src/interfaces/IAdminControl.sol:8-9,29`, `script/Deploy.s.sol:48`.

**Description.** `pendingFees` is a single unattributed balance. `withdrawFees` reads the recipient
at withdrawal time:

```solidity
// src/Shapes.sol:451
function withdrawFees() external nonReentrant {
    uint256 amount = pendingFees;
    if (amount == 0) revert NoFeesPending();
    address recipient = _feeConfig.feeRecipient;   // read now, not at accrual
    pendingFees = 0;
    emit FeesWithdrawn(recipient, amount);
    _sendEth(recipient, amount);
}
```

So the admin can call `setFeeRecipient(attacker)` and then `withdrawFees()` and take every fee that
accrued while a different recipient was configured. The contract's own interface states the
opposite twice:

- `src/interfaces/IAdminControl.sol:9` — the admin "cannot reach backing, redemption, token
  ownership or **accrued fees**."
- `src/interfaces/IAdminControl.sol:29` — "Redirect future mint fees. **Already-accrued fees** and
  the reserve are unaffected."

`script/Deploy.s.sol:48` repeats it ("Admin can redirect only future mint fees") and adds a second
inaccuracy in the same sentence: "it cannot change the amount", which `Shapes.setMintFee`
(`src/Shapes.sol:290`) contradicts within the one-unit cap.

This is not a reserve issue: `pendingFees` is disjoint from `redeemableBacking` on every path, and
`withdrawFees` never touches the reserve. It matters because the intended deployment separates the
two roles — `script/Deploy.s.sol:24-25` treats the initial fee recipient as a distinct choice from
the admin, and warns about a contract recipient — so a fee recipient reading the interface will
believe a balance accrued to them is theirs, and it is not.

**Reproduction** `test/audit/FeeAccounting.t.sol::test_AdminCanRedirectAlreadyAccruedFeesDespiteTheDocumentedPromise`.

**Impact** Real ETH, never user backing. Bounded by the accrued fee balance at the moment of the
redirect. Requires the admin key.

**Recommended fix** Two options, and they differ in cost:

1. Correct the documentation at `IAdminControl.sol:9,29` and `Deploy.s.sol:48` to say that the
   admin directs the whole pending balance, including what has already accrued, and that the mint
   fee is adjustable within the cap. Changes no ABI, no storage layout, no behaviour.
2. Make the code match the documentation: attribute fees at accrual with
   `mapping(address recipient => uint256) pendingFeesOf`, have `setFeeRecipient` leave the outgoing
   recipient's balance where it is, and have `withdrawFees` pay the caller's own attributed
   balance. This changes storage layout, changes `withdrawFees` behaviour (it becomes
   recipient-scoped), and adds an SSTORE per accrual. It also removes the S-4 stranding case,
   because a later recipient's balance is no longer held hostage by an earlier one.

Option 2 is the structurally correct answer if the separation of admin and fee recipient is meant
to carry any weight. Option 1 is correct if it is not, and the interface is simply overstating.
Either way the two must agree before this is deployed, because the current pair is a promise the
code does not keep.

### S-2 — `lockPresentation` before `setCollection` permanently bricks metadata

**Severity** Low. **Path** `src/lib/AdminOps.sol:111-115`, `src/Shapes.sol:159-163,999-1046`.

**Description.** `lockPresentation` takes no view of what it is freezing:

```solidity
// src/lib/AdminOps.sol:111
function lockPresentation(Presentation storage p) public {
    _requireUnlocked(p);
    p.locked = true;
    emit IShapes.PresentationLocked(p.renderer, p.collection);
}
```

The collection pointer starts at zero by construction (`src/Shapes.sol:192-194`: the collection is
built with the token's address and so cannot be a constructor argument). While it is zero,
`_requireCollection` reverts `CollectionNotSet`, and `tokenURI` and `contractURI` revert with it.
Locking first freezes that state permanently: `setCollection` then reverts `PresentationIsLocked`
and there is no other write path.

`script/Deploy.s.sol:154` sets the collection inside the same broadcast, before anything else, so a
deployment following the script never reaches this. It is one admin call away at any point before
the collection is set, and it is irreversible.

**Reproduction** `test/audit/PresentationLockOrdering.t.sol::test_LockingBeforeSetCollectionPermanentlyBricksMetadata`.

**Impact** All token and contract metadata permanently unreadable. Backing, redemption,
recomposition and ownership are untouched — the same test redeems a token afterwards for exactly
its denomination.

**Recommended fix** Reject the lock while the collection is unset:

```solidity
if (p.collection == address(0)) revert IShapes.CollectionNotSet();
```

Changes behaviour (a call that previously succeeded now reverts) and neither ABI nor storage layout.

### S-3 — The lock freezes the pointers, not the contracts behind them

**Severity** Low. **Path** `src/lib/AdminOps.sol:74-85,89-115`, `src/ShapeCollection.sol:94-103`,
`project/ARCHITECTURE.md` §11.

**Description.** The stated guarantee is that `lockPresentation` "permanently freezes the renderer
pointer, the collection pointer, and the collection's metadata copy" (`src/Shapes.sol:137-139`).
The third clause is true of the canonical `ShapeCollection`, which reads `presentationLocked()`
live from the token (`src/ShapeCollection.sol:97`) — and only of it. The admission test for a new
collection is `code.length != 0` plus an ERC-165 answer for `IShapeCollection`
(`src/lib/AdminOps.sol:81-85`), which any contract can give. A collection that gates its copy on
its own rule instead keeps a mutable copy after the token is locked, and the token can no longer
repoint away from it.

The renderer has the same shape of gap in a different direction: `requireRenderer`
(`src/lib/AdminOps.sol:74-78`) checks ERC-165 and code, and never exercises the target. A renderer
that answers the interface and reverts on every render call can be installed and then locked in,
after which `tokenURI` and `unicodeCard` revert permanently. A renderer returning a 200 KB string
is likewise installable; it costs the reader gas and nothing more.

**Reproduction** `test/audit/PresentationLockOrdering.t.sol::test_LockDoesNotFreezeCopyHeldByANonCanonicalCollection`,
`::test_RevertingRendererBricksMetadataOnlyAndIsPermanentOnceLocked`,
`::test_OversizedRendererOutputCostsTheReaderOnly`.

**Impact** Metadata only. Every one of those tests redeems a token afterwards for exactly its
denomination; presentation never reaches accounting. Requires the admin key, and a reader can
verify the pointed-at collection's source before the lock is taken.

**Recommended fix** Exercise the target before storing it: in `setRenderer`, call
`IShapeRenderer.tokenURI` once with fixed arguments and require a nonempty result; in
`setCollection`, call `contractURI`/`tokenNamePrefix` and require the same. That turns "answers the
interface" into "produces output", which is the property the lock is actually promising. Changes
behaviour (some previously-accepted targets are refused) and gas; no ABI or storage change.

If the copy freeze is meant to be structural rather than conventional, the copy has to live where
the lock lives — on `Shapes` — which reverses decision D-41 and costs runtime bytes the refactor
was spent to recover. That is the honest cost; the ERC-165-plus-exercise check is the cheaper
change and closes the accidental case without closing the deliberate one.

### S-4 — Renounced admin plus a reverting fee recipient strands accrued fees

**Severity** Informational. **Path** `src/Shapes.sol:272-276,451-458`.

**Description.** `withdrawFees` is permissionless but not redirectable by anyone except the admin.
If the standing recipient reverts on receipt and the admin then calls `renounceAdmin`, the accrued
balance can never be moved: `_sendEth` reverts, `setFeeRecipient` reverts
`AdminUnauthorizedAccount(…)` for every caller, and there is no recovery path by design.

**Reproduction** `test/audit/FeeAccounting.t.sol::test_RenouncedAdminFreezesTheFeeConfiguration`.

**Impact** Real ETH permanently unreachable. It is never reserve ETH; the same test redeems a token
afterwards for exactly its backing. Two deliberate admin acts in the wrong order.

**Recommended fix** Operational, not structural: renounce only after a successful `withdrawFees`
against a recipient known to accept ETH. `script/deploy.sh` already refuses a contract fee recipient
unless `SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT=true` (`script/Deploy.s.sol:132-136`), which is the
matching guard at the other end. Option 2 of S-1's fix also removes this case.

### S-5 — A mint-fee change reverts an in-flight ETH-backed bid

**Severity** Informational. **Path** `src/ShapeCardEscrow.sol:75-107`.

**Description.** `_mintCards` reads `IShapes(shapes).mintFee()` and requires
`msg.value == backingWei + fee * cardCount` exactly. A bidder quotes with `mintCostFor`
(`src/ShapeCardEscrow.sol:198-200`), which reads the same live value. An admin `setMintFee` mined
between the quote and the bid makes the bid revert `IncorrectPayment`.

**Impact** No value moves; the bid simply fails. Bounded by the one-unit cap and the card count
(at most 64). Card-only bids are unaffected.

**Recommended fix** None required. If bid reliability matters more than exactness, accept
`msg.value >= expected` and refund the difference — which introduces a push transfer into `bid` and
therefore a callback window the current design deliberately does not have. Leaving it is the
better trade.

## 2. Trust model

### Every `Shapes` function that delegates

A public or external function in a linked library is reached by `DELEGATECALL`. Internal library
functions are inlined into `Shapes`'s own runtime and are listed only where they carry the check.

| `Shapes` function | Check that runs first, in `Shapes` | Library function reached |
| --- | --- | --- |
| `constructor` | deployment; fee cap `_requireFeeWithinCap`, nonzero recipient, `AdminOps.requireRenderer` (internal, inlined), exact `msg.value` | `InkGenes.geneAtMint` |
| `setFeeRecipient` | `onlyAdmin` | `AdminOps.setFeeRecipient` |
| `setMintFee` | `onlyAdmin` | `AdminOps.setMintFee` (re-applies `MAX_MINT_FEE`) |
| `setRenderer` | `onlyAdmin` | `AdminOps.setRenderer` (lock + ERC-165) |
| `setCollection` | `onlyAdmin` | `AdminOps.setCollection` (lock + ERC-165) |
| `lockPresentation` | `onlyAdmin` | `AdminOps.lockPresentation` (lock only; see S-2) |
| `setPointer` | `onlyAdmin` | `AdminOps.setPointer` (per-pointer lock + ERC-165 for the reader's interface) |
| `lockPointer` | `onlyAdmin` | `AdminOps.lockPointer` (per-pointer lock) |
| `attestArtist` | **none, by design** | `AdminOps.attestArtist` → `EIP712Signature.artistDigest`, `EIP712Signature.isValidNow`; the gate is the EIP-712 signature against the immutable `artist` |
| `artistAttestationDigest` | none (view) | `EIP712Signature.artistDigest` |
| `mint`, `mintTo`, `mintBatch`, `mintBatchTo` | `nonReentrant`; `block.timestamp >= mintStart`; `quantity != 0`; ladder membership; `msg.value == backing + fees` | `InkGenes.geneAtMint`, once per token |
| `compose`, `composeMany` | `nonReentrant`; `burnIds.length != 0`; `_requireCallerOwnsLive(survivorId)`; then per input `RecompositionOps.requireComposeInput` (internal) before each `_burn` | `RecompositionOps.requireDistinctComposeInputs`, `RecompositionOps.compose` |
| `split`, `splitTo` | `nonReentrant`; `outDenoms.length >= 2`; `_requireCallerOwnsLive(tokenId)` | `RecompositionOps.split` |
| `decompose`, `decomposeTo`, `decomposeMany`, `decomposeManyTo` | `nonReentrant`; `_requireCallerOwnsLive(survivorId)` | `RecompositionOps.decompose` |
| `shapeState` | `_requireOwned` | `RecompositionOps.shapeState` |
| `composeRecordAt` | none (view); range checked inside | `RecompositionOps.composeRecordAt` |
| `previewCompose` | none in `Shapes`; the library applies `requireLiveOwner`/`requireComposeInput` against the caller-named `account` | `RecompositionOps.previewCompose` |
| `previewSplit` | same | `RecompositionOps.previewSplit` |
| `redeem`, `redeemTo`, `redeemBatch`, `redeemBatchTo`, `burn`, `burnBacking`, `withdrawFees` | `nonReentrant` + ownership/liveness/apex, entirely in `Shapes` | none — no delegation |
| `transferAdmin`, `renounceAdmin`, `refreshMetadata` | `onlyAdmin`, entirely in `Shapes` | none — no delegation |
| `positionOf`, `tokenURI`, `contractURI`, `unicodeCard` | views; `positionOf` staticcalls an untrusted target with a 50,000-gas cap | none — external `CALL`, not delegation |

**Is any check missing, or after a state write?** One place runs an effect before a validation, and
it is not exploitable: `_splitTo` (`src/Shapes.sol:665-689`) burns the parent and moves the
owner-token pointer before `RecompositionOps.split` validates the output sum
(`src/lib/RecompositionOps.sol:323`) and the denomination indexes. There is no external call in
that window — `RecompositionOps` reaches only `GeometrySampling`, `ComposeCompute` and `InkGenes`,
all linked pure libraries — so a failure reverts the whole transaction with nothing observed and
nothing kept. `test/audit/CraftedRecords.t.sol::test_MalformedSplitRejectedOnBothSides` asserts the
parent survives a rejected split intact. No other path writes before its gate.

`attestArtist` is the one ungated delegating entrypoint, as documented. What a relayer controls is
which of the artist's signed hashes lands, not what is stored: `AdminOps.attestArtist`
(`src/lib/AdminOps.sol:187-205`) rejects a zero hash, rejects a second attestation, and requires a
signature over `artistDigest(artist, releaseHash)`, which binds `block.chainid` and `address(this)`
(`src/lib/EIP712Signature.sol:20-26`). `test/ArtistAttribution.t.sol` pins the chain binding, the
deployment binding, the hash binding, and single use.

### The libraries write only what they are handed

Verified structurally rather than by inspection alone. Every write to an ETH-accounting counter in
the whole of `src/` is in `Shapes`:

```
src/Shapes.sol:223,418,508,530,786   redeemableBacking
src/Shapes.sol:787                   burnedBacking
src/Shapes.sol:423,455               pendingFees
src/Shapes.sol:551,788               blackShapeCount
src/Shapes.sol:211,558,631,678,765   _ownerToken
src/Shapes.sol:173 (declaration), 267, 274   _admin
```

The libraries write exactly two counters and the per-token structs:
`src/lib/RecompositionOps.sol:202,258` (`totalSupply`), `:336,337` (`totalMinted`, `totalSupply`).
No library touches ERC-721 storage: the only `_mint`/`_burn`/`_update` call sites are in
`src/Shapes.sol`. No library moves ETH: every `_sendEth` call site is
`src/Shapes.sol:457,511,532,794`, and `_sendEth` itself is `private` at `src/Shapes.sol:569`. No
library writes the admin address or the owner token.

Auditing the library bodies with the same rigour as `Shapes` — because under `DELEGATECALL` a bug
there is a bug in the token — the two mutating libraries hold: the compose record push and pop
(`RecompositionOps.sol:138-179,226-273`), the split record append and child writes (`:281-366`), and
eight configuration writes (`AdminOps.sol:89-205`). Their storage effects are covered under
"Properties verified" below; the narrowing casts they perform are enumerated there too.

### A direct call to a library cannot reach `Shapes`

Both stated reasons hold, and each is sufficient on its own. The claim in
`test/LibraryIsolation.t.sol` was checked against the real ABI rather than taken at face value:
`forge inspect RecompositionOps methodIdentifiers` gives
`compose(ShapeStore storage,uint256,uint256[],uint96) = a930f68d`, which is the selector that test
computes by hand, so its revert is the call protection and not a selector miss.

`test/audit/LibraryDirectCall.t.sol` extends that to every public entry of every linked library,
aimed at every slot in the token's layout:

- **Mutators revert.** `RecompositionOps.compose/decompose/split` and all eight `AdminOps` entries
  reject a direct `CALL`. solc emits call protection into a public library that has any non-view,
  non-pure external function; the runtime compares `address(this)` against the address written into
  its own code at deployment.
- **Views and pures do not revert, and cannot write.** `shapeState`, `composeRecordAt`,
  `previewCompose`, `previewSplit`, `requireDistinctComposeInputs`, and the whole of
  `GeometrySampling`, `InkGenes`, `EIP712Signature` and `CopyValidation` are `view` or `pure`, so
  solc emits no guard — correctly, since none can write. Under a direct `CALL` a storage-pointer
  argument resolves against the library's own account, which holds nothing, so those reads return
  zeros; `previewCompose` reverts because its `IERC721(address(this)).ownerOf` lands on the library.
- **Even without the guard, the write goes elsewhere.**
  `test_LibraryCodeAtAnotherAddressWritesThatAccountNotShapes` `vm.etch`es `AdminOps`'s runtime at a
  second address, where the guard's comparison does not fire, and calls `lockPresentation(21)`. The
  body runs, the lock bit lands in *that account's* slot 22 byte 20, and `Shapes` is untouched —
  which is the storage-pointer argument, demonstrated rather than asserted.

Every one of those calls is followed by a check of all thirty low storage slots of `Shapes` plus
every protocol getter. Nothing moves. (`ReentrancyGuard` in OZ 5.5 keeps its flag at an ERC-7201
namespaced slot, outside the swept range and outside anything a library touches.)

### The link is fixed at deploy

`foundry.toml` sets no `libraries = [...]`, so forge deploys each library and writes its address
into the dependent bytecode at link time. There is no setter for any library address anywhere in
`src/` — the only address-valued admin writes are `renderer`, `collection`, `positions` and
`market`, none of which is a delegation target. There is no proxy, no `delegatecall` with a
runtime-supplied address (`src/` contains no explicit `delegatecall` at all — the only ones are the
compiler-emitted library calls), and no `CREATE2` in `src/` or `script/Deploy.s.sol`. A compose or
configuration call cannot be redirected after deployment.

## 3. Properties verified

Each property is listed with the evidence used and any caveat. "Reasoned" means the argument is
structural; where a structural argument was made falsifiable, the test is named.

### Reserve and ETH

- **No sequence of calls makes `address(this).balance < redeemableBacking() + pendingFees()`.**
  Verified. Structurally: the six writes to `redeemableBacking` and two to `pendingFees` are all in
  `Shapes` (list above); `_mintBatch` requires `msg.value == backing + fees` and adds exactly those
  (`src/Shapes.sol:412-425`); the three outflow paths each subtract before they send. Evidence:
  `invariant_ReserveIsSolvent`, `invariant_BackingIsConservedExactly`,
  `invariant_BackingEqualsSumOfLiveTokens`, `invariant_FeesAreSeparateFromBacking` in
  `test/Invariants.t.sol`; Medusa `property_reserve_is_solvent` and
  `property_reserve_equals_redeemable_backing` over 34,592 calls; `_assertReserveInvariant()` after
  every state change in all nine `test/audit/` attempts. Caveat: the invariant is an inequality
  precisely because forced ETH can raise the left side; see the forced-ETH property below.
- **Redemption updates accounting and burns the token before sending ETH; a receiver that reverts
  or reenters cannot extract more than its backing or leave a burned token counted.** Verified.
  `_burnForRedemption` (`src/Shapes.sol:542-565`) clears the token state and `_burn`s; `_redeemTo`
  then decrements `totalSupply` and `redeemableBacking` and only then calls `_sendEth`
  (`:507-511`). All redemption entrypoints are `nonReentrant`. A reverting receiver reverts the
  whole redemption, so the token is not lost — `test/mocks/Mocks.sol::EthRejectingReceiver` and the
  existing `Hardening.t.sol` cover it. Reentry from the payout is refused
  (`ReentrantRedeemer`); reentry from a mint callback is refused in
  `test/audit/ReceiverReentrancyDecomposeSplit.t.sol`, which tries eleven guarded entrypoints on
  every callback of both mutators.
- **`burnBacking` moves the exact backing from `redeemableBacking` to `burnedBacking`, sends it to
  the unspendable address, marks the token Black, and never lets a Black token redeem.** Verified.
  `src/Shapes.sol:775-795` reads the apex amount from the ladder rather than from the token,
  requires denomination index 8 *and* `originCount == 10000`, sets `isBlack` before the transfer,
  and is `nonReentrant`. `test/audit/ForcedEth.t.sol::test_BurnBackingIgnoresTheSurplus` builds a
  real 10,000-origin apex, forces 5 ETH in beforehand, and asserts `0xdEaD` receives exactly the
  apex denomination and that the Black token then reverts `TokenIsBlack` on redeem. Every
  recomposition gate rejects a Black token through `requireLiveOwner`
  (`src/lib/RecompositionOps.sol:55`). `burn(tokenId)` destroys it for zero with no ETH call
  (`src/Shapes.sol:511` guards on `amountWei != 0`).
- **`withdrawFees` sends exactly `pendingFees` and nothing from the reserve.** Verified.
  `src/Shapes.sol:451-458`; `test/audit/FeeAccounting.t.sol::test_FeesAndReserveAreDisjointAcrossEveryPath`
  and `test/audit/ForcedEth.t.sol::test_SelfdestructedEthIsCountedNowhereAndIsUnwithdrawable`, which
  withdraws with 7 forced ETH present and asserts the surplus is untouched, then that a second
  withdrawal has nothing to pay. Caveat: *whose* fees they are is S-1.
- **Compose, decompose and split never change `redeemableBacking` in total.** Verified. None of the
  three writes it — the grep above is exhaustive. Compose forces the summed backing onto the ladder
  (`Denominations.requireIndexOf(acc.total)`, `src/lib/RecompositionOps.sol:182`); split requires
  the outputs to sum to the parent exactly (`ShapeMath.requireSplitSumMatches`, `:323`); decompose
  replays a recorded snapshot. `test/audit/CraftedRecords.t.sol::test_MaximalComposeRecordUnwindsExactly`
  and `::test_MaximalSplitAllocatesOriginsExactly` assert conservation at the ladder's extreme
  (10,000 dust into one apex and back; one apex into 10,000 dust).
- **Forced ETH.** Verified as stranded. `receive` and `fallback` both revert
  `DirectDepositRejected` (`src/Shapes.sol:1087-1093`), so `selfdestruct` and block rewards are the
  only routes. No function anywhere reads `address(this).balance`.
  `test/audit/ForcedEth.t.sol` forces 7 ETH by `selfdestruct` from a constructor (the form EIP-6780
  leaves fully intact), checks every counter and every per-token view is unmoved, drains the entire
  supply, and shows the 7 ETH still sitting there with `redeemableBacking == 0`.

### Recomposition

- **Compose burns the inputs, keeps the survivor, and records enough state to undo it.** Verified.
  `Shapes._compose` (`:616-641`) burns in its own runtime after gating each input;
  `RecompositionOps.compose` (`:123-212`) snapshots seed, id, originCount, denomIndex, inkGene and
  materialized modules per input, plus the survivor's pre-compose four fields, into one pushed
  record. Round-tripped in `test_MaximalComposeRecordUnwindsExactly` and
  `test_StackedRecordsUnwindLifo`.
- **Decompose pops exactly one record, restores the survivor's prior state, re-mints inputs under
  their original ids, never collides with a live id, and records unwind LIFO.** Verified.
  `RecompositionOps.decompose` (`:222-273`) reads `stack[depth - 1]` and `stack.pop()`s exactly
  once. Id collision is impossible by construction: an id enters a record only by being burned as a
  compose input, which requires it to be live, and it is restored only by the pop of the record
  that burned it, which is also the point at which it leaves the record. A fresh mint takes
  `totalMinted`, above every id ever issued, and split takes the next `k` from the same counter, so
  no newly issued id can be in an old record. `test_MaximalComposeRecordUnwindsExactly` mints a
  fresh token between the compose and the decompose and asserts it survives untouched;
  `test_DanglingRecordCannotBeReplayed` drives the nesting case (a survivor with a live record
  burned into another survivor, then revived) and asserts the abandoned record fires exactly once;
  `test_StackedRecordsUnwindLifo` pins the order and the per-pop survivor snapshot. Backstop: even
  a hypothetical collision would revert rather than corrupt, because OZ `_mint` rejects an existing
  id.
- **Split burns the parent and mints children whose denominations sum to the parent's backing; the
  split record lets provenance be reconstructed.** Verified. `requireSplitSumMatches` is an
  equality, not a bound. `test_MaximalSplitAllocatesOriginsExactly` asserts the origin sum is
  neither created nor destroyed across a 10,000-way split and reads back the last child's record;
  `test_SplitProvenanceDoesNotMisreport` asserts `NotASplitChild` for a non-child and that
  `originDenomIndex` still names the root split ancestor after a second, nested split.
- **Owner token.** Verified, including the callback question. Exactly one live token holds it: the
  pointer is a single `uint256` id-plus-one, written at `src/Shapes.sol:211,558,631,678,765` only.
  Compose moves it to the survivor before burning the input that held it (`:628-633`); split moves
  it to the first child's id, which is `totalMinted` and therefore the id child 0 is about to take
  (`:676-680`); decompose restores it to the recorded input **after** every restored id has been
  minted (`:759-767`). Redeeming or burning it clears it (`:557-560`).
  **The interleaving question:** no `onERC721Received` callback can observe `ownerToken()` naming a
  token that does not exist. Enumerating the windows — compose makes no external call at all
  (`_burn` has no callback); split's pointer move is followed only by the delegatecall into
  `RecompositionOps` (linked pure libraries, no untrusted call) before child 0 is minted, and OZ's
  `_safeMint` mints before it calls the receiver, so the first callback already sees a live child 0;
  decompose defers the move past the last mint. `test/audit/ReceiverReentrancyDecomposeSplit.t.sol`
  records `owner()`, `ownerToken()` and `ownerOf(ownerToken())` on every callback of both mutators,
  with the owner token deliberately in the record and on the split parent, and asserts consistency
  on all nine callbacks. `invariant_OwnerTokenTracksItsHolder` and Medusa
  `property_owner_token_tracks_its_holder` hold it across random sequences.
  Caveat, not a contract issue: in the split log stream `OwnerTokenMoved(parent, firstId)` is
  emitted before `ShapeFragmentCreated` for that id, so a log-order-sensitive indexer briefly sees
  the pointer at an id whose creation event has not yet arrived. State is never in that condition.
- **Previews run the same validation as the mutators.** Verified for every input tried, with one
  narrow caveat. `previewCompose` (`src/lib/RecompositionOps.sol:450-504`) applies, in the same
  order as `Shapes._compose`: empty-input rejection, `requireLiveOwner` on the survivor,
  `requireDistinctComposeInputs`, then per-input `requireComposeInput` — the same helper functions,
  not copies — and then the same `ComposeCompute.composeSampleAndGene` over the same donor state.
  `previewSplit` (`:510-545`) applies the same `k < 2` check, the same `requireLiveOwner`, the same
  `requireSplitSumMatches` and `allocateSplitOrigins`, and the same
  `sampleSplitChildFromPool`. `test/audit/CraftedRecords.t.sol` asserts the identical revert for
  duplicate ids, empty inputs, self-burn, non-owner, too-few outputs, sum mismatch and an
  off-ladder index on both sides, and
  `::test_PreviewMatchesExecutionOnAMaterializedSurvivor` /
  `::test_PreviewSplitMatchesExecution` assert byte-identical resulting modules, gene, origins and
  denomination through the record-pool branch.
  **Caveat.** One divergence exists and is inherent: the mutators are `nonReentrant`, the previews
  are not. Called from inside a guarded `Shapes` frame, a preview succeeds where the mutation would
  revert `ReentrancyGuardReentrantCall`. It predicts the outcome, not the guard. Also, by design,
  `previewSplit` does not predict child ids, which depend on `totalMinted` at execution.
- **Narrowing casts.** Enumerated, with which bound holds each:

  | cast | site | bound |
  | --- | --- | --- |
  | `uint96(burnId)` → `ComposeInput.id` | `RecompositionOps.sol:169` | **economic/gas only.** Ids come from `totalMinted`, which no code bounds. Each new id costs at least one cold SSTORE, so at 30M gas per 12s block the counter grows by order 1e7/year against a 2^96 ≈ 7.9e28 ceiling. Not reachable; not asserted in code. |
  | `uint96(_ownerToken)` → `ComposeRecord.ownerTokenFrom` | `Shapes.sol:630` | same bound (a live id plus one) |
  | `uint96(tokenId)` → `SplitRecord.parentId` | `RecompositionOps.sol:301` | same bound |
  | `uint64(splitRecords.length)` → `SplitOriginRef.recordIndex` | `RecompositionOps.sol:332` | **economic/gas only.** One push per `split` call; 2^64 calls, each burning a token and minting at least two. |
  | `uint32(acc.origins)` → `ShapeData.originCount` | `RecompositionOps.sol:204` | **proven in code.** `Denominations.requireIndexOf(acc.total)` on the preceding line bounds `acc.total` to a ladder amount, at most 10,000 units; the per-token invariant `originCount <= unitsAt(denomIndex)` is preserved inductively by mint (1 ≤ units), compose (this line), split (`allocateSplitOrigins` caps per child) and decompose (replays a valid pair), so `acc.origins <= acc.total/UNIT <= 10000`. |
  | `uint32(g)` → `ShapeMath.allocateSplitOrigins` give | `ShapeMath.sol:73` | **proven in code.** `g <= cap = unitsAt(outDenoms[i]) <= 10000`, and `assert(remaining == 0)` on `:76` pins the allocation exact. |
  | `uint32(i)` → `SplitOriginRef.childIndex` | `RecompositionOps.sol:357` | **proven in code.** `requireSplitSumMatches` forces the outputs to sum to the parent's backing, at most 100 ETH, and each is at least one 0.01 ETH unit, so `k <= 10000`. |
  | `uint8(newIndex)`, `uint8(denomIndex)` | `RecompositionOps.sol:203`, `Shapes.sol:430-432` | **proven in code.** Both come from `Denominations.indexOf`/`requireIndexOf`, whose range is 0..8. |
  | `uint64(added / UNIT)` → escrow bid units | `ShapeCardEscrow.sol:122` | **economic only.** `added` is escrowed backing; 2^64 units is 1.8e17 ETH, far above the total supply. |
  | `uint64(block.timestamp)` → auction end time | `ShapeAuctionHouse.sol:186,188` | year ~5.8e11 |

### Minting

- **`mintStart` gates every path that creates a new backed token, token #0 excepted.** Verified.
  `_mintBatch` (`src/Shapes.sol:391`) checks it first, before quantity, denomination and payment, so
  every one of the four public entrypoints is covered and reports `MintNotOpen` regardless of the
  other arguments. The constructor's `_mint(msg.sender, 0)` (`:229`) does not route through it, as
  documented. The one indirect path, `ShapeCardEscrow._mintCards` calling `mintBatchTo`
  (`src/ShapeCardEscrow.sol:98`), inherits the gate.
  `test/audit/MintStartBoundary.t.sol` deploys with a future start and asserts: every path reverts
  at `START - 1` and succeeds at exactly `START`; an ETH-backed auction bid reverts `MintNotOpen`
  before the start and goes through after; and the recomposition paths cannot issue an id before the
  start either, because the single pre-start token is one 0.01 dust that cannot be split (no two
  ladder outputs sum to one unit), cannot be composed (nothing to burn into it) and has no record to
  decompose.
- **Seeds are distinct within a batch, do not affect backing, and no rule depends on their
  unpredictability.** Verified. `_batchRoot` (`:373-385`) mixes block-level inputs with
  `firstTokenId`; each token's seed is `keccak256(batchRoot, tokenId)`, so distinctness within a
  batch is a property of distinct ids. `denomIndex` is derived from `amountWei` alone (`:404-409`)
  and never from the seed; the seed feeds only `InkGenes.geneAtMint` and geometry. Grindability is
  stated in the source comment at `:398-403` and is real — `firstTokenId == totalMinted`, so a
  minter can advance the ordinal at about one mint fee per try. Nothing in the reserve, the
  ownership model or the access control reads a seed.
- **The mint fee is bounded by the cap and cannot be raised above it by any admin path.** Verified.
  Two enforcement points, both against the same constant: `_requireFeeWithinCap` in the constructor
  (`:285-287`) and `AdminOps.setMintFee` (`src/lib/AdminOps.sol:133`), where
  `MAX_MINT_FEE = Denominations.UNIT`. `setMintFee` is the only write to `_feeConfig.mintFee` after
  construction. `test/audit/FeeAccounting.t.sol::test_MintFeeCapCannotBeExceededByAnyPath` tries
  `cap + 1`, `type(uint256).max` and a non-admin caller.

### Authority

- **`admin()` is the only privileged role; nothing reads `owner()` or the owner token for
  authorization.** Verified. `owner()` (`src/Shapes.sol:233-235`) and `ownerToken()` (`:238-241`)
  are read by `tokenURI` (for the "Contract Owner" trait) and by nothing else; no modifier, no
  branch and no revert path in `src/` reads either. `onlyAdmin` (`:258-261`) is the sole authority
  check, and `ShapeCollection.setMetadataCopy` reads `token.admin()` live.
  `test/audit/AuctionPaths.t.sol::test_OwnerTokenAsTheLotMovesOwnerAndNothingElse` escrows the owner
  token and then tries `setMintFee`, `transferAdmin` and `lockPresentation` from the house.
- **`lockPresentation` permanently freezes the renderer pointer, the collection pointer and the
  collection's metadata copy; `setMetadataCopy` reads the lock live.** Verified for the canonical
  collection, with the gap recorded as S-3. `ShapeCollection.setMetadataCopy`
  (`src/ShapeCollection.sol:94-103`) reads both `token.admin()` and `token.presentationLocked()` on
  every call, holds no cached copy of either, and the collection cannot be replaced after the lock.
  `test/audit/PresentationLockOrdering.t.sol::test_LockFreezesBothPointersAndTheCopy` and
  `::test_CopyGateReadsTheLockLiveAndTheAdminLive` (which moves the admin and shows the copy
  authority moving with it in the same transaction). The bypass that does exist — a non-canonical
  collection installed before the lock — is S-3, with its own test.
- **Pointers.** Verified. `setPointer` (`src/lib/AdminOps.sol:145-159`) requires a nonzero target to
  have code and to answer ERC-165 for exactly the interface its reader calls
  (`IShapePositionResolver` for positions, `IShapeAuctionHouse` for market); zero clears via the
  early return in `_requireTarget` (`:177`); `lockPointer` (`:162-174`) is permanent and can be
  taken at zero. `positionOf` (`src/Shapes.sol:945-960`) staticcalls with a 50,000-gas cap and
  returns zero on revert, on out-of-gas, on `data.length != 32` and on a word with bits above 160.
  `test/audit/HostilePositionsTarget.t.sol` exercises a reverting target, returns of 0/31/64/4096
  bytes, a dirty high word, a 5,000,000-iteration gas bomb (measured: the whole view costs under
  120,000 gas and resolves to zero), and a target that tries to write `Shapes` from inside the call
  — the write fails `StateChangeDuringStaticCall`, and one such attempt already exhausts the
  stipend. The residual power of a hostile target is to lie, which
  `::test_TargetMustAnswerItsInterfaceAndMayStillLie` shows and which is what the source documents.
- **Artist attestation.** Verified. One signature per contract
  (`attestation.releaseHash != 0` rejects a second, `src/lib/AdminOps.sol:193`), never replaceable,
  zero hash rejected. The digest binds `block.chainid` and `address(this)` in the domain separator
  and `address(this)`, `artist` and `releaseHash` in the struct hash
  (`src/lib/EIP712Signature.sol:20-26`); under `DELEGATECALL` `address(this)` is the token.
  Canonical ECDSA is tried first, then ERC-1271, which keeps a 7702-delegated EOA usable
  (`:35-36`). `test/ArtistAttribution.t.sol` covers chain binding, cross-deployment replay, hash
  binding, wrong signer, malformed signature, the delegated EOA and the ERC-1271 wallet.
- **`attestArtist` is the one ungated delegating entrypoint, and a relayer can store nothing but the
  artist's own approved hash.** Verified, with two caveats that are properties of signatures rather
  than of this code. If the artist signs more than one release hash, whichever a relayer submits
  first is permanent. And if `artist` is a contract whose ERC-1271 accepts broadly, the
  acceptance is that wallet's, not the token's — `test/ArtistAttribution.t.sol::test_ERC1271EmptySignatureCanAttestOnlyOnce`
  pins that case.

### Reentrancy and callbacks

- **Mint, redemption, fee and recomposition entrypoints are `nonReentrant`; inherited transfers and
  approvals are not.** Verified by inspection of every `external` function on `Shapes` and by
  `test/audit/ReceiverReentrancyDecomposeSplit.t.sol`, which calls eleven guarded entrypoints —
  `redeem`, `redeemTo`, `redeemBatch`, `burn`, `decompose`, `decomposeTo`, `compose`, `split`,
  `burnBacking`, `withdrawFees`, `mint` — from inside every callback of both mutators and asserts
  all eleven revert on all nine callbacks.
- **Enumeration of every external call and every callback.**

  | call site | target | trust | what a callback can observe | what it can change |
  | --- | --- | --- | --- | --- |
  | `_safeMint` in `_mintBatch` (`:443`) | recipient | untrusted | the batch's end state: `totalSupply`, `redeemableBacking` and `pendingFees` already hold the whole batch while only some tokens exist | nothing guarded; ERC-721 transfers/approvals of tokens it already holds |
  | `_safeMint` in `_splitTo` (`:687`) | recipient | untrusted | children minted so far; the owner-token pointer already on child 0, which exists | as above; a transfer to `Shapes` is refused (`_update`) |
  | `_safeMint` in `_decomposeTo` (`:761`) | recipient | untrusted | restored tokens so far; the owner-token pointer still on the survivor | as above |
  | `_sendEth` in `_redeemTo`, `_redeemBatchTo`, `withdrawFees` (`:511,532,457`) | recipient | untrusted | post-write state; the token is already burned and the counters already decremented | nothing guarded; if it is also the admin, the unguarded admin setters — which cannot redirect the transfer already in flight, because `withdrawFees` caches `recipient` first |
  | `_sendEth` in `burnBacking` (`:794`) | `0x…dEaD` | no code | — | — |
  | `positionOf` staticcall (`:949`) | positions target | untrusted | any view; 50,000 gas | nothing: static frame |
  | `tokenURI`/`contractURI`/`unicodeCard` (`:936,1000,1018,1033`) | renderer, collection | admin-set | any view | nothing: these are `view` |
  | `AdminOps._supports` (`src/lib/AdminOps.sol:210`) | candidate pointer target | untrusted | — | nothing: `try`-wrapped `view` |
  | `RecompositionOps` → `ComposeCompute`, `GeometrySampling`, `InkGenes` | linked libraries | trusted, fixed at link | — | — |
  | `ShapeCardEscrow` → `Shapes` (`:64,69,78,98,140`) | `Shapes` | trusted | — | the escrow's own mint accrues the fee rather than paying it out, so no arbitrary contract gains control inside `bid` |

  The one callback documented as legitimate holds: during a plain `safeTransferFrom` the guard is
  not engaged, so the receiver may redeem, compose or split the token it just received from inside
  `onERC721Received`. Accounting stays exact because the transfer's own writes are already complete
  when the callback runs. An integrator must not assume the token still exists afterwards, which
  `src/Shapes.sol:53-55` and `project/ARCHITECTURE.md` §9 both say.
- **Self-custody is blocked on both paths, and no path leaves a token owned by `Shapes`.** Verified.
  `_update` (`src/Shapes.sol:1067-1070`) rejects `to == address(this)` and sits under
  `transferFrom`, `safeTransferFrom`, `_mint`, `_safeMint` and `_burn` alike, so mint, split and
  decompose recipients are covered as well as transfers.
  `test/audit/ReceiverReentrancyDecomposeSplit.t.sol::test_CallbackCannotPushAChildIntoShapesCustody`
  attempts it from inside a split callback. Auction settlement never sends a Shape to `Shapes`: the
  house transfers to a bidder or a seller.

### Auction house and escrow

- **The house never receives authority over `Shapes`.** Verified.
  `test/audit/AuctionPaths.t.sol::test_OwnerTokenAsTheLotMovesOwnerAndNothingElse`. The house holds
  no role; the `market` pointer is read by clients and by no token operation
  (`project/ARCHITECTURE.md` §8, and `_pointers` is read only by `positions()`, `market()` and
  `positionOf`).
- **Card bids and ETH bids both leave the reserve invariant intact.** Verified. A card bid moves
  ERC-721s and nothing else. An ETH bid pays `backingWei + fee * cardCount` and `_mintCards` spends
  exactly that across the denomination groups, so the house ends with zero ETH —
  `::test_EthBackedBidMintsExactlyAndKeepsTheReserveExact` asserts the reserve grew by exactly the
  backing, `pendingFees` by exactly `fee * cards`, and that the minted set is worth the bid; the
  anvil end-to-end asserts "house holds 0 Shapes and 0 wei"; `invariant_HouseHoldsNoEther` and
  `invariant_HouseFullyDrains` hold it under random sequences. Wrong payment, stray ETH on a
  cards-only bid, and an off-lattice amount are each rejected.
- **Settlement and claim are pull-based; a reverting recipient blocks only its own delivery.**
  Verified. `settle` (`:203-210`) touches no collection and only records; `claimLot` (`:216-228`)
  marks claimed before transferring; `withdraw` and `claimProceeds` move Shapes alone.
  `::test_ARevertingLotBlocksOnlyItsOwnDelivery` makes the lot's collection refuse the outbound
  transfer and shows the loser still withdrawing and the seller still claiming proceeds.
- **Escrowing the owner token moves `owner()` to the house for the auction's life; nothing else
  changes.** Verified by the same test: `ownerToken()` still names Shape #0 throughout, `admin()`
  never moves, and after `claimLot` `owner()` follows the lot to the winner.
  `::test_RedeemingAWonOwnerTokenEndsOwnershipCleanly` then redeems it and asserts `owner()` clears
  and `ownerToken()` reverts `NoOwnerToken`.
- Additional escrow properties checked: a Black Shape is refused as a card
  (`WorthlessCard`, because `backingOf` returns zero), an unsolicited `safeTransferFrom` into the
  escrow is refused (`UnsolicitedToken`), the seller cannot bid its own lot, and a token cannot be
  listed twice while the house still holds it.

### Presentation

- **`ShapeRenderer` has no owner, setters or mutable state; same inputs, same output.** Verified.
  `forge inspect ShapeRenderer storageLayout` returns an empty table — the contract declares no
  storage at all. Every external function is `view` or `pure`. It reads nothing from `Shapes`.
- **The renderer and collection cannot affect backing, redemption or accounting.** Verified. They
  are reached only from `tokenURI`, `contractURI` and `unicodeCard`, all `view`. S-3's tests install
  a reverting renderer and an oversized renderer and then redeem a token for exactly its
  denomination.
- **Metadata strings are validated as JSON-safe before storage and cannot break `tokenURI` or
  `contractURI`.** Verified. `CopyValidation.requireJsonSafe` (`src/lib/CopyValidation.sol:19-48`)
  rejects `"`, `\` and every C0 control byte, and walks RFC 3629 above the ASCII range: lone
  continuation bytes, overlong C0/C1/E0/F0 forms, the UTF-16 surrogate range via the ED case, code
  points above U+10FFFF via the F4 case and the F5-and-up rejection, and truncated sequences.
  Length is capped at 64 bytes for the prefix and 2048 for the description. Both strings land only
  inside JSON string values (`src/ShapeRenderer.sol:1242-1246`,
  `src/ShapeCollection.sol:126-138`) and never inside the SVG, so the two barred characters are the
  complete escape surface. Caveat: `<`, `>` and `&` are permitted, which is correct for JSON and
  would matter only if a future renderer routed the copy into markup.

## 4. Not exploitable, worth knowing

- **`_splitTo` burns before it validates.** The parent is burned and the owner-token pointer moved
  at `src/Shapes.sol:671-680`, before `RecompositionOps.split` checks the output sum at
  `src/lib/RecompositionOps.sol:323`. There is no external call in the window, so a failure reverts
  everything. It is the only effect-before-check ordering in the codebase and worth knowing before
  anyone adds a call to that window.
- **An approved ERC-721 operator can list your Shape and become the seller.** `createAuction`
  admits `getApproved` and `isApprovedForAll` holders (`src/ShapeAuctionHouse.sol:99-105`), then
  records `a.seller = msg.sender` (`:113`) and pulls the token from its owner (`:130`). The operator
  then collects the proceeds (`claimProceeds`, `:246`) and, if the auction is cancelled, the lot
  itself (`claimLot`, `:221`). This is not an escalation — an approval already permits
  `transferFrom` to any address — but an owner granting a single-token approval to what they think
  is an escrow may not expect the approver to become the seller of record.
- **A winner's cards can sit in escrow indefinitely.** `claimProceeds` is seller-only
  (`:243-250`). If the seller cannot or will not call it, the winning cards stay escrowed and the
  winner cannot withdraw them (they are the standing `highestBidder`). The winner still gets the
  lot. Pull-based by design, and the alternative — pushing up to 64 ERC-721 transfers inside `bid`
  — is the thing `src/ShapeCardEscrow.sol:18-21` deliberately avoids.
- **`withdrawFees` is permissionless.** Anyone can push accrued fees to the standing recipient. That
  is a feature (it removes an admin liveness dependency) and it is also the reason S-1's redirect
  matters: the caller cannot direct the payment, but the admin can, at any moment.
- **`decompose` would revert rather than corrupt if a record's id were live.** OZ `_mint` rejects an
  existing id, so even a hypothetical record/live-id collision fails closed. The collision is
  argued impossible above; this is the backstop underneath the argument.
- **`_mintBatch` emits all `ShapeMinted` and `InkGene` events before any `Transfer`.** State is
  consistent throughout — the counters already hold the whole batch — but an indexer that pairs
  mints with transfers by position within a transaction will see them in that order.
- **Split does not clear the parent's compose stack.** `composeStack[parentId]` survives the parent's
  burn (`src/lib/RecompositionOps.sol:314` says so explicitly, so the sampling branch can be
  reconstructed later). The stack is inert: `decompose` gates on ownership of a live survivor, and a
  split parent is dead forever. Same for a redeemed survivor.
- **A Black Shape keeps its apex denomination internally.** `denomIndexOf` returns 8 and
  `Denominations.amountAt` returns 100 ETH for it, while `backingOf` returns zero
  (`src/Shapes.sol:807-811`). Any integrator valuing a Shape must use `backingOf`/`valueOf`, not the
  denomination — which is exactly why `ShapeCardEscrow._takeCards` values a card off `backingOf`
  (`src/ShapeCardEscrow.sol:64`) and rejects zero.
- **The 50,000-gas positions stipend also bounds reentrancy.** A resolver that tries one write into
  `Shapes` and then one read runs out of gas before it can return; the observed trace shows the
  write failing `StateChangeDuringStaticCall` and the read exhausting the remainder.
- **The `remaining > 0` invariant inside `sampleCompose` holds for a reason worth stating.**
  `src/lib/GeometrySampling.sol:221-232` draws `n` times from donor module arrays without
  replacement per donor. It cannot exhaust one, because every donor's amount is strictly below the
  compose result's (all donors are positive and there are at least two), `Denominations.gridAt` is
  strictly decreasing in cell count as the index rises, and total draws equal the result's cell
  count. If a future ladder or grid table broke either monotonicity, `nextBelow(0)` would silently
  return zero and the sampler would reuse a consumed module rather than revert.

## Appendix: style, naming and documentation

Not findings; recorded because they are in the verified source a reader will rely on.

1. `src/interfaces/IAdminControl.sol:9` — "cannot reach backing, redemption, token ownership or
   accrued fees" is wrong about accrued fees. See S-1.
2. `src/interfaces/IAdminControl.sol:29` — "Already-accrued fees and the reserve are unaffected" is
   wrong about the first clause and right about the second. See S-1.
3. `script/Deploy.s.sol:48` — "Admin can redirect only future mint fees; it cannot change the
   amount" is wrong twice: the redirect covers accrued fees, and `setMintFee` changes the amount
   within the cap. The same file's line 47-48 correctly notes the owner token carries no
   permissions.
4. `src/Shapes.sol:137-139` and `project/ARCHITECTURE.md` §11 state that `lockPresentation` freezes
   "the collection's metadata copy". True of the canonical `ShapeCollection` and not of an arbitrary
   one behind the same pointer. See S-3.
5. `src/lib/AdminOps.sol:81` — `requireCollection` is flagged by forge's linter as an internal
   function used once. It is the symmetric counterpart of `requireRenderer`, which is used twice
   (constructor and setter); leaving the pair symmetric reads better than inlining one half.
6. `test/LibraryIsolation.t.sol:20-21` pins `_store` at slot 6 and `_presentation` at slot 21 in a
   comment. Both are correct at this commit, and both are load-bearing for the test's meaning; a
   storage-layout change would silently turn those calls into harmless nonsense that still passes.
   `test/audit/LibraryDirectCall.t.sol` sweeps all thirty low slots instead, so a layout drift there
   is caught by the assertion rather than by the comment.
7. `src/lib/Round03Rand.sol:19-27` documents that the stream's state is 32 bits and that seeding and
   the per-draw increment share a constant, so every seed is a window into one sequence. That is
   correctly scoped to visual output and is stated in the source; no protocol rule depends on it.

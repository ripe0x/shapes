# Independent audit report v9: Shapes architecture release

```text
repository  https://github.com/ripe0x/shapes
branch      claude/contracts-page
commit      1c2cfd9  ("Merge pull request #88 from ripe0x/claude/merge-main")
scope       src/**, script/Deploy.s.sol, script/deploy.sh
brief       AUDIT_PROMPT_v8.md, applied to 1c2cfd9, plus the deltas since 7f6ccb5 and a tenth
            adversarial attempt
auditor     independent local AI review
```

Every adversarial attempt written for this audit lives under `test/audit/` with a `V9` prefix and
is kept whether or not it exploited anything. All forty-six fail to exploit. A passing test is a
claim, not a proof; everything below is reasoned from the source and the tests are where the
reasoning was made falsifiable.

The prior artifacts (`AUDIT_REPORT_v8_claude.md`, `AUDIT_REPORT_v8_codex.md`,
`project/reviews/architecture-security-2026-09-03.md`,
`project/reviews/diff-review-7f6ccb5-2bc389a.md`) were read only after the findings below were
formed. Two v8 findings are confirmed fixed at this commit and are not reported; one is still
reproducible and is reported again.

## Evidence reproduced at this commit

| Command | Result |
| --- | --- |
| `forge build --sizes` | compiles; `Shapes` 22,460 runtime (2,116 margin), `ShapeRenderer` 23,256 (1,320), `RecompositionOps` 12,146, `ShapeAuctionHouse` 8,015, `ShapeCollection` 6,753, `GeometrySampling` 4,714 |
| `forge test` (baseline, before this audit's tests) | 618 passed, 0 failed, 4 skipped |
| `forge test`, first run with `test/audit/V9*` | 660 passed, 0 failed, 4 skipped |
| `FOUNDRY_PROFILE=testnet forge test` | 659 passed, **1 failed**, 4 skipped — `invariant_DecomposeRestoredEveryRecordedState`, fuzz seed `0x9ced…42eb`. Diagnosed as a defect in the invariant handler, not in the contract: finding V9-6 |
| `forge test`, second run with the replay tests added | 663 passed, **1 failed**, 4 skipped — the same invariant, on a different random seed (`0x23c0…3c9e`) |

The invariant failure is neither profile-dependent nor rare. It appeared on the testnet profile
first, then on the default profile with an unrelated seed, and the seventeen-call sequence that
produced the first one reproduces under both profiles
(`test/audit/V9InvariantReplay.t.sol`). Two of the three unseeded `forge test` runs made during
this audit failed it. Treat the suite as currently red rather than green until V9-6 is fixed.

Not run in this pass: the fork suite, Medusa, and the anvil deploy and lifecycle scripts. They
were exercised at 7f6ccb5 by the v8 reviews; nothing in the delta touches their inputs, but that
is an inherited claim rather than a reproduction.

## 1. Findings

No Critical, High or Medium finding. No path was found by which a non-admin moves ETH out of the
reserve, mints backing that was never deposited, takes a token they do not own, breaks
`address(this).balance >= redeemableBacking() + pendingFees()`, or corrupts the owner token
pointer.

One invariant did fail during this audit
(`invariant_DecomposeRestoredEveryRecordedState`, on two unrelated fuzz seeds). It was traced to
the invariant handler and the contract was then verified correct against its own records on the
exact failing sequence. That is V9-6, and it is the finding to fix first, because it is a break in
the safety net rather than in the protocol.

| id | severity | title | path:line | impact |
| --- | --- | --- | --- | --- |
| V9-1 | Low | The presentation lock freezes two pointers, not the behaviour behind them: `setRenderer`/`setCollection` admit any contract that answers ERC-165 without ever exercising it, and `lockPresentation` makes that choice permanent | `src/lib/AdminOps.sol:79,90,101,112,125`, `src/ShapeCollection.sol:105` | an admin can permanently lock in a renderer that reverts, or a collection whose copy stays editable forever while `presentationLocked()` reads true; backing and redemption untouched |
| V9-2 | Low | A fee balance credited to a recipient that cannot receive ETH is now permanently unrecoverable, because per-recipient accrual removed the only path that could re-route it | `src/Shapes.sol:441,470`, `src/lib/AdminOps.sol:143` | real ETH stranded inside the contract with no admin or user path to it; a direct consequence of the v8 S-1 fix |
| V9-3 | Informational | The constructor accepts the token's own address as the fee recipient; `setFeeRecipient` explicitly refuses it | `src/Shapes.sol:216`, `src/lib/AdminOps.sol:144` | a deployer that predicts its own CREATE address strands every mint fee from block one; reserve invariant unaffected |
| V9-4 | Informational | The stated justification for the `uint96` token-id casts is false: `split` issues ids with no new backing and no mint fee, so the bound is gas, not deposited ETH | `src/ShapeTypes.sol:36`, `src/lib/RecompositionOps.sol:334` | none today; the safety argument recorded in the code does not hold, so a future change cannot be checked against it |
| V9-5 | Informational | `test/LibraryIsolation.t.sol` credits compiler call protection for the isolation of libraries that do not carry any; `Shapes` links five libraries, and three of them are unprotected | `test/LibraryIsolation.t.sol:46`, `src/Shapes.sol:27-32` | none today; the isolation argument covers two of five linked libraries and attributes safety to the wrong mechanism |
| V9-6 | Low | `invariant_DecomposeRestoredEveryRecordedState` reports a false failure whenever `decomposeMany` pops two records: the handler checks the survivor after the whole batch has run, against a hash that describes the state between the two pops | `test/Invariants.t.sol:658`, `:186` | the decompose safety net fails on some seeds for correct behaviour, and the survivor half of the check is vacuous on the `decomposeMany` path; no contract impact |

### V9-1 — the presentation lock freezes pointers, not behaviour

**Severity** Low. **Path** `src/lib/AdminOps.sol:79-97` (`requireRenderer`, `requireCollection`),
`:101-119` (`setRenderer`, `setCollection`), `:125-130` (`lockPresentation`),
`src/ShapeCollection.sol:105-120` (`setMetadataCopy`).

**Description.** `setRenderer` accepts any address with code that answers ERC-165 `true` for
`IShapeRenderer` and `IShapeGeometry`. `setCollection` accepts any address with code that answers
`true` for `IShapeCollection` and returns `address(this)` from `shapes()`. Neither check exercises
the interface. `lockPresentation` then requires only that a collection is set:

```solidity
// src/lib/AdminOps.sol:125
function lockPresentation(Presentation storage p) public {
    _requireUnlocked(p);
    if (p.collection == address(0)) revert IShapes.CollectionNotSet();
    p.locked = true;
    emit IShapes.PresentationLocked(p.renderer, p.collection);
}
```

Two consequences follow, both permanent because the lock is one way.

First, a renderer that answers ERC-165 for everything and reverts on every real call installs and
locks. `tokenURI`, `svg`, `metadataJSON`, `geometryOf`, `moduleAt` and `unicodeCard` then revert
for every token, forever. `contractURI` survives only because it reads the collection.

Second, and more directly against the stated property, the metadata-copy freeze is a property of
`ShapeCollection`'s implementation, not of `Shapes`. `ShapeCollection.setMetadataCopy` reads
`token.presentationLocked()` live, which is correct and cannot be bypassed by replacing the
collection before locking, because every bound collection reads the same live flag. But an
installed collection is only required to answer ERC-165 and name this token. A collection that
ignores the flag keeps its copy editable after the lock, while `presentationLocked()` reads
`true` and the collection pointer can never be changed back. The guarantee a collector reads as
"the metadata is now permanent" is, in that configuration, unenforced.

**Reproduction.** `test/audit/V9FeesAndPresentation.t.sol`:
`test_Attempt10_HostileRendererCanBeInstalledAndLocked` and
`test_Attempt10_LockDoesNotFreezeCopyInsideAForeignCollection`. Both pass. The first also asserts
that `redeem` still pays face value with the hostile renderer installed, which is what bounds the
severity. `test_Attempt8_LockOrdering` and `test_Attempt8_LockRequiresACollection` show the honest
ordering cases are all closed, including v8's S-2 (locking before `setCollection` now reverts).

**Impact.** No ETH and no token ownership. Presentation only. It matters because
`lockPresentation` is the mechanism that is supposed to remove trust in the admin for
presentation, and it does not remove it unless the installed contracts happen to be the canonical
ones.

**Recommended fix.** Make `lockPresentation` exercise what it is about to freeze rather than
merely observe that a pointer is non-zero: call `IShapes(address(this)).tokenURI(0)` and
`contractURI()` inside the lock and revert if either fails. That turns "the pointer is set" into
"the pointer works at the moment it becomes permanent". It does not close the mutable-copy case,
which cannot be closed by a check; for that, either state in `IShapes.lockPresentation`'s notice
that the copy freeze holds only for a collection that honours the flag, or bind the collection by
codehash at lock time.

**Compatibility.** ABI unchanged. Storage layout unchanged. Behaviour changes: `lockPresentation`
gains a revert path.

**Prior art.** This is `AUDIT_REPORT_v8_claude.md` S-3, still reproducible at 1c2cfd9.

### V9-2 — a stuck fee balance is now permanently unrecoverable

**Severity** Low. **Path** `src/Shapes.sol:436-444` (accrual), `:470-477` (`withdrawFees`),
`src/lib/AdminOps.sol:143-150` (`setFeeRecipient`).

**Description.** Fees now accrue per recipient:

```solidity
// src/Shapes.sol:440
if (fees != 0) {
    _feesOwed[_feeConfig.feeRecipient] += fees;
    _totalFeesOwed += fees;
    emit MintFeeAccrued(fees);
}
```

and `withdrawFees(recipient)` pays `_feesOwed[recipient]` to `recipient` itself. This is the fix
for v8's S-1 and it is correct: the sum of `feesOwedTo` over every recipient equals
`pendingFees()` on every path, and `setFeeRecipient` moves nothing.

The cost of that fix is that a balance credited to an address that cannot receive ETH has no exit.
Under the old single-pool design an admin could point the recipient at a working address and
withdraw. Now the destination is fixed at accrual time, `_sendEth` uses a bare `call` whose
failure reverts the whole withdrawal, and no function re-keys or forgives an entry. The ETH stays
inside the contract, counted by `pendingFees()`, forever.

The trigger is a configuration error rather than an attack: a fee recipient with a reverting
`receive`, a contract later self-destructed or upgraded into one that reverts, or a recipient that
runs out of gas in 2300 (not applicable here, since `_sendEth` forwards all gas, but a recipient
that reverts for any reason qualifies). It is worth stating because the deployment explicitly
contemplates a contract fee recipient (`script/Deploy.s.sol`,
`SHAPES_ALLOW_CONTRACT_FEE_RECIPIENT`), and the constructor's own note
(`src/Shapes.sol:199-200`) says such a recipient "blocks `withdrawFees` and leaves minting
working" without saying the block is now permanent.

**Reproduction.** `test/audit/V9FeesAndPresentation.t.sol`:
`test_Finding_ARevertingRecipientsBalanceIsPermanentlyStranded`. It sets a reverting recipient,
accrues, changes the recipient, changes it back, and shows the balance is unreachable in every
configuration while the reserve invariant still holds.
`test_Attempt5_ARevertingRecipientBlocksOnlyItself` shows the isolation property the delta claims:
a reverting recipient never blocks a healthy one.

**Impact.** Real ETH, but only fee revenue, never backing. `redeemableBacking` and every
redemption path are untouched, and `address(this).balance >= redeemableBacking() + pendingFees()`
continues to hold (with equality, since the stuck ETH is exactly the stuck `pendingFees`).

**Recommended fix.** Two options, in order of preference. Either give `withdrawFees` an explicit
destination that only the credited recipient may name (`withdrawFeesTo(address recipient, address
payable to)` gated on `msg.sender == recipient`), which keeps the no-admin-reach property and
gives a contract recipient a way out through its own authority; or accept the behaviour and say so
in `IAdminControl.setFeeRecipient`'s notice and in the constructor's `@param`, so a deployer
choosing a contract recipient knows the failure is terminal.

**Compatibility.** The first option adds an external function: ABI grows, storage layout and
existing behaviour unchanged. The second changes documentation only.

**Status:** accepted by the owner 2026-09-03; the deploy path now proves the recipient accepts
plain ETH instead of requiring an EOA.

### V9-3 — the constructor accepts the token itself as fee recipient

**Severity** Informational. **Path** `src/Shapes.sol:216`, against `src/lib/AdminOps.sol:144`.

**Description.** `AdminOps.setFeeRecipient` rejects both the zero address and `address(this)`,
with the reason spelled out: `Shapes` has no payable `receive`, so fees credited to its own
address could never be withdrawn. The constructor checks only zero:

```solidity
// src/Shapes.sol:216
if (feeRecipient_ == address(0)) revert AdminInvalidFeeRecipient(address(0));
```

A deployer can compute its own CREATE address and pass it, after which every mint fee accrues to
an address whose withdrawal always reverts (`receive()` reverts `DirectDepositRejected`). Combined
with V9-2, the balance is permanent from block one.

**Reproduction.** `test/audit/V9FeesAndPresentation.t.sol`:
`test_Finding_ConstructorAcceptsTheTokenItselfAsFeeRecipient`, which uses
`vm.computeCreateAddress` to do exactly that, mints, and shows `withdrawFees` reverting while the
reserve invariant holds.

**Impact.** None in a sane deployment: it requires the deployer to deliberately name the address
it is deploying to. It is reported because the same rule is enforced in one of the two places it
applies, and an asymmetric guard is the kind of thing a later refactor reads as intentional.

**Recommended fix.** In the constructor, after the address is knowable, add
`if (feeRecipient_ == address(this)) revert AdminInvalidFeeRecipient(address(this));`.

**Compatibility.** ABI and storage unchanged; one new constructor revert path.

**Status.** Fixed. The constructor now rejects `address(this)` with the same
`AdminInvalidFeeRecipient` error as `setFeeRecipient`, in `src/Shapes.sol`. Covered by
`test/audit/V9FeesAndPresentation.t.sol:test_Finding_ConstructorRejectsItsOwnPredictedAddressAsFeeRecipient`
(uses `vm.computeCreateAddress` to predict the deployer's own address) and
`test_Finding_ConstructorRejectsZeroFeeRecipient`.

### V9-4 — the `uint96` id bound rests on gas, not on deposited ETH

**Severity** Informational. **Path** `src/ShapeTypes.sol:35-46` (the comment and
`ComposeInput.id`), `:52-59` (`ComposeRecord.ownerTokenFrom`), `:66-73` (`SplitRecord.parentId`),
`src/lib/RecompositionOps.sol:334-335`.

**Description.** `ShapeTypes.sol:36-38` justifies the `uint96` id fields as follows:

> All ids stored here must fit in `uint96`: ids are issued one per mint and each mint costs at
> least one 0.01 ETH unit of backing.

The first clause is false. `RecompositionOps.split` issues `k` fresh ids straight off the counter:

```solidity
// src/lib/RecompositionOps.sol:334
uint256 firstId = st.totalMinted;
st.totalMinted = firstId + k;
```

No backing enters and no mint fee is charged. Splitting a token into `k` children and composing
them back into one costs only gas and raises `totalMinted` by `k` each cycle, indefinitely, on a
fixed amount of deposited ETH.

The casts are still safe, but for a different reason. `k` is bounded by
`ShapeMath.requireSplitSumMatches`: the outputs must sum to the parent's backing and each is at
least one unit, so `k <= 10000` on the mainnet ladder. Each cycle therefore writes on the order of
`k` storage slots, and reaching `2**96` ids needs roughly `10**24` such cycles. The real bound is
gas and block space, not ETH.

To answer the brief's question for each narrowing cast at this commit:

| cast | bound | proven by |
| --- | --- | --- |
| `ComposeInput.id` (`uint96`), `ComposeRecord.ownerTokenFrom` (`uint96`), `SplitRecord.parentId` (`uint96`) | gas | not in code; `totalMinted` grows with mints and with every split, and split is ETH-free |
| `ComposeInput.originCount`, `ComposeRecord.survivorOriginCount`, `ShapeData.originCount` (`uint32`) | 10,000 | in code: `originCount <= unitsAt(denomIndex)` holds at mint (1 <= units), at compose (`acc.origins <= acc.total / UNIT`), at decompose (restores recorded values) and at split (`ShapeMath.allocateSplitOrigins` caps each child at its own capacity and `assert`s the fill exhausts) |
| `SplitOriginRef.childIndex` (`uint32`) | 10,000 | in code: `requireSplitSumMatches` bounds `outDenoms.length` by `parentBacking / UNIT` |
| `SplitOriginRef.recordIndex` (`uint64`) | gas | not in code; one record per `split` call, each of which burns a token and mints at least two |

**Reproduction.** `test/audit/V9FeesAndPresentation.t.sol`:
`test_Finding_SplitIssuesIdsWithoutNewBacking` runs three split-and-recompose cycles and asserts
`totalMinted` grows by five each time while `redeemableBacking` and `pendingFees` do not move.

**Impact.** None at this commit. It is reported because the brief asks each narrowing cast to be
proven by an invariant in code or by an economic bound, and this one is recorded in the code as
having an economic bound it does not have.

**Recommended fix.** Correct the comment: state that ids are issued by mint and by split, that
split is free of new backing, and that the width therefore rests on the gas cost of the
split-and-recompose cycle rather than on a per-id ETH cost.

**Compatibility.** Comment only.

**Status.** Fixed. `src/ShapeTypes.sol`'s `ComposeInput` doc now states the real bound: ids are
issued by mint and by split, each costing gas, so `2**96` ids is unreachable by gas alone. It is
the only place in `src/` that stated the false per-mint-ETH justification; `ComposeRecord` and
`SplitRecord` did not restate it, so no other edit was needed.

### V9-5 — the library-isolation argument covers two of five linked libraries

**Severity** Informational. **Path** `test/LibraryIsolation.t.sol:43-51,94-97`,
`src/Shapes.sol:27-32`.

**Description.** `Shapes`'s bytecode carries link references for five libraries, not two:
`AdminOps`, `EIP712Signature`, `GeometrySampling`, `InkGenes`, `RecompositionOps`
(`out/Shapes.sol/Shapes.json` `linkReferences`). `RecompositionOps` links `ComposeCompute` and
`GeometrySampling`, and `ComposeCompute` links `GeometrySampling` and `InkGenes`, so a compose
runs a three-deep `DELEGATECALL` chain, every frame of which executes in `Shapes`'s storage
context. `ShapeCollection` separately links `CopyValidation` and `InkGenes`.

`test/LibraryIsolation.t.sol` covers `RecompositionOps` and `AdminOps` and attributes their
isolation to compiler call protection:

> solc emits call protection into every public library with a non-view, non-pure external
> function: the runtime compares `address(this)` against the library address written into its own
> code at deployment and reverts when they match

That is accurate for those two, and the same file's second test already notes that a `public pure`
function is left unguarded. But `GeometrySampling`, `EIP712Signature` and `CopyValidation` expose
only `pure` or `view` public functions, so they carry no call protection at all and answer a
direct `CALL` normally. What makes them safe is not the guard: it is that they take no storage
pointer and write nothing, so a direct call has nothing to reach. The isolation argument as
written does not cover them and names the wrong mechanism for the ones it does not cover.

Verified separately: solc reaches a linked library by `DELEGATECALL` even from a `view` caller, so
`EIP712Signature.artistDigest`'s `address(this)` is `Shapes`, and two deployments sharing one
linked `EIP712Signature` have different EIP-712 domains. A signature for one does not verify on
the other.

**Reproduction.** `test/audit/V9ViewsAndLibraries.t.sol`:
`test_Attempt7_DirectCallsToEveryLinkedLibrary` calls every public library directly, including the
three unprotected ones, and asserts a twenty-field `Shapes` state fingerprint is unchanged.
`test_ArtistDigestIsBoundToTheTokenNotTheLibrary` recomputes the EIP-712 digest with
`verifyingContract = address(shapes)` and matches it against `artistAttestationDigest`.
`test/audit/V9AuthorityAndCustody.t.sol:test_ArtistAttestationIsOneShotAndBound` shows a signature
for one deployment failing on a twin.

**Impact.** None. The property holds; the recorded reason for it is incomplete.

**Recommended fix.** Extend `test/LibraryIsolation.t.sol` to the three pure/view libraries and
state the actual reason for each class: call protection for the libraries that take a storage
pointer, and the absence of a storage pointer for the rest.

**Compatibility.** Tests and comments only.

**Status.** Partially fixed. `test/LibraryIsolation.t.sol`'s header now names all five libraries
`Shapes` links (`AdminOps`, `EIP712Signature`, `GeometrySampling`, `InkGenes`,
`RecompositionOps`, confirmed against `linkReferences` in `out/Shapes.sol/Shapes.json`) and states
the correct split: `AdminOps` and `RecompositionOps` carry compiler call protection because they
expose non-view/non-pure public functions taking a storage pointer; `EIP712Signature`,
`GeometrySampling` and `InkGenes` expose only `pure`/`view` public functions, so solc emits no
guard, and they are safe because no public function of theirs takes a storage pointer. Deferred:
extending the test bodies to exercise a direct call against `EIP712Signature`, `GeometrySampling`
and `InkGenes` with a Shapes-state fingerprint assertion (still only `RecompositionOps` and
`AdminOps` are exercised there; `test/audit/V9ViewsAndLibraries.t.sol:test_Attempt7_DirectCallsToEveryLinkedLibrary`
separately covers `GeometrySampling`, `EIP712Signature`, `RecompositionOps` and `AdminOps`, but not
`InkGenes`).

### V9-6 — the decompose invariant reports a false failure on `decomposeMany`

**Severity** Low (test defect; no contract impact). **Path** `test/Invariants.t.sol:643-663`
(`Handler.decomposeMany`), `:186-198` (`Handler._checkRestore`), `:768-770` (the invariant).

**Description.** Running the suite with fuzz seed
`0x9cedeff0a97ee43e647fbb4a77c1d15aa221d07bfe2a226aac333b7b748642eb` fails
`invariant_DecomposeRestoredEveryRecordedState` with "decompose did not restore a recorded
pre-compose state", shrunk to seventeen calls. The contract is not at fault.

`Handler.decomposeMany` sends `Shapes.decomposeMany` a list of `reps = min(depth, 2)` copies of one
survivor id, so the contract pops that many records in one atomic call, and only then does the
handler check:

```solidity
// test/Invariants.t.sol:657
try shapes.decomposeMany(ids) returns (uint256[][] memory restored) {
    for (uint256 i = 0; i < restored.length; ++i) {
        _checkRestore(survivor, restored[i]);
```

`_checkRestore` pops one recorded pre-compose hash and compares it against `_hashState(survivor)`,
read live. By the time the loop runs, every pop has already happened, so the survivor is in its
fully unwound state for all `reps` comparisons. With `reps == 2` the first comparison expects the
state between the two pops and sees the state after both. It mismatches for correct behaviour.

The restored-input half of the check is sound, because a restored input's final state is its
restored state. Only the survivor half is wrong, and only on this path. `Handler.decompose` and
`Handler.decomposeToHostile` unwind one record per call and check immediately, so they are correct.

**Reproduction.** `test/audit/V9InvariantReplay.t.sol` replays the seventeen calls deterministically
outside the fuzzer, in either profile:

- `test_Replay_ReproducesTheRestoreMismatch` — the sequence sets the handler's flag.
- `test_Replay_BisectTheFlaggingCall` — the flag is set by call 17, the `decomposeMany`.
- `test_Diagnose_ContractAgainstItsOwnRecord` — reads both `composeRecordAt` records before the
  decompose and asserts, field by field, that the survivor and all five restored inputs match what
  the records claim afterwards. They do: seed, denomination, origin count, ink gene, Black flag and
  module bytes all match. **The contract restored both records exactly.**
- `test_Diagnose_SameRecordsUnwoundOneCallAtATime` — the same two records, the same contract work,
  unwound through two `Handler.decompose` calls instead of one `decomposeMany`. No mismatch. Only
  the moment the handler's check runs differs.

**Impact.** No ETH, no ownership, no contract behaviour. The cost is to the safety net, and it is
larger than it looks: two of the three unseeded `forge test` runs made during this audit failed
this invariant, on unrelated seeds and on different profiles. The suite is red roughly as often as
it is green. On the `decomposeMany` path the survivor comparison also never tests anything true,
so the check is both noisy and, for that path, vacuous. A team that sees this failure and concludes
the invariant is flaky is one step from switching off the check that would catch a real decompose
regression.

**Recommended fix.** Check the survivor once, against the oldest hash popped, and keep the
per-record input checks:

```solidity
// pop reps hashes; the survivor must end at the state the OLDEST one recorded
bytes32 expected;
for (uint256 i = 0; i < restored.length; ++i) expected = _popPreHash(survivor);
if (_hashState(survivor) != expected) restoreMismatch = true;
for (uint256 i = 0; i < restored.length; ++i) { /* input checks, as today */ }
```

**Compatibility.** Test only. No contract change.

## 2. Properties verified

Every property in `AUDIT_PROMPT_v8.md` section "Properties to falsify", plus the deltas named in
the v9 brief.

### Reserve and ETH

| property | evidence | caveat |
| --- | --- | --- |
| No sequence makes `address(this).balance < redeemableBacking() + pendingFees()` | `_assertReserveInvariant` runs at the end of 21 of this audit's tests, across mint, redeem, compose, decompose, split, `burnBacking`, fee withdrawal, forced ETH, hostile renderer and auction paths; `test/Invariants.t.sol` carries the stateful version | Reasoned, not proved: the only three ETH outflows are `_sendEth` from `_redeemTo`/`_redeemBatchTo`, `burnBacking` and `withdrawFees`, and each subtracts from the matching accumulator before the call |
| Redemption updates accounting and burns before sending | `src/Shapes.sol:522-531,561-584`: `_burnForRedemption` clears `_store.shapes`, `_store.modules` and calls `_burn` before `_sendEth`; `redeem`/`redeemTo`/`burn`/`redeemBatch*` are all `nonReentrant` | A receiver that reverts reverts the whole redemption; it cannot leave a burned token counted |
| A reentering receiver cannot extract more than its backing | `test_Attempt1_ReentrantReceiverDuringDecompose` reenters `redeem`, `burn`, `decompose`, `burnBacking`, `withdrawFees` and `mint` from four separate `onERC721Received` frames; every attempt is refused by the guard, and the counters are asserted equal | |
| `burnBacking` moves the exact backing and never lets a Black token redeem | `src/Shapes.sol:794-814` reads the amount from `Denominations.amountAt(APEX_INDEX)` rather than a stored field; `test_BlackShapeCannotEnterAnyRecord`, `test_BlackSurvivorFreezesItsRecord` | `_requireCallerOwnsLive` rejects a Black token on every recomposition and redemption path except `burn`, which pays zero |
| `withdrawFees(recipient)` sends exactly `feesOwedTo(recipient)` and nothing from the reserve; the per-recipient sum equals `pendingFees()` | `test_Attempt5_PerRecipientFeesSumToPendingFees` asserts the sum after every mint, recipient change and withdrawal | See V9-2 for the unrecoverable case |
| Compose, decompose and split never change total `redeemableBacking` | asserted in `test_Attempt1_*`, `test_RoundTrip_*`, `test_Attempt4_*`, `test_Finding_SplitIssuesIdsWithoutNewBacking` | Structural: none of the three touches `redeemableBacking` at all |

### Recomposition

| property | evidence | caveat |
| --- | --- | --- |
| Compose burns the inputs, keeps the survivor, records enough to undo it | `test_RoundTrip_SplitChildrenAndOwnerTokenAsInputs` compares a thirteen-field fact snapshot (holder, seed, denomination, origins, gene, Black, backing, compose depth, stored modules, effective modules, `tokenURI`, split-child flag, split parent) for every token across a compose and decompose | The `tokenURI` comparison is the strongest single check: it folds the renderer's whole view of the token into one string |
| Decompose pops one record, restores prior state, re-mints under original ids, never collides | `test_NestedRecordsUnwindLIFO`, `test_RoundTrip_OwnerTokenAsBurnedInput`, `test_Attempt4_NestedTreeThroughBatchEntrypoints`, and `test_Diagnose_ContractAgainstItsOwnRecord`, which checks a two-deep `decomposeMany` against `composeRecordAt`'s own reading of both records | Collision-freedom is structural: a fresh id always comes from `totalMinted`, which is already past every id a record can hold, and an id can be in at most one live record because being in one means it does not exist. The one invariant failure seen in this audit is V9-6, a handler defect, and the contract was verified correct on the exact sequence that produced it |
| Split burns the parent, mints children summing to the parent's backing, and provenance reconstructs | `test_Attempt4_MaximalBatchesRoundTrip` (a hundred children), `test_Attempt4_SplitProvenanceSurvivesRecomposition` | |
| Owner token: exactly one live token holds it; compose moves it to the survivor, decompose restores it after every restored id exists, split moves it to the first child before minting; `owner() == ownerOf(ownerToken())` | `test_Attempt1_ReentrantReceiverDuringSplitOfOwnerToken` records `ownerToken()` and `ownerOf` in every one of the five mint callbacks and asserts the pointer never named a dead id; `test_RoundTrip_OwnerTokenAsBurnedInput`, `test_Attempt9_OwnerTokenAsTheLot` | The one window where the pointer names a burned id is inside `_splitTo` between `_burn(tokenId)` and the pointer move (`src/Shapes.sol:690-699`), and no external call happens there |
| Previews take no account, check no ownership, and share every other gate | `test_PreviewsMatchTheMutatorsForTheHolder` (bob previews alice's compose and gets alice's result), `test_Attempt4_DegenerateComposeInputsAreRejected` (preview and mutator reject the same inputs with the same errors) | Gate order was compared line by line: `_compose` at `src/Shapes.sol:635-645` against `previewCompose` at `src/lib/RecompositionOps.sol:454-469`, and `_splitTo` at `:684-701` against `previewSplit` at `:515-524`. Same order, ownership omitted |
| Narrowing casts | see the table in V9-4 | Two of the six rest on gas, not on an in-code invariant |

### Minting

| property | evidence | caveat |
| --- | --- | --- |
| `mintStart` gates every path that creates a backed token, including ETH-backed escrow bids; token #0 is the sole exception | `test_Attempt6_MintStartBoundary` (all four entrypoints at `start - 1` and at `start`), `test_Attempt6_EthBackedBidsAreGatedByMintStart` | The gate is a single check in `_mintBatch` (`src/Shapes.sol:408`), which every mint entrypoint routes through; `ShapeCardEscrow._mintCards` reaches it through `mintBatchTo`. The test also shows no recomposition path can issue a token before `mintStart`, because Shape #0 is the only live token and a 0.01 token cannot be split |
| Seeds distinct within a batch, do not affect backing, grindable | `src/Shapes.sol:430,448`: one root per batch, each token's seed mixes its own id; backing comes from `amountWei`, never from the seed | Grindability is documented at `src/Shapes.sol:413-420`. No protocol rule reads a seed for anything but geometry and the ink gene |
| The mint fee is bounded by the cap on every path | `test_Attempt5_MintFeeCap` covers `setMintFee` and the constructor | `AdminOps.MAX_MINT_FEE == Denominations.UNIT`, checked in `AdminOps.setMintFee` and in `Shapes._requireFeeWithinCap` |

### Authority

| property | evidence | caveat |
| --- | --- | --- |
| `admin()` is the only privileged role; nothing reads `owner()` or the owner token for authorization | `test_OwnerTokenGrantsNoAuthority` puts the owner token in alice's hands and shows all ten admin entrypoints plus `ShapeCollection.setMetadataCopy` refusing her; grep confirms `_ownerToken` is read only by `owner()`, `ownerToken()`, `_renderInputs` and the three recomposition movers | |
| `lockPresentation` freezes renderer, collection and copy; the copy lock is read live | `test_Attempt8_LockOrdering` locks and then shows both the installed and a previously installed `ShapeCollection` refusing `setMetadataCopy` | See V9-1: the copy freeze binds `ShapeCollection`, not an arbitrary installed collection |
| Pointers: ERC-165 required, zero clears, lock permanent; `positionOf` bounded and zero on failure | `test_Attempt2_HostilePositionsTargets` covers revert, gas exhaustion, short return, a 60,000-byte return, dirty upper bits, and a target that reenters `Shapes` from the staticcall frame. Measured cost of one `positionOf` call: 6,818 to 56,451 gas across those six | The returndata bomb is bounded because the callee must pay memory expansion inside its own 50,000 gas stipend |
| Artist attestation: one per contract, EIP-712 bound to chain id, contract, artist and hash; ECDSA first then ERC-1271; never replaceable | `test_ArtistAttestationIsOneShotAndBound`, `test_ArtistDigestIsBoundToTheTokenNotTheLibrary` | |
| `attestArtist` is ungated and a relayer can store nothing but the artist's own approved hash | `src/lib/AdminOps.sol:208-226`: the stored `releaseHash` is the one the signature covers, and the zero hash is refused, so the "already attested" check cannot be primed | An ERC-1271 artist can approve an arbitrarily long signature blob, which is then stored; that is the artist's own choice |

### Reentrancy and callbacks

| external call | from | what the callback sees and can change |
| --- | --- | --- |
| `_safeMint` receiver hook, mint | `_mintBatch` (`src/Shapes.sol:462`), `nonReentrant` | Every storage write for the whole batch is already done; `totalSupply` and `redeemableBacking` hold the batch's end state while only some tokens exist. All guarded mutators refused |
| `_safeMint` receiver hook, split | `_splitTo` (`:706`), `nonReentrant` | Owner token already moved to child 0, which exists by the first callback. Guarded mutators refused; unguarded ERC-721 transfers allowed |
| `_safeMint` receiver hook, decompose | `_decomposeTo` (`:780`), `nonReentrant` | Restored tokens exist in `_store` but not yet in ERC-721 for indexes after the current one, so `shapeState`/`tokenURI` on them revert `ERC721NonexistentToken`; the owner-token pointer still names the survivor and only moves after the loop |
| `_sendEth` | `_redeemTo`, `_redeemBatchTo`, `burnBacking`, `withdrawFees`, all `nonReentrant` | State fully updated. `burnBacking`'s destination is a fixed address with no code |
| `positionOf` staticcall | `positionOf` (`:1087`), `view`, 50,000 gas | Read-only frame; any write reverts and the failure is swallowed |
| `supportsInterface` | `AdminOps._supports` (`:231`), `try/catch` | Admin's own transaction; a hostile target can only burn the admin's gas |
| ERC-721 `safeTransferFrom` receiver hook | inherited, **not guarded** | The receiver owns the token and may redeem, compose or split it inside the callback. Documented at `src/Shapes.sol:53-57`. Accounting stays exact; the sender must not assume the token still exists afterwards |
| Renderer and collection calls in `tokenURI` and friends | `view` | See V9-1 |

Self-custody: `test_SelfCustodyIsRefusedEverywhere` covers `transferFrom`, `safeTransferFrom`,
`mintTo`, `splitTo` and `decomposeTo` with `address(shapes)` as the destination. All five revert
`SelfCustodyRejected` from the single `_update` override (`src/Shapes.sol:1201`).

### Auction house and escrow

`test_Attempt9_OwnerTokenAsTheLot` runs the whole life of an auction whose lot is the owner token:
listing moves `owner()` to the house while `admin()` and `ownerToken()` are unchanged; a card bid,
an outbid, the seller's refused self-bid, the outbid bidder's intact withdrawal, the leader's
refused withdrawal, settlement, the seller's pull of the winning cards, a non-recipient's refused
`claimLot`, and the winner's claim, after which `owner()` is the winner.
`test_Attempt9_CancelAndBlackCards` covers the duplicate-listing guard, the empty bid, cancellation
with no bidder and the seller's pull-back. `test_Attempt6_EthBackedBidsAreGatedByMintStart` covers
the ETH-bid path either side of `mintStart`. The reserve invariant is asserted at the end of each.

The house holds no authority over `Shapes`: it is registered only as the `market` pointer, which
`AdminOps` documents and the code confirms is read by nothing in the token or reserve paths.
A Black Shape cannot be bid, because `ShapeCardEscrow._takeCards` values a card by `backingOf`,
which is zero for a Black Shape, and rejects zero (`src/ShapeCardEscrow.sol:64-65`).

### Presentation

`ShapeRenderer` has no owner, no setters and no mutable state (`src/ShapeRenderer.sol`, every
function `pure` or `view` over its arguments). `test_TokenIdViewsWriteNothing` asserts a
twenty-field state fingerprint is unchanged across `svg`, `metadataJSON`, `geometryOf`,
`effectiveModulesOf`, `moduleAt`, `unicodeCard` and `tokenURI`, and that `tokenURI` is byte-stable
across them. `test_EveryTokenIdViewRequiresTheTokenToExist` shows all seven entering `_requireOwned`
for a burned id and for a never-minted id. `test_EffectiveModulesMatchWhatTheRendererDraws`
decodes `effectiveModulesOf` byte by byte and matches kind, solid and rotation against
`moduleAt`'s answer, on the grammar-v1 branch, the compose-survivor branch and a split child; the
length is matched against `geometryOf`'s module count. Metadata copy is validated for JSON safety
and length before storage (`src/lib/CopyValidation.sol:19-47`, a full RFC 3629 walk).

### Deltas named in the v9 brief

| delta | verified |
| --- | --- |
| Per-recipient fee accrual, `feesOwedTo`, `withdrawFees(address)`, `pendingFees()` as the total | Yes. `test_Attempt5_PerRecipientFeesSumToPendingFees`, `test_Attempt5_ARevertingRecipientBlocksOnlyItself`, `test_Attempt5_SetFeeRecipientRejectsZeroAndSelf`. See V9-2 |
| Storage layout shift (`pendingFees` became two slots; everything after `_artistAttestation` moved by one) | Confirmed by `forge inspect Shapes storageLayout`: `_feesOwed` 18, `_totalFeesOwed` 19, `_artistAttestation` 20, `_presentation` 22, `_pointers` 24, `_admin` 26, `_ownerToken` 27. No proxy exists, so the shift has no upgrade consequence. `ReentrancyGuard` uses an ERC-7201 namespaced slot and does not collide. The two tests that hardcode slots (`test/LibraryIsolation.t.sol:23-24`, `test/Sampling.t.sol:415`) still name the right ones |
| `setRenderer` requires ERC-165 for both `IShapeRenderer` and `IShapeGeometry` | Yes. `test_SetRendererRequiresBothRendererAndGeometryInterfaces` probes one interface at a time |
| `setCollection` requires ERC-165 plus `collection.shapes() == address(this)`; `lockPresentation` requires a collection | Yes. `test_Attempt10_CollectionMustNameThisToken`, `test_Attempt8_LockOrdering`, `test_Attempt8_LockRequiresACollection` |
| Five token-id views enter `_requireOwned`, write nothing, cannot break `tokenURI`; `effectiveModulesOf` matches what the renderer draws | Yes, see Presentation above |
| `GeometrySampling` is pure, takes no storage pointer, cannot affect `Shapes` state; whether the isolation reasoning needs to cover it | Yes, and it does need to. See V9-5 |
| `ShapeCollection` three copy fields, `ownerTokenDescription` selected for the owner token, `contractURI()`/`json()` take no parameters, symbol `SHAPE`, `isBlackShape` | Confirmed by reading: `src/ShapeCollection.sol:64-66,105-120,132-149`, `src/Shapes.sol:214,850,1004,1150`. The owner-token description is selected by `r.ownerToken`, which is `tokenId + 1 == _ownerToken` |
| `previewCompose`/`previewSplit` take no account; every gate but ownership shared | Yes, see Recomposition above |
| Decompose round trip restores every observable fact, against callbacks, nested records, split children as inputs, the owner token and Black inputs | Yes. Nothing broke it. The one apparent counterexample, a fuzz-seed invariant failure, was traced to the handler and the contract verified correct on that exact sequence: V9-6. See the Recomposition table and section 4 |
| Tenth attempt: an ERC-165 liar installed and locked | Yes, and it produced V9-1 |

## 3. Trust model

Every `Shapes` function that reaches a linked library, the check that runs before it, and the
library function reached. `internal` library functions are inlined into `Shapes`'s own bytecode
and make no call; they are listed where they carry a gate, marked *(inlined)*.

| `Shapes` function | check that runs first | library function reached |
| --- | --- | --- |
| `constructor` (`:212`) | deploy-time only: non-zero fee recipient, renderer validity, fee cap, exact `msg.value` | `AdminOps.requireRenderer` *(inlined)*; `InkGenes.geneAtMint` (delegatecall) |
| `artistAttestationDigest` (`:261`) | none; `view` | `EIP712Signature.artistDigest` |
| `attestArtist` (`:266`) | none by design; the EIP-712 signature over `(chainId, address(this), artist, releaseHash)` is the gate, and `releaseHash != 0` plus "not already attested" run inside | `AdminOps.attestArtist` → `EIP712Signature.artistDigest`, `EIP712Signature.isValidNow` |
| `setFeeRecipient` (`:296`) | `onlyAdmin` | `AdminOps.setFeeRecipient` (rejects zero and `address(this)`) |
| `setMintFee` (`:307`) | `onlyAdmin` | `AdminOps.setMintFee` (rejects above `MAX_MINT_FEE`) |
| `setRenderer` (`:312`) | `onlyAdmin` | `AdminOps.setRenderer` → `_requireUnlocked`, `requireRenderer` |
| `setCollection` (`:317`) | `onlyAdmin` | `AdminOps.setCollection` → `_requireUnlocked`, `requireCollection` |
| `lockPresentation` (`:322`) | `onlyAdmin` | `AdminOps.lockPresentation` → `_requireUnlocked`, collection set |
| `setPointer` (`:335`) | `onlyAdmin` | `AdminOps.setPointer` → per-pointer lock, `_requireTarget` |
| `lockPointer` (`:340`) | `onlyAdmin` | `AdminOps.lockPointer` → per-pointer lock |
| `mint`, `mintTo`, `mintBatch`, `mintBatchTo` (`:359-386`) | `nonReentrant`, then in `_mintBatch`: `block.timestamp >= mintStart`, `quantity != 0`, supported denomination, exact `msg.value` | `InkGenes.geneAtMint` |
| `compose`, `composeMany` (`:600,609`) | `nonReentrant`; `burnIds.length != 0`; `RecompositionOps.requireLiveOwner(survivor)` *(inlined)*; per input `RecompositionOps.requireComposeInput` *(inlined)* | `RecompositionOps.requireDistinctComposeInputs`; `RecompositionOps.compose` → `ComposeCompute.composeSampleAndGene` → `GeometrySampling.sampleComposeSorted`, `InkGenes.geneAtCompose` |
| `split`, `splitTo` (`:667,676`) | `nonReentrant`; `outDenoms.length >= 2`; `requireLiveOwner` *(inlined)* | `RecompositionOps.split` → `GeometrySampling.effectiveModulesOf`, `buildSplitRecordPoolSorted`, `sampleSplitChildFromPool` |
| `decompose`, `decomposeTo`, `decomposeMany`, `decomposeManyTo` (`:717-750`) | `nonReentrant`; `requireLiveOwner` *(inlined)*; record depth `!= 0` inside | `RecompositionOps.decompose` |
| `burnBacking` (`:794`) | `nonReentrant`; `requireLiveOwner` *(inlined)*; apex index and Complete origin count | none (all inlined) |
| `redeem`, `redeemTo`, `burn`, `redeemBatch`, `redeemBatchTo` (`:486-515`) | `nonReentrant`; non-zero recipient; `_requireOwned` and caller-is-owner; Black rejected unless `burn` | none |
| `withdrawFees` (`:470`) | `nonReentrant`; `_feesOwed[recipient] != 0` | none |
| `shapeState` (`:921`) | `_requireOwned` | `RecompositionOps.shapeState` |
| `composeRecordAt` (`:884`) | none; depth range checked inside | `RecompositionOps.composeRecordAt` |
| `previewCompose` (`:934`) | none by design (ownership deliberately omitted); every structural gate runs inside | `RecompositionOps.previewCompose` → `ComposeCompute.composeSampleAndGene` |
| `previewSplit` (`:945`) | none by design; every structural gate runs inside | `RecompositionOps.previewSplit` |
| `effectiveModulesOf` (`:1052`) | `_requireOwned` | `GeometrySampling.effectiveModulesOf` |

No path was found where a check is missing or runs after a state write. Two properties hold across
the whole table:

1. **The libraries write only what `Shapes` hands them.** `RecompositionOps` receives `_store`;
   `AdminOps` receives one of `_feeConfig`, `_artistAttestation`, `_presentation`, `_pointers`.
   No library body contains `_mint`, `_burn`, a `call` with value, a write to `_admin`, or a write
   to `_ownerToken`. Minting, burning and the owner-token pointer are moved by `Shapes` alone
   (`src/Shapes.sol:647-651,695-699,783-786`). The storage-pointer parameter is not a security
   boundary — a linked library runs by `DELEGATECALL` in the caller's storage and could name any
   slot — so the libraries were audited as `Shapes` code, and V9-4 and V9-5 are the only findings
   from that pass.
2. **The link is fixed at deploy time.** Library addresses are placeholders resolved at link time
   and written into `Shapes`'s immutable runtime code. There is no setter, no proxy and no
   `CREATE2` redirection: `grep` over `src/` finds no `delegatecall`, no `CREATE2`, and no
   assignment to any library address. `src/Shapes.sol` declares no address field for a library.

## 4. Not exploitable, worth knowing

**Split leaves the parent's compose stack behind.** `RecompositionOps.split` deletes
`st.shapes[tokenId]` and `st.modules[tokenId]` but not `st.composeStack[tokenId]`
(`src/lib/RecompositionOps.sol:325-326`). Compose does the same for its burned inputs
(`:176-177`), which is required — decompose has to find the input's own nested records. For split
the record is orphaned, because a split parent is burned and no path re-issues its id: every new
id comes from `totalMinted`, already past it, and only a compose record revives an old id.
`test_SplitLeavesTheParentsComposeStackBehind` pins this.

**Record reads answer for ids that no longer exist.** `composeDepth`, `composeRecordAt` and
`splitOriginOf` (`src/Shapes.sol:879,884,893`) read the record structures, not the token, and do
not call `_requireOwned`. After the survivor is redeemed, `composeDepth` still returns 1 and
`composeRecordAt` still returns the inputs. Read-only and useful for provenance, but an integrator
must not treat a non-zero answer as proof the token is live.
`test_RecordReadsAnswerForDeadIds`.

**A view inconsistency exists inside a decompose callback.** Between `RecompositionOps.decompose`
returning and the end of the `_safeMint` loop (`src/Shapes.sol:771-781`), the restored tokens have
`_store` state but no ERC-721 owner yet. `totalSupply()` already counts them, `redeemableBacking`
already counts backing that no live token currently carries, and `shapeState`/`tokenURI` on a
not-yet-minted restored id revert. Nothing mutable is reachable (the whole call is `nonReentrant`),
but an integrator reading supply or backing from inside `onERC721Received` sees a transient state.
The analogous mint window is documented at `src/Shapes.sol:458-460`; the decompose one is not.

**`sampleCompose`'s termination rests on grid monotonicity, not a runtime check.**
`src/lib/GeometrySampling.sol:192-234` draws one module per result cell from a donor without
replacement. It is safe because `Denominations.gridAt` is strictly decreasing in denomination
index and every donor's index is strictly below the result's, so every donor alone has more
modules than the result has cells. If a future ladder broke that, `--remaining[donorIdx]` would
underflow and panic rather than corrupt state, which is the right failure mode, but the argument
lives in a comment rather than in an assertion.

**`renounceAdmin` before `lockPresentation` reaches a third end state.** Presentation is then
permanently unlocked and permanently unchangeable: `presentationLocked()` reads `false` forever
while `setRenderer`, `setCollection`, `lockPresentation` and `ShapeCollection.setMetadataCopy` all
revert `AdminUnauthorizedAccount(address(0))`'s caller check. Indistinguishable from "not yet
locked" to any reader of `presentationLocked()`. `test_RenounceAdminFreezesPresentationWithoutLockingIt`.

**A mint-fee change between an escrow bidder's quote and their transaction reverts the bid.**
`ShapeCardEscrow._mintCards` reads `IShapes(shapes).mintFee()` live and requires an exact
`msg.value` (`src/ShapeCardEscrow.sol:78-80`). An admin raising the fee griefs in-flight ETH-backed
bids. Bounded by the fee cap, no value moves, and `IAdminControl.setMintFee` now documents the live
read. Unchanged from `AUDIT_REPORT_v8_claude.md` S-5.

**`withdrawFees` is permissionless.** Anyone may push a recipient its own accrued balance, which
hands a contract recipient execution at a time the caller chooses. The state is fully written
first and the call is `nonReentrant`, so this is a scheduling nuisance rather than a hazard.

**Forced ETH is inert.** `receive()` and `fallback()` both revert, so the only inbound paths are
`selfdestruct` and block rewards. `test_Attempt3_ForcedEthIsUnreachable` forces 3 ETH in and shows
redemption still paying face value and `withdrawFees` still paying exactly the accrued amount,
with the surplus stranded.

**A safe transfer's receiver can destroy the token inside the callback.** `safeTransferFrom` is
not guarded, so the receiver may `redeem`, `compose` or `split` the token it has just received
before returning. Accounting stays exact and the sender is paid nothing, which is the correct
outcome for a voluntary transfer. Documented at `src/Shapes.sol:53-57`; worth repeating because it
is the one place where an integrator's assumption about ERC-721 does not hold.

## Appendix: observations that are not findings

- `src/ShapeTypes.sol:36-38` is the comment corrected by V9-4. Two neighbouring comments carry the
  same shape of argument and are accurate: `:77-78` (`recordIndex` fits `uint64`, `childIndex`
  fits `uint32`) and `src/lib/RecompositionOps.sol:320-321,329-330`.
- `test/LibraryIsolation.t.sol`'s two `@dev` blocks (`:46-51`, `:96-97`) are the comments
  corrected by V9-5.
- `src/Shapes.sol:199-200`'s `@param feeRecipient_` says a reverting recipient "blocks
  `withdrawFees`". After the per-recipient change it blocks only that recipient's withdrawal, and
  blocks it permanently. Both halves are worth stating.
- The v9 brief describes `GeometrySampling` as "a third public linked library". `Shapes` links
  five (`AdminOps`, `EIP712Signature`, `GeometrySampling`, `InkGenes`, `RecompositionOps`) and
  reaches `ComposeCompute` transitively through `RecompositionOps`; `ShapeCollection` links
  `CopyValidation` and `InkGenes`.
- `forge build` emits `internal-function-used-once` notes for `AdminOps.requireCollection` and
  `RecompositionOps.requireComposeInput`, and `missing-inheritance` notes for mocks in
  `test/audit/`. Neither affects the build.
- This audit's mocks use `selfdestruct` as a test primitive, which emits a deprecation warning.

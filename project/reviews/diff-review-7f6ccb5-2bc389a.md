# Diff-focused security review: 7f6ccb5..2bc389a (2026-09-03)

Scope: `git diff 7f6ccb5..2bc389a -- src/ script/Deploy.s.sol script/deploy.sh`, read-only, against
`origin/claude/contracts-page` at `2bc389a`. Reference model: `project/ARCHITECTURE.md`,
`audits/AUDIT_PROMPT_v8.md`. Prior results: `project/reviews/architecture-security-2026-09-03.md`,
`audits/AUDIT_REPORT_v8_claude.md`.

Baseline reproduced at `2bc389a`: `forge build --sizes` clean, `forge test` 615 passed, 0 failed,
4 skipped (619 total). Two attempts added under `test/audit/DiffReview7f6ccb5.t.sol`, both pass and
both reproduce a finding below.

## Findings

| # | Severity | Finding | path:line | Status |
| --- | --- | --- | --- | --- |
| D-1 | Low | `geometryOf` and `moduleAt` call `IShapeGeometry` on `renderer()`, but `setRenderer` requires ERC-165 only for `IShapeRenderer`. A renderer that answers the checked interface and not the called one installs cleanly, breaks both views, and `lockPresentation` makes that permanent. | `src/Shapes.sol:1043`, `src/Shapes.sol:1073`, `src/lib/AdminOps.sol:75` | Fixed: `test_SetRendererRejectsARendererThatCannotAnswerIShapeGeometry` |
| D-2 | Low | `setFeeRecipient` rejects only `address(0)`. `address(this)` is accepted, whose `receive` reverts, so every fee accrued while it is set is permanently unwithdrawable: per-recipient accrual removed the redirect-and-retry recovery the shared pool had. | `src/lib/AdminOps.sol:133`, `src/Shapes.sol:470` | Fixed: `test_SetFeeRecipientRejectsTheTokenItself` |
| D-3 | Informational | Storage layout shifted: `pendingFees` (one slot) became `_feesOwed` + `_totalFeesOwed` (two slots), moving every field from `_artistAttestation` onward by +1. | `src/Shapes.sol:111` | Report only, nothing deployed at this layout |
| D-4 | Informational | The library-isolation evidence carries the pre-shift slot constants, so its crafted storage pointers no longer name the fields the comments claim. | `test/LibraryIsolation.t.sol:24`, `test/audit/LibraryDirectCall.t.sol:24` | Fixed: slot constants re-pinned from `forge inspect Shapes storage-layout` |
| D-5 | Informational | Two arms of the direct-call sweep use the pre-`845a3ed` preview selectors `0x65e1e9f6` / `0xa3ac9ef9`, which no longer exist on `RecompositionOps` (now `0xfbd9b802` / `0x723eef4c`). | `test/audit/LibraryDirectCall.t.sol:108` | Fixed: `test_EveryRecompositionOpsEntryAtItsOwnAddressLeavesShapesUntouched` calls the live selectors |
| D-6 | Informational | `MintFeeAccrued(uint256)` still names only an amount, so an event-only consumer cannot attribute a fee to a recipient without replaying `FeeRecipientSet`. | `src/interfaces/IShapes.sol:48`, `src/Shapes.sol:443` | By design; `feesOwedTo` covers the read path |
| D-7 | Informational | `Shapes` runtime grew 20,342 → 22,460 bytes; EIP-170 margin fell from 4,234 to 2,116. | measured, `forge build --sizes` | Headroom note before mainnet |

### D-1 Renderer interface gap on the two new geometry views

`geometryOf` (`src/Shapes.sol:1037`) and `moduleAt` (`src/Shapes.sol:1059`) cast
`_presentation.renderer` to `IShapeGeometry` and call `cardGeometry`, `cardGeometrySampled`,
`moduleAt` or `moduleAtSampled`. `AdminOps.requireRenderer` (`src/lib/AdminOps.sol:75`) checks code
plus ERC-165 for `type(IShapeRenderer).interfaceId` and nothing else. Before this range `Shapes`
did not import `IShapeGeometry` at all, so the diff introduced a reader whose interface the setter
does not enforce. `ARCHITECTURE.md` §8 states the rule for pointers ("A pointer must answer the
interface its reader calls"); the renderer now has a second reader and is not held to it.

Reproduction: `test_SetRendererAcceptsARendererThatCannotAnswerIShapeGeometry`. A renderer
answering ERC-165 for `IShapeRenderer` only installs through `setRenderer`; `svg`, `tokenURI` and
`effectiveModulesOf` keep resolving, `geometryOf` and `moduleAt` revert, and `lockPresentation`
then freezes that state permanently.

Impact: two views, no ETH, no ownership, no effect on `tokenURI`. Admin-reachable only, and the
canonical `ShapeRenderer` implements both interfaces (`src/ShapeRenderer.sol:30`), so it is latent
rather than live. Recommended fix: add a `type(IShapeGeometry).interfaceId` check to
`requireRenderer`. That changes behavior (a renderer supporting only `IShapeRenderer` would be
refused) and no ABI or storage.

**Status: fixed.** `AdminOps.requireRenderer` now checks ERC-165 for `IShapeGeometry` alongside
`IShapeRenderer`. Test `test_SetRendererRejectsARendererThatCannotAnswerIShapeGeometry`
(`test/audit/DiffReview7f6ccb5.t.sol`) asserts the revert.

### D-2 The token itself is an accepted fee recipient, and accrual to it is now unrecoverable

`AdminOps.setFeeRecipient` (`src/lib/AdminOps.sol:133`) and the constructor reject only the zero
address. `Shapes.receive()` reverts `DirectDepositRejected` (`src/Shapes.sol:1221`), so
`withdrawFees(address(shapes))` reverts `EthTransferFailed` forever. Under the shared pool this was
recoverable: `withdrawFees()` paid the current recipient, and the removed NatSpec said so ("the
admin can redirect `feeRecipient` and retry"). Per-recipient accrual keeps the entry with the dead
recipient, so a redirect starts a fresh balance and the old one is stranded.

Reproduction: `test_FeeRecipientSetToTheTokenItselfStrandsFeesPermanently`.

Impact: admin-inflicted, bounded by the fees accrued during the misconfiguration, and it does not
break the reserve invariant (the ETH stays in the contract while `pendingFees()` keeps counting it,
so `balance >= redeemableBacking() + pendingFees()` still holds). The general reverting-recipient
case is the accepted S-4 and is warned about in `script/Deploy.s.sol:135`; that warning covers a
recipient supplied at deploy time, not a later `setFeeRecipient(address(this))`. Recommended fix:
reject `address(this)` in `setFeeRecipient` and the constructor, alongside the existing zero check.
Behavior change only, no ABI or storage change.

**Status: fixed.** `AdminOps.setFeeRecipient` now rejects `address(this)` alongside the zero
address, reverting `AdminInvalidFeeRecipient`. Test `test_SetFeeRecipientRejectsTheTokenItself`
(`test/audit/DiffReview7f6ccb5.t.sol`) asserts the revert. The constructor path was left
unchanged: this fix is scoped to `setFeeRecipient`, per the finding.

### D-3 Storage layout

Measured with `forge inspect Shapes storage-layout` at `2bc389a`, against the declarations at
`7f6ccb5`:

| Field | Slot at 7f6ccb5 | Slot at 2bc389a |
| --- | --- | --- |
| `_store` | 6 | 6 |
| `redeemableBacking` / `burnedBacking` / `blackShapeCount` | 13 / 14 / 15 | 13 / 14 / 15 |
| `_feeConfig` | 16 | 16 |
| `pendingFees` (public uint256) | 18 | removed |
| `_feesOwed` (mapping) | — | 18 |
| `_totalFeesOwed` | — | 19 |
| `_artistAttestation` | 19 | 20 |
| `_presentation` | 21 | 22 |
| `_pointers` | 23 | 24 |
| `_admin` | 25 | 26 |
| `_ownerToken` | 26 | 27 |

One slot became two, so everything from `_artistAttestation` onward moves by one. The
`pendingFees()` selector is preserved (public variable replaced by an explicit getter at
`src/Shapes.sol:125`), so the ABI keeps it; the storage slot it read is gone. No proxy, no
upgrade path and no deployment at either layout, so this matters only to anything reading `Shapes`
raw slots (the two isolation tests, D-4). `ShapeCollection` gained
`_ownerTokenDescription` as a clean append at slot 2; slots 0 and 1 are unmoved.

No library struct changed shape: `AdminOps.FeeConfig`, `ArtistAttestation`, `Presentation`,
`Pointers` and `ShapeStore` are byte-identical to `7f6ccb5`. `Shapes.RenderInputs`
(`src/Shapes.sol:958`) is memory-only and touches no layout.

### D-4 / D-5 Stale evidence in the isolation tests

`test/LibraryIsolation.t.sol:24` pins `PRESENTATION_SLOT = 21`; `_presentation` is now at 22, and
the file comment at line 20 still says "slot 21 is `_presentation`". The test still passes, because
solc's call protection reverts before any storage is reached, but the pointer it crafts names
`_artistAttestation`'s second word rather than the field the test says it targets.

`test/audit/LibraryDirectCall.t.sol:24-28` pins `SLOT_ARTIST = 19`, `SLOT_PRESENTATION = 21`,
`SLOT_POINTERS = 23`, `SLOT_ADMIN = 25`, `SLOT_OWNER_TOKEN = 26`; every one is now one slot low.
Detection is not lost: `_rawSlots()` sweeps slots 0..29 and still covers the whole layout including
`_ownerToken` at 27, so a write landing anywhere would be caught. What is lost is that the crafted
pointers no longer aim at the named fields.

Separately, lines 108 and 112 call `0x65e1e9f6` and `0xa3ac9ef9`, the preview selectors from before
`845a3ed` dropped the account argument. `forge inspect RecompositionOps methodIdentifiers` reports
`previewCompose(ShapeStore storage,uint256,uint256[]) = 0xfbd9b802` and
`previewSplit(ShapeStore storage,uint256,uint8[]) = 0x723eef4c`. A library has no fallback, so those
two `_call`s revert on an unknown selector and exercise nothing.

Neither is a vulnerability. Both should be refreshed before the mainnet evidence pack is frozen, or
the claim "every public library function called at the library address" is not what the suite runs.

**Status: fixed.** `test/LibraryIsolation.t.sol` and `test/audit/LibraryDirectCall.t.sol` now pin
the slots read back from `forge inspect Shapes storage-layout --json` at this commit (`_store` 6,
`_feeConfig` 16, `_artistAttestation` 20, `_presentation` 22, `_pointers` 24, `_admin` 26,
`_ownerToken` 27), and `test_EveryRecompositionOpsEntryAtItsOwnAddressLeavesShapesUntouched` now
calls the live `previewCompose`/`previewSplit` selectors (`0xfbd9b802`/`0x723eef4c`) with the
account argument dropped to match the current signatures.

## Verified clean

**Reserve invariant under per-recipient accrual.** Exactly two writes touch fee balances.
`_mintBatch` (`src/Shapes.sol:441`) credits `_feesOwed[_feeConfig.feeRecipient] += fees` and
`_totalFeesOwed += fees` together, after `msg.value != backing + fees` has been rejected
(`src/Shapes.sol:427`) and before the first external call, so the two counters move by the same
amount and the balance already covers them when a receiver callback runs. `withdrawFees`
(`src/Shapes.sol:470`) zeroes exactly one entry and subtracts the same amount from the total, so
`sum(_feesOwed) == _totalFeesOwed` is preserved by construction and `_totalFeesOwed -= amount`
cannot underflow. `setFeeRecipient` writes only `FeeConfig.feeRecipient` and never reads or moves a
`_feesOwed` entry, so a mid-accrual change cannot reach an earlier recipient's balance; the accrual
site reads the pointer once, inside `nonReentrant`, with no external call between the read and the
credit. `withdrawFees` for an address with zero owed reverts `NoFeesPending` before any state
change, including for `address(0)`, so no payout can be burned. A reverting recipient reverts the
whole call through `_sendEth` (`src/Shapes.sol:588`), leaving both counters intact and every other
recipient unaffected. Evidence: `test/audit/FeeAccounting.t.sol` (13 tests, including
`test_EachRecipientWithdrawsExactlyItsOwnShare`, `test_SetFeeRecipientCannotRedirectAlreadyAccruedFees`,
`test_RecipientWithoutAPayableReceiveBlocksOnlyItself`,
`test_WithdrawFeesIsPermissionlessButNotSelfDirected`) and the `sum(feesOwedTo(r)) == pendingFees()`
assertion in `test/Invariants.t.sol`. No exploit found; the one residual is D-2.

**The five new render views.** `svg`, `metadataJSON`, `geometryOf` and `moduleAt` all enter through
`_renderInputs` (`src/Shapes.sol:969`), whose first statement is `_requireOwned(tokenId)`;
`effectiveModulesOf` (`src/Shapes.sol:1052`) calls `_requireOwned` directly. All five are `view`,
as is `_renderInputs`, so none can write. `test_RenderViewsRevertForABurnedId`
(`test/ShapeRenderer.t.sol:1332`) pins `ERC721NonexistentToken` on all five plus `tokenURI`. None
of them can break `tokenURI` or `contractURI`: they share `_renderInputs` and the renderer with
`tokenURI` but add no gate to it, and `metadataJSON` is the only one that touches the collection,
where it reverts `CollectionNotSet` exactly as `tokenURI` does. `svg`, `geometryOf`, `moduleAt`,
`effectiveModulesOf` and `unicodeCard` need no collection, so they resolve during the
`CollectionNotSet` window. Gas: all five are unbounded in the token's denomination (the renderer
generates the full module array), so a contract calling `svg`, `metadataJSON` or
`effectiveModulesOf` on a high-denomination token on-chain should budget for it; as `eth_call`
views they are bounded by the node's cap and `test/GasCeilings.t.sol` covers the mutating paths.

**The `GeometrySampling` link.** It is a public linked library, so `effectiveModulesOf` is reached
by `DELEGATECALL` in the token's storage context, but every public function in
`src/lib/GeometrySampling.sol` is `pure` (`effectiveModulesOf`, `grammarSplitPool`,
`buildSplitRecordPool`, `buildSplitRecordPoolSorted`, `sortDonorsById`, `sampleCompose`,
`sampleComposeSorted`, `sampleSplitChild`, `sampleSplitChildFromPool`), none takes a storage
pointer, and `Shapes` passes `_store.modules[tokenId]` by memory copy. So the new surface cannot
read or write token storage, move ETH, or emit from the token. That also means solc emits no call
protection for it and none is needed: the reasoning in `test/LibraryIsolation.t.sol` applies to the
mutator libraries, and a direct `CALL` to `GeometrySampling` can only compute. The library was
already deployed and linked (into `RecompositionOps`) at `7f6ccb5`; the change is that `Shapes`
links it too. Its bytecode is unchanged in this range.

**Preview parity.** `previewCompose` and `previewSplit` now drop the account and gate liveness
through `RecompositionOps._requireLive` (`src/lib/RecompositionOps.sol:574`), which is
`requireLiveOwner` minus the ownership comparison: `_tokenOwner` reverts `ERC721NonexistentToken`
for a dead id, then `TokenIsBlack`. Gate-by-gate against the mutators: `NoComposeInputs` /
`SplitTooFewOutputs` first in both (`src/Shapes.sol:637`, `src/Shapes.sol:688`), then survivor or
parent liveness, then `requireDistinctComposeInputs` (the same public library function on both
sides), then per-input `CannotComposeWithSelf` and liveness, then the shared `ComposeCompute` /
`GeometrySampling` call and the same denomination-ladder and split-sum checks. The preview gate set
is a strict subset of the mutator's, differing only by ownership and by `nonReentrant`, so a
preview that succeeds can only be blocked for the holder by ownership (impossible for the holder)
or by reentrancy; and there is no input where the preview reverts and the mutation would succeed.
One ordering nuance, not a divergence in outcome: for a Black token held by someone else the
mutator reports `NotShapeOwner` (ownership is checked first) while the preview reports
`TokenIsBlack`. Both revert.

**Metadata copy.** `ownerTokenDescription_` is validated by the same
`CopyValidation.requireJsonSafe` as the other two, at the same `MAX_DESCRIPTION_BYTES = 2048` cap,
with field code 2 (`src/ShapeCollection.sol:115`). `setMetadataCopy` writes all three atomically
behind the live `admin()` and `presentationLocked()` reads, so the presentation lock freezes the
new field with the others (`test_OwnerTokenDescriptionIsEditableUntilTheLock`). Selection in
`tokenURI` and `metadataJSON` is `r.ownerToken = tokenId + 1 == _ownerToken`
(`src/Shapes.sol:979`): `_ownerToken` stores id+1 with 0 as the "none" sentinel, so when no owner
token exists no live id can match, and every token renders `description()` — the state the default
`ShapesBase` harness runs in, since it redeems Shape #0 in `setUp`. Covered directly by
`test/OwnerToken.t.sol:449-491` through mint, compose and decompose. `contractURI()` takes no
argument and cannot be steered by a caller: `ShapeCollection.json()` reads `_description` from its
own storage and `IERC721Metadata(shapes).name()` from the immutable `shapes` address, where
`name()` is the ERC-721 constant "Shapes". `setCollection` still requires
`IShapeCollection(collection).shapes() == address(this)` (`src/lib/AdminOps.sol:87`), so the
callback target is a collection bound to this token; `lockPresentation` now requires a nonzero
collection (`src/lib/AdminOps.sol:120`), closing S-2. The errors `IShapeCollection` newly declares
(`AdminUnauthorizedAccount(address)`, `PresentationIsLocked()`) have the same signatures, and
therefore the same selectors, as the ones `IAdminControl` and `IShapes` declare.

**Deploy.** Library linking in `script/deploy.sh` is fully generic: it reads `.libraries[]` out of
the Foundry broadcast file for the require sweep (line 304), the `--libraries` verify flags
(line 321) and the `deployments/<chainId>.json` record (line 444), with no hardcoded list, so the
new `GeometrySampling` link on `Shapes` is picked up, verified and recorded with no change needed.
The third copy field is asserted in both places: `Deploy.s.sol:192` requires
`collection.ownerTokenDescription()` to exceed 100 bytes in the postflight and logs it at line 263,
and `deploy.sh:399` re-reads it over RPC and fails the run if it is short. The `symbol` change to
`SHAPE` is not asserted anywhere in the deploy path; no stale `"SHAPES"` string remains in `src/`,
`script/` or `test/`. `script/lifecycle.sh` probes for each new signature with `has_fn` and carries
both spellings of `isBlack`/`isBlackShape`, the previews, `setMetadataCopy` and `withdrawFees`, so
the e2e walkthrough works against this ABI and the previous one.

**Rename and signature-change completeness.** No `.isBlack(` call site, no
`previewCompose(address,...)` or `previewSplit(address,...)` call site, and no `withdrawFees()`
call site remains anywhere in `src/` or `script/` outside the version-adaptive branches in
`lifecycle.sh`.

## Notes

`Shapes` at 2,116 bytes of EIP-170 margin (D-7) is the tightest the contract has been in this
branch's history. It is comfortable for a deploy but leaves little room for another feature pass
before mainnet; `ShapeRenderer` sits at 1,320 bytes of margin.

Attempts added by this review, both retained in `test/audit/DiffReview7f6ccb5.t.sol`. D-1 and D-2
are fixed, so both attempts now assert the revert: `test_SetRendererRejectsARendererThatCannotAnswerIShapeGeometry`
(D-1) and `test_SetFeeRecipientRejectsTheTokenItself` (D-2).

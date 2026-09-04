# Security checks on the architecture release (2026-09-03)

Target: branch `claude/contracts-page`. Contracts audited at `7f6ccb5`; fixes at `887497c`; harness
additions at `eedbed0`; per-recipient fee accrual (audit S-1) follows. An independent Codex audit of
`audits/AUDIT_PROMPT_v8.md` runs in parallel and is reported separately.

## 1. Adversarial audit against `audits/AUDIT_PROMPT_v8.md` (opus)

Full report: `audits/AUDIT_REPORT_v8_claude.md`. Tests: `test/audit/` (62 tests, all nine required
attempts, none exploited). Reproduced baseline: 532 tests both profiles, 4 fork tests, Medusa
11/11, Anvil deploy plus e2e.

| id | severity | title | status |
| --- | --- | --- | --- |
| S-1 | Low | `setFeeRecipient` redirects fees already accrued to the previous recipient; `IAdminControl` and D-27 say future fees only | Fixed by per-recipient accrual (D-43): `feesOwedTo(address)`, `withdrawFees(address)`, `pendingFees()` stays the total |
| S-2 | Low | `lockPresentation` before `setCollection` bricks `tokenURI` and `contractURI` forever | Fixed `887497c`: reverts `CollectionNotSet` |
| S-3 | Low | The presentation lock freezes pointers, not the contracts behind them; a locked-in reverting renderer or third-party-editable collection is unrecoverable | Reduced `887497c`: a collection must be bound to this token by ERC-165 and `shapes()`; the residual is admin trust before locking, same class as the renderer; documented on `lockPresentation` |
| S-4 | Informational | Reverting fee recipient plus `renounceAdmin` strands accrued fees | Per-recipient accrual limits the loss to that recipient's own balance |
| S-5 | Informational | A mint-fee change between an ETH bid's quote and its transaction reverts the bid | Accepted; bounded by the fee cap; no value moves |

Properties verified with evidence (reserve and ETH, recomposition incl. owner-token callback
interleavings, previews, narrowing casts, minting, authority, reentrancy and callbacks with a full
external-call table, auction and escrow, presentation) are in the report's "Properties verified"
section. Two caveats recorded there: previews are not `nonReentrant` and so do not predict the
guard; in the split log stream `OwnerTokenMoved` precedes the first child's creation event, which
only a log-order-sensitive indexer notices.

## 2. Diff-focused security review (opus, read-only) of `e304d00...7f6ccb5`

Scope: metadata copy moved to `ShapeCollection`, `burnBacking` and `BlackShapeCreated` renames,
symbol `SHAPES`, collection constructor ERC-165 check, renderer dead-code removal, clarity pass.

| Severity | Finding | Status |
| --- | --- | --- |
| Medium | `setCollection` did not require `collection.shapes() == address(this)`; an admin could install a collection bound to a stub and keep editing copy after `lockPresentation` | Fixed `887497c`; tests `test_ShapesRefusesACollectionBoundToAnotherToken`, `test_ShapesRefusesACollectionThatMisreportsItsBinding` |
| Medium | Same missing binding let a non-canonical collection return unvalidated strings into every `tokenURI` | Fixed by the binding check; residual documented |
| Medium | `lockPresentation` callable with no collection set | Fixed `887497c`; test `test_LockPresentationRevertsWithNoCollectionSet` |
| Nit | `CopyValidation` docstring named the old caller | Fixed |
| Nit | `IShapeCollection` did not declare the errors `setMetadataCopy` raises | Fixed |

Verified clean: copy authority, the `CollectionNotSet` window, `refreshMetadata` bounds, rename
completeness across contracts, site and indexer, renderer draw parity, deploy ordering and
postflight binding asserts, clarity pass touched no non-comment token beyond the intended renames.

## 3. Fuzz and invariant campaign (sonnet) at `7f6ccb5`

| Run | Result |
| --- | --- |
| Medusa, 5,006,412 calls, 4 workers, 9m33s, corpus 84, 1,249 branches | 14/14 pass |
| Foundry invariants, CI profile (512 runs, depth 128) | 6/6 pass, 13 named invariants |
| Foundry invariants, 2000 runs, depth 100 | 6/6 pass |
| `testFuzz_*` at 5,000 runs | 39/39 pass |

Harness gap closed at `eedbed0`: the Medusa harness reaches `burn`, `burnBacking` on an apex
Complete when one appears, and a compose that moves the owner token.

## 4. Slither at `7f6ccb5`

40 results, none actionable: `encode-packed-collision` on `_tokenName` builds a display string that
is never hashed; `incorrect-equality` on `_previousBlockHash` guards block zero on local chains;
`write-after-write` on `ShapeCardEscrow._minting` brackets the escrow's own mint so
`onERC721Received` accepts only requested tokens; `unused-return` on `rnd.nextWad()` is the
intentional stream draw; the rest are standard patterns covered by `nonReentrant` entrypoints and
pull-based settlement.

## 5. Independent Codex audit of `audits/AUDIT_PROMPT_v8.md`

Recorded in `audits/AUDIT_REPORT_v8_codex.md`: no Critical, High, Medium or Low finding; nine adversarial
attempts retained and passing; every property in the brief verified with test and source evidence.
Codex did not raise S-1 to S-3 or the two copy-move Mediums that the in-house reviews found; those
are fixed on the branch regardless.

## 6. Diff-focused security review (opus, read-only) of `7f6ccb5...2bc389a`

Full report: `diff-review-7f6ccb5-2bc389a.md`. Scope: per-recipient fee accrual, collection binding and
lock guard, `isBlackShape`, previews without an account, `ownerTokenDescription`, symbol `SHAPE`,
the five token-id render views, `contractURI()` without parameters, `effectiveModulesOf` as
`ModuleCodec` bytes through the linked pure library `GeometrySampling`.

| id | severity | title | status |
| --- | --- | --- | --- |
| D-1 | Low | `setRenderer` checked ERC-165 for `IShapeRenderer` only; `geometryOf` and `moduleAt` call `IShapeGeometry`, so a renderer answering one interface bricked two views behind a permanent lock | Fixed `45476b2`: `requireRenderer` requires both interfaces; test `test_SetRendererRejectsARendererThatCannotAnswerIShapeGeometry` |
| D-2 | Low | `setFeeRecipient` accepted the token itself, whose `receive` reverts, stranding fees accrued to it | Fixed `45476b2`: rejects `address(this)`; test `test_SetFeeRecipientRejectsTheTokenItself` |
| D-3 | Informational | Storage layout: `pendingFees` became `_feesOwed` plus `_totalFeesOwed`; slots from `_artistAttestation` on moved by one | Nothing is deployed on the old layout |
| D-4 | Informational | Library isolation tests carried pre-shift slot constants | Re-pinned from `forge inspect Shapes storage-layout` |
| D-5 | Informational | Direct-call sweep used the removed preview selectors | Updated to `previewCompose(uint256,uint256[])` and `previewSplit(uint256,uint8[])` |
| D-6 | Informational | `MintFeeAccrued(uint256)` names no recipient | By design; `FeeRecipientSet` gives the attribution |

Verified clean: the reserve invariant under per-recipient accrual (two write sites move the
recipient balance and the total by the same amount, so the sum equals `pendingFees()` by
construction), every new view enters `_requireOwned` and is `view`, `GeometrySampling` is a pure
public library with no storage or ETH surface, preview gates are a strict subset of the mutator
gates through shared helpers, `ownerTokenDescription` shares the JSON-safe validation and the lock,
`contractURI()` reads only its own storage, and `deploy.sh` records every linked library from the
broadcast file.

## 7. Decompose round trip

`test/DecomposeRoundTrip.t.sol` fuzzes compose stacks of depth 1 to 3 over plain, split-materialized
and pre-composed inputs and asserts that decompose restores every observable fact of the survivor
and of every input: `shapeState` including `modules` bytes, `ownerOf`, `tokenURI`, `svg`,
`metadataJSON`, `geometryOf`, `effectiveModulesOf`, `splitOriginOf`, `isBlackShape`, `composeDepth`,
with `ownerToken()`, `owner()` and `totalMinted()` unchanged. The invariant handler hashes
`shapeState` plus `svg` before every compose and checks it after every decompose
(`invariant_DecomposeRestoredEveryRecordedState`). No mismatch in 512 fuzz runs and the invariant
campaign.

## 8. End-to-end lifecycle

`script/lifecycle.sh anvil` on `2bc389a`: 12 of 12 steps pass, the render views section executes
and asserts `effectiveModulesOf` length equals the grid cell count, the deployment record lists
`GeometrySampling`. Step 12 first reported 361 live tokens against 17 on chain; the cause was the
script trusting a foreign indexer already bound to port 42069. The script now refuses an occupied
port and requires its own indexer process to be alive (`#85`). Indexer handlers are correct.

## 9. Independent Codex audit of `audits/AUDIT_PROMPT_v9.md` at `34d2c3b`

Recorded in `audits/AUDIT_REPORT_v9_codex.md`. No Critical, High or Medium finding. Baseline reproduced: 669
tests in both profiles, 4 fork tests, Medusa 14 properties, Anvil deploy and lifecycle (the indexer
step needed a free port, which `#85` now enforces). Two Low findings, both already known:

| id | severity | title | status |
| --- | --- | --- | --- |
| SHAPES-01 | Low | Presentation lock trusts renderer and collection behaviour behind the pointers | Same as S-3 and V9-1. Accepted: the residual is admin trust before locking; a probe at lock time cannot turn the freeze into a guarantee because a target can pass the probe and misbehave later |
| SHAPES-02 | Low | Fees owed to a non-payable recipient are stranded | Same as V9-2. Accepted by the owner (D-44); the deploy path proves the recipient accepts plain ETH by simulation and the mainnet recipient is the Splits wallet, verified on a mainnet fork |

Codex verified the trust model table (every delegating entrypoint, its gate and its target), the
per-recipient fee accounting, the decompose round trip, storage slots after the fee layout change,
and library isolation for all five linked libraries.

## 10. Status

Contracts at `34d2c3b` (source unchanged through `b337028`, the Sepolia deployment commit). Every
finding across the v8 and v9 audits, the diff review, the fuzz campaign and Codex is fixed or
accepted with a recorded decision. Sepolia rehearsal deployed at Shapes
`0x6c2f9c00f44fbbf141dd166979903004b80d5f99`; site and indexer cut over. Mainnet gates left: merge
`claude/contracts-page` to main, fund the deployer, `script/deploy.sh mainnet`.

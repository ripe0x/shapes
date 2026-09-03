# Fuzz, invariant and Slither campaign at `1c2cfd9` (2026-09-03)

Reruns the campaign documented in `architecture-security-2026-09-03.md` sections 3-4 (run at
`7f6ccb5`) against `1c2cfd9`, the tip of `claude/contracts-page` after the per-recipient fee
accrual, the decompose snapshot invariant, `burnBacking`, and the render-view admin guards landed.

## Summary

| Run | Result |
| --- | --- |
| Medusa, 5,839,790 calls, 4 workers, ~10m, corpus 90, 1,345 branches | 14/14 pass |
| Foundry invariants, CI profile (512 runs, depth 128) | 20/21 pass, 1 broken: `invariant_DecomposeRestoredEveryRecordedState` |
| Foundry invariants, 2000 runs, depth 100 | 20/21 pass, same invariant broken (independent repro, shorter counterexample) |
| `testFuzz_*` at 5,000 runs | 40/40 pass |
| Slither | 50 results, none newly actionable (see section 4) |

The one finding worth flagging up front: `invariant_DecomposeRestoredEveryRecordedState` broke
under both invariant profiles with two different, independently-shrunk counterexamples (40 steps
at CI depth, 12 steps at the deep profile). `architecture-security-2026-09-03.md` section 7
reported this invariant clean ("no mismatch in 512 fuzz runs and the invariant campaign") at
`2bc389a`; this run reproduces a break at `1c2cfd9`. Not root-caused here (`src/` was not edited
per task scope) — see section 2 for both exact call sequences.

## 1. Medusa

`./script/medusa.sh --timeout 600 --test-limit 0` (config unbounded call limit so the 10-minute
timeout governs; 4 workers, `medusa/MedusaReserveHarness.sol` per `project/experiments/medusa-reserve.json`).

| Metric | Value |
| --- | --- |
| Duration | 9m57s of fuzzing (600s configured timeout + setup/teardown) |
| Workers | 4 |
| Calls | 5,839,790 |
| Corpus | 90 |
| Branches | 1,345 |
| Properties + assertions | 14/14 pass |

Property and assertion functions, all pass: `property_reserve_equals_redeemable_backing`,
`property_reserve_is_solvent`, `property_owner_token_tracks_its_holder` (3 `property_` functions,
confirming the count at `7f6ccb5`), plus the 11 assertion-style harness entrypoints `initialize`,
`mintDust`, `composeDust`, `splitLastNickel`, `decomposeLast`, `redeemLast`, `burnLast`,
`burnBackingIfApex`, `moveOwnerTokenViaCompose`, `lastId`, `shapes`. The harness (`medusa/MedusaReserveHarness.sol`)
reaches `burnBackingIfApex` (an apex-Complete `burnBacking` call), `burnLast` (the `IERC721Value`
burn path, Black or not), and `moveOwnerTokenViaCompose` (folds the live owner token into a
compose survivor); no dedicated decompose-snapshot property exists in this harness, that check
lives in the Foundry invariant suite (`invariant_DecomposeRestoredEveryRecordedState`, see below).
0 failures out of 5,839,790 calls, matching the 14/14-pass result at `7f6ccb5` (5,006,412 calls,
9m33s) at slightly higher throughput.

Run log: `/private/tmp/claude-501/.../scratchpad/medusa-run2.log` (session-scoped scratch path).

## 2. Foundry invariants

Three invariant test contracts in `test/Invariants.t.sol`: `ShapesInvariantTest` (15 named
invariants, up from 13 at `7f6ccb5` — adds `invariant_PerRecipientFeesSumToPendingFees` and
`invariant_DecomposeRestoredEveryRecordedState`), `AuctionInvariantTest` (3), and
`AuctionInvariantHostileFeeTest` (4, inheriting the 3 base ones plus
`invariant_HostileFeeRecipientKeepsItsShape`). 19 distinct named invariants total.

**A. CI profile** (`FOUNDRY_PROFILE=ci`, `[profile.ci.invariant] runs = 512, depth = 128`),
`forge test --match-contract Invariant -vv`:

| Contract | Invariants | Result |
| --- | --- | --- |
| `AuctionInvariantTest` | 3 | 3/3 pass |
| `AuctionInvariantHostileFeeTest` | 4 | 4/4 pass |
| `ShapesInvariantTest` | 15 | **14/15 pass, 1 broken** |

Total: 21 invariant-checks executed (19 distinct + 2 shared re-run under the hostile subclass),
20 pass, 1 fail. Wall time 413.70s for `ShapesInvariantTest` (calls: 65536), ~65s each for the two
Auction contracts. Full run: 5 tests passed, 1 failed (6 total tests across 3 suites), 524.59s CPU.

**Failure: `invariant_DecomposeRestoredEveryRecordedState`** — `decompose did not restore a
recorded pre-compose state`. Section 7 of `architecture-security-2026-09-03.md` reported "no
mismatch in 512 fuzz runs and the invariant campaign" for this same invariant at `2bc389a`; this is
a regression relative to that baseline (or a sequence class the earlier random seed never reached).
Shrunk counterexample (original sequence 112 steps, shrunk to 40):

```
mint(43829, 5939)
splitToHostile(4133, 11333)
redeemBatch(10262, 9)
splitUneven(59592333291033979897009499954562693532607078830865783225324886914777093)
redeemToHostile(10046, 100000000000000000000)
redeemBatchToHostile(8938, 49936622452287577162604128956812695611460609360481771458875485843145018843247, 125000000000000000000)
mintBatch(4078, 230000000000000000000, 400504712)
compose(2362777102140675351706850717693117241898857876064414268130171290783)
redeemBatchToHostile(75, 21, 50000000000000000000)
mintBatch(11, 150000000000000000, 8460)
redeem(50000)
composeMixed(8258)
transfer(1899281880027126685, 21)
mintBatch(5810, 144, 323)
decompose(3360240385)
composeMixed(500)
redeem(20444)
mint(201474, 271178238151977880656703379448667794)
redeem(167443915432861129533417708)
redeemBatch(8934, 1264)
composeMixed(55590018354286851698591090409305971151856850558582506887815441016563084742477)
split(30)
redeem(1242870133)
composeMixed(13198)
split(22403)
mintBatch(11, 3271, 56)
decompose(2)
redeem(13)
decompose(11538)
redeemBatch(4, 90)
mint(66294799439793634459912202790542913492390852592036373729064251799287723659833, 11062)
split(37726391026707433105804451914714087317127131839266958368233033134046271504395)
compose(44999999999999999999)
mintBatch(63383338395490931950080576461040526258642487779894074199854, 3270359791763525160101229155914128292071693994827641077337519437, 52189491449231039656471084547)
redeem(109)
compose(7985)
redeemBatch(29342136, 159)
composeMixed(17733)
redeemBatchToHostile(277, 7480, 114747857499697354746563014230976229948516375818065302091528294822332327542796)
decomposeMany(19713)
```

(Handler arguments are pre-`bound()`/pre-modulo seeds, not raw protocol values; every call routes
through `test/Invariants.t.sol:Handler` at `0xa0Cb889707d426A7A386870A03bc70d1b0697598`.) Fuzz seed
`0xdf2f47586e1c5ad65f6b1fd3c794c6507aa5a983257b20d7bb9bddb75f908040`.

**B. Deep profile** (`FOUNDRY_INVARIANT_RUNS=2000 FOUNDRY_INVARIANT_DEPTH=100`), same command:

| Contract | Invariants | Result |
| --- | --- | --- |
| `AuctionInvariantTest` | 3 | 3/3 pass (runs: 2000, calls: 200000) |
| `AuctionInvariantHostileFeeTest` | 4 | 4/4 pass (runs: 2000, calls: 200000) |
| `ShapesInvariantTest` | 15 | **14/15 pass, 1 broken** (runs: 2000, calls: 200000) |

Same invariant breaks, reproduced independently at deeper parameters. Total wall time 610.11s for
`ShapesInvariantTest`, 1008.65s CPU across the 3 suites. Shrunk counterexample (original 65 steps,
shrunk to 12), a materially shorter reproduction than the CI-profile one:

```
mint(762179621605252850435079043384466910685340236425304380779, 39478587752452895567990718339237944261420991)
mintBatch(8729, 9258, 1225148678)
redeemToHostile(21369, 7)
split(7443)
mint(164, 1000000000000)
split(3777)
split(8513)
composeMixed(1831565813)
composeMixed(1405310203571408291950365054053061012934685786633)
split(3)
redeem(9)
decomposeMany(6025621)
```

Fuzz seed `0x889db500830486505c89004d5f9bcc9e7e40552042c5780512375c89326ea916`. Both shrunk sequences
end on a `decompose`-family call (`decomposeMany`) preceded by `composeMixed`/`compose` and a mix of
`split`/`redeem`/hostile-recipient variants; consistent with a state that only some multi-step
compose/split/redeem interleaving reaches. `test/DecomposeRoundTrip.t.sol`'s dedicated fuzz test
(`testFuzz_DecomposeRestoresEveryObservableFact`, section 3 below) does not reach this class of
sequence at 5,000 runs and passes; the break is stateful-sequence-dependent, not a single-compose
defect. Not root-caused further here per scope (no `src/` edits); flagged for follow-up.

All other 18 named invariants pass at both CI and deep parameters, including
`invariant_PerRecipientFeesSumToPendingFees` and `invariant_BurnBackingAccounting`.

## 3. `testFuzz_*` at 5,000 runs

40/40 pass. Includes `testFuzz_DecomposeRestoresEveryObservableFact` (`test/DecomposeRoundTrip.t.sol`).

| Suite | Tests | Runs | Result |
| --- | --- | --- | --- |
| `AuctionHouse.t.sol:AuctionHouseTest` | 1 | 5000 | pass |
| `Shapes.t.sol:InkGeneMintTest` | 1 | 5000 | pass |
| `ShapeRenderer.t.sol:Round03RandTest` | 2 | 5000 | pass |
| `Shapes.t.sol:MintTest` | 2 | 5000 | pass |
| `InkGenes.t.sol:InkGenesParityTest` | 6 | 5000 | pass |
| `ShapeRenderer.t.sol:OutputTest` | 8 | 5000 | pass |
| `RendererDiff.t.sol:RendererDiffTest` | 4 | 5000 | pass |
| `ShapeRenderer.t.sol:FixedPointTest` | 3 | 5000 | pass |
| `ShapeRenderer.t.sol:GeometryTest` | 10 | 5000 | pass |
| `DecomposeRoundTrip.t.sol:DecomposeRoundTripTest` | 1 | 5000 | pass (`testFuzz_DecomposeRestoresEveryObservableFact`) |
| `Sampling.t.sol:SamplingTest` | 1 | 5000 | pass |
| `Shapes.t.sol:RedeemTest` | 1 | 5000 | pass |

Total: 12 suites, 40 tests, 40 passed, 0 failed. `FOUNDRY_FUZZ_RUNS=5000 forge test --match-test testFuzz_`, 88.63s wall (621.76s CPU).

## 4. Slither

`slither . --filter-paths "lib|test|script|medusa"` (slither-analyzer 0.11.5, no project config).
57 contracts, 101 detectors, **50 results** (up from 40 at `7f6ccb5`). Detector breakdown:

| Detector | Count | Locations | Triage |
| --- | --- | --- | --- |
| `encode-packed-collision` | 8 | `ShapeRenderer._triangleSvg:591-607`, `_quarterSvg:659-661`, `_halfSquareSvg:767-779`, `_rightTriangleSvg:789-805`, `_halfCircleSvg:937-939`, `_svgFromCard:1005`, `_tokenName:1287`, `_tokenName:1289` | Not actionable. Every hit builds an SVG/JSON display string that is never hashed or compared; collision only matters where `encodePacked` output feeds a signature or a mapping key. Same category as the `_tokenName` hit noted at `7f6ccb5`; the two new `_tokenName` sites (`", Contract Owner")` suffix, no-suffix variant) are the owner-token naming added since. |
| `uninitialized-local` | 9 | `ShapeRenderer._svgFromCard.body:1002`, `_varietyCount.seen:227`, `_dominantPrimitive.counts:208`, `.bestCount:214`, `.best:213`, `_varietyCount.distinct:229`, `_fillClass.filled:181`, `ShapeCollection.imageFor.strip:160`, `Shapes._compose.ownerTokenFrom:642` | Not actionable. Solidity zero-initializes; every flagged local is a byte/uint accumulator or loop-scoped struct field the code fills before use (checked `_compose.ownerTokenFrom:642` specifically: assigned unconditionally in the branch that reads it). |
| `calls-loop` | 9 | `ShapeCardEscrow._takeCards:64,69`, `_mintCards:98` (both reached from `ShapeAuctionHouse.bid`→`_takeBid`), `_release:140` (from `withdraw` and from `claimProceeds`, 2 call-stack instances), `ShapeCollection.cardFor:209` (4 call-stack instances via `contractURI`/`json`/`image`/`imageFor`) | Not actionable. `_takeCards`/`_mintCards`/`_release` loop over a caller-supplied, `MAX_CARDS_PER_BID`-bounded array making trusted calls to `shapes` (the same contract pair, not an arbitrary target); `cardFor` loops over the fixed 9-denomination ladder in a `view` metadata read, gas-unbounded by design (off-chain callers), not state-changing. |
| `reentrancy-benign` | 2 | `ShapeCardEscrow._mintCards:95-99`, `_takeBid:111-124` | Not actionable. `_minting` brackets the escrow's own mint so `onERC721Received` accepts only requested tokens (same pattern noted at `7f6ccb5`); the flagged post-call writes are the guard's own reset, not attacker-influenced state. |
| `reentrancy-events` | 2 | `ShapeCardEscrow._mintCards:105`, `_takeBid` (same call chain) | Not actionable. `BidCardsMinted` emits after the external `mintBatchTo` call; no state read depends on emission order, and `ShapeAuctionHouse`'s own state (units, proceeds) is written before any external call in the same path. |
| `timestamp` | 3 | `ShapeAuctionHouse.bid:166,187`, `.settle:206`, `Shapes._mintBatch:408` | Not actionable. Standard auction end-time and mint-start gating; miner timestamp manipulation is bounded to seconds and does not create a profitable window against a multi-hour/day auction or a fixed `mintStart`. |
| `low-level-calls` | 2 | `Shapes._sendEth:589`, `.positionOf:1087-1089` | Not actionable. `_sendEth`'s raw `.call` is the documented arbitrary-recipient ETH path (paired with `arbitrary-send-eth` below); `positionOf`'s `staticcall` is gas-capped (`POSITIONS_GAS`) and read-only against an admin-set, ERC-165-checked pointer. |
| `naming-convention` | 2 | `IShapeAuctionHouse.MAX_DURATION():75`, `IShapeCardEscrow.MAX_CARDS_PER_BID():35` | Not actionable. Constant-style names for `public constant` getters; cosmetic, consistent with the rest of the ladder (`Denominations`, etc). |
| `arbitrary-send-erc20` | 1 | `ShapeAuctionHouse.createAuction:130` (`IERC721(nft).transferFrom(tokenOwner, address(this), tokenId)`) | Not actionable. `tokenOwner` is `msg.sender`-derived (the auction creator), not attacker-controlled arbitrary `from`; false positive on the detector's ERC-20 heuristic applied to an ERC-721 call. |
| `arbitrary-send-eth` | 1 | `Shapes._sendEth:589` | Not actionable, by design. The redemption/fee-withdrawal payout path; recipient is the caller or a caller-nominated address (`redeemTo`, `withdrawFees(recipient)`), covered by `nonReentrant` and pull-based settlement, same as `7f6ccb5`. |
| `divide-before-multiply` | 2 | `ShapeRenderer._module:172`, `_moduleFromBytes:392` | Not actionable. `(i / g.cols) * g.cell` is integer grid-cell arithmetic (row index times cell size), not a financial ratio; precision loss is the intended floor-division-to-grid-cell mapping. |
| `incorrect-equality` | 1 | `Shapes._previousBlockHash:1102` (`block.number == 0`) | Not actionable. Guards block-zero on local/genesis chains, as at `7f6ccb5`. |
| `unused-return` | 5 | `ShapeRenderer.compose:328` (`rnd.nextWad()`), `Shapes.geometryOf:1045,1047` (`g.cardGeometrySampled`, `g.cardGeometry`), `Shapes.moduleAt:1075,1077` (`g.moduleAtSampled`, `g.moduleAt`) | Not actionable. `rnd.nextWad()` is the intentional stream draw (unchanged from `7f6ccb5`). The 4 new hits are on the render views added since (`5c97610`): `geometryOf`/`moduleAt` destructure only the fields they need from `GeometrySampling`'s multi-return helpers via Solidity's `(None, cols, rows, ...)` skip syntax — the "unused" values are deliberately discarded, not silently dropped results. |
| `write-after-write` | 1 | `ShapeCardEscrow._minting:95,99` | Not actionable, same as `7f6ccb5`: the escrow's own mint-guard set/reset bracketing `onERC721Received`. |
| `costly-loop` | 1 | `Shapes._compose:650` (`_ownerToken = survivorId + 1` inside `composeMany`'s loop) | Low, latent. A storage write inside `composeMany`'s per-call loop; gas cost scales with the batch, paid entirely by the caller (admin/owner-initiated compose), no reentrancy or correctness effect. Same shape as the `7f6ccb5` "standard patterns" bucket; not flagged there because `composeMany`/`_compose`'s owner-token-move arm is part of the diff since (`moveOwnerTokenViaCompose` in the Medusa harness exercises exactly this). Worth a gas-profile look, not a security finding. |
| `assembly` | 1 | `Shapes.positionOf:1093-1095` | Not actionable. Same inline decode as `7f6ccb5`, no new assembly introduced. |

**New relative to the `7f6ccb5` triage (40 results):** the 4 new `unused-return` hits on
`geometryOf`/`moduleAt` (the render views), the 2 new `encode-packed-collision` hits on
`_tokenName`'s owner-token suffix branch, and the `costly-loop` hit tied to `composeMany`'s
owner-token-move arm — all three trace directly to the features this campaign was asked to confirm
coverage for (per-recipient fees, the new views, and the owner-token-move compose path). None is
newly actionable. The two admin guards tightened in `45476b2`
(`AdminOps.requireRenderer`'s added `IShapeGeometry` ERC-165 check, and `setFeeRecipient`'s
`address(this)` rejection) and the per-recipient `_feesOwed` accrual in `Shapes.sol` produced **zero**
Slither findings; `GeometrySampling.sol` also produced zero findings. `ShapeCollection.setMetadataCopy`'s
`token.admin()` guard is likewise clean.

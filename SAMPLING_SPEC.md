# Geometry Sampling Spec

Status: implemented, merged via PR #29. Changes how a composed (and split) token's geometry is
derived: sampled from the modules of the cards that were merged, instead of re-reading the
survivor's seed at the new denomination.

## 1. Current behavior and motivation

`_compose` keeps the survivor's `seed` and mutates only `denomIndex`, `originCount`, `inkGene`.
The renderer is a pure function of `(seed, amountWei, inkGene)`, so a composed card renders as
the survivor's seed at the larger denomination: the burned cards contribute nothing to the
geometry (their seeds only XOR-fold into the ink gene draw). Visually, compose reads as "the
survivor grows", not "the cards merge".

Goal: the composed card's modules are drawn from the modules of its inputs, so the merged card
is visibly made of its parts. Constraint: per-token state must stay O(grid size), not O(origin
count) — a 100 ETH token can descend from 10,000 mints and cannot carry a lineage list.

## 2. Design: materialize the sample at compose time

Do not store lineage. At compose time, when every input is still live in storage, sample the
new card's modules from the inputs' modules and store the result as a compact byte array on the
survivor. Rendering reads the stored array; no ancestor data is needed afterwards.

Inheritance compounds without unbounded state: a survivor that was itself composed has its own
stored array, and the next compose samples from that array. Each token carries only its current
look, never its history. History lives in the compose records (already stored for decompose)
and in events.

Grid sizes make this cheap. `Denominations.gridAt` is monotone decreasing in value: 25 modules
at 0.01 ETH down to 1 module at 100 ETH. A compose result is always index >= 1, so a
materialized compose array is at most 20 bytes; a split child can be index 0, so the absolute
maximum is 25 bytes. Both fit in one short-`bytes` storage slot.

## 3. Module encoding

One byte per module, row-major in grid order:

```
bit 7      always 0
bits 6..5  rot   (0..3, meaning rot * 90 degrees clockwise)
bit 4      solid (0 or 1)
bits 3..0  kind  (0..9, the consensus KIND_* ordering)
```

A byte is valid iff bit 7 is clear, `kind < KIND_COUNT`, and `rot < _rotCount(kind)`.
`cx`, `cy`, `size`, `weight` are not encoded; they derive from the token's own grid geometry
and card constants exactly as today. Only the module's intrinsic identity (kind, solid,
rotation) is sampled and stored.

The `solid` bit is copied verbatim from the parent module, including for arc and line (which
render outlined regardless; the bit is preserved so a later sample of that module is
byte-identical).

## 4. Storage changes

```solidity
/// Materialized geometry. Empty for original mints (geometry derives from `seed` under
/// grammar v1). Nonempty for tokens produced by compose or split: length equals
/// the token's grid cell count and each byte encodes one module per section 3.
mapping(uint256 tokenId => bytes) private _sampledModules;
```

`ShapeData` is unchanged. `seed` remains per-token forever: it is the entropy source for the
sampling stream, the ink-gene fold, and `_childSeed`; it no longer solely determines geometry
once a token is materialized.

Decompose reversibility:

```solidity
struct ComposeInput {
    // existing fields unchanged
    bytes modules;          // burned input's materialized geometry, empty if none
}

struct ComposeRecord {
    // existing fields unchanged
    bytes survivorModules;  // survivor's pre-compose materialized geometry, empty if none
}
```

Both are restored verbatim on decompose (an empty value restores the seed-derived state).
The record remains self-contained: it alone reverses the compose.

## 5. Sampling procedure (consensus-critical)

Inputs: survivor S and burns B_1..B_n, each with `units_i = Denominations.unitsAt(denomIndex)`
and an effective module list `mods_i`:

- materialized token: its stored byte array, `cells_i = length`;
- original token: the grammar v1 module sequence of `(seed_i, amountAt(denomIndex_i))`,
  `cells_i = gridAt(denomIndex_i)` cell count. Positional access reuses the existing
  `ShapeRenderer.moduleAt` walk so stream alignment is inherited, not re-specified.

Stream:

```
sampleSeed = keccak256(abi.encodePacked("Shapes/sample/v1", survivorSeed, burnSeedFold, uint8(newIndex)))
rnd        = Round03Rand.init(sampleSeed)
```

`burnSeedFold` is the existing order-invariant XOR of burn seeds, so burnIds calldata order
cannot affect the result. The domain tag separates this stream from the render stream.

For each destination cell j = 0 .. cellCount(newIndex) - 1, in order:

1. `d = rnd.nextBelow(totalUnits)` where `totalUnits = sum(units_i)` over S and all B_i.
   Map `d` to a donor by cumulative units, survivor first, then burns in calldata-independent
   canonical order (ascending token id).
2. `k = rnd.nextBelow(cells_donor)`; the destination module is `mods_donor[k]`.

Sampling is with replacement. Donor choice is units-weighted, matching the ink-gene pool
weighting (`sumW` in `_compose`); module choice within a donor is uniform. A 50 ETH input and
fifty 1 ETH inputs contribute equally in aggregate, regardless of how many cells each card has.

The resulting byte array is stored on the survivor, emitted (section 8), and is the token's
geometry until the next compose/decompose/split.

## 6. Operation semantics

- **compose**: snapshot `survivorModules` and each burn's `modules` into the record (section 4),
  then sample per section 5 and store on the survivor. Everything else (value, origin count,
  ink gene, escrow) is unchanged.
- **decompose**: pop the record; restore the survivor's bytes verbatim; re-mint each input with
  its bytes verbatim. A token round-trips to its exact prior look.
- **split**: each child i samples its own array from the parent's effective modules — stream
  `keccak256(abi.encodePacked("Shapes/sample-split/v1", parentSeed, uint8(childDenom), uint8(i)))`,
  uniform module choice (single donor, so no units weighting), with replacement. A child grid
  can exceed the parent's (100 ETH has 1 module; its 50 ETH children have 2), which with-
  replacement handles. Children of original mints also sample, so a split visibly divides the
  parent's look.
- **redeem / black**: unchanged; burned or terminal state, no geometry transition.

## 7. Renderer changes

Grammar v1 (`compose(seed, amountWei, inkGene)` and its draw order) is untouched; original
mints render byte-identically to today. Additions, versioned as grammar v2:

- `composeSampled(bytes modules, uint256 amountWei, uint8 inkGene) returns (Card)`: decodes
  the byte array, derives positions/size/weight from the grid and card constants, and sets
  `solidProbability` from the gene as metadata (no solid draws occur on this path).
- Sampled variants (or a stored-bytes parameter) for `renderSVG`, `tokenURI` composition,
  `moduleSequence`, `renderUnicode`, `cardGeometry`, `moduleAt`.
- `Shapes.tokenURI` selects the path by whether `_sampledModules[id]` is nonempty.
- `GRAMMAR_VERSION = 2`; `GRAMMAR_HASH` covers v1 + section 3 encoding + section 5 procedure.

The "Filled" metadata count already derives from the module list and works on both paths.

## 8. Events, preview, parity

- New event `ModulesSampled(uint256 indexed tokenId, bytes modules)`, emitted whenever a
  token's materialized geometry is set or restored: compose (survivor), each split child, and
  decompose (survivor restore and each re-minted input; empty bytes signal reversion to
  seed-derived geometry). The indexer consumes this instead of re-deriving.
- `ComposeResult` / `previewCompose` gain a `bytes modules` field so the site can show the
  exact post-compose card before the transaction.
- `preview/` TypeScript renderer implements the byte decoding and both sampling streams;
  `Parity.t.sol` extends to assert contract/TS agreement on sampled cards and on the sampling
  procedure itself (same inputs, same bytes).

## 9. Gas

- Compose overhead: at most 20 destination cells; each cell is one donor scan (O(number of
  inputs)) plus one module access. Access to a materialized donor is a byte read; access to an
  original donor walks its render stream, at most ~75 cheap PRNG steps (25 cells x up to 3
  draws, no keccak per step). Worst case is on the order of 10^2 k gas, small next to the
  existing per-burn storage writes.
- Storage: +1 slot for the survivor's array, +1 slot per record for the survivor snapshot,
  +1 slot per burned input's snapshot (only when nonempty).
- Large aggregations already chain composes (per-burn record writes bound a single call);
  chained composes get cheaper here, because intermediate survivors are materialized and their
  module access is a byte read.
- tokenURI for materialized tokens skips the seed walk; marginally cheaper.

## 10. Invariants

1. `_sampledModules[id]` is either empty or exactly `cols * rows` bytes for `denomIndex`,
   every byte valid per section 3.
2. Every byte of a composed token's array appears in some input's effective module list at
   compose time (sampling only copies).
3. decompose(compose(...)) restores every touched token's array bit-exactly, empty included.
4. Original mints are never materialized; their render output is byte-identical to grammar v1.
5. No change to any value path: denominations, escrow, origin counts, and the existing
   conservation invariants are untouched by sampling.

## 11. Decisions

- **D1 — weighting.** Units-weighted donor, uniform within donor, with replacement (matches
  the ink-gene pool weighting; O(1) memory; handles every grid-size case). The rejected
  alternative was uniform over the pooled multiset without replacement (literal conservation
  of modules, but weights big-value inputs down to their cell count and needs reservoir
  bookkeeping).
- **D2 — solid bits.** Copied verbatim, so ink is inherited literally and the gene remains the
  pool statistic that drives labels and future composes. The rejected alternative was
  re-drawing solids at the new gene's probability.
- **D3 — split.** Children sample from the parent, so look divides with value. The rejected
  alternative was keeping fresh child seeds (split children reading as new mints).

## 12. Provenance views

Compose and split already store everything needed to reconstruct per-cell sampling provenance
for any live token. Two read-only views expose that storage without adding new state.

Both views live on `ShapeLens` (`src/ShapeLens.sol`), not on `Shapes` itself: they were moved off
the token contract, along with `shapeState`, `previewCompose`, `previewSplit` and `unicodeCard`, to
keep `Shapes`'s runtime bytecode under the EIP-170 size limit. `Shapes` instead exposes the minimal
raw accessors `ShapeLens` reads to reassemble them — `composeRecordHeaderAt` / `composeRecordInputAt`
for compose records, `splitOriginRaw` for split origins — documented in `IShapes.sol`. The
reconstruction recipes below are unaffected: they describe the same on-chain data, just reached
through `IShapeLens.composeRecordAt` / `IShapeLens.splitOriginOf` instead of a method on `Shapes`.

### `ShapeLens.composeRecordAt(survivorId, depth)`

`_composeStack[survivorId]` already holds a `ComposeRecord` per stacked compose (`decompose`'s
own reversal data). `composeRecordAt` returns the record at `depth` (0 the oldest, `composeDepth
(survivorId) - 1` the newest) as a `ComposeRecordView`: the survivor's pre-compose state
(denomination index, origin count, ink gene, materialized modules, empty if the survivor was
unmaterialized at that point) and one `ComposeInputView` per burned input (id, seed, denomination
index, origin count, ink gene, materialized modules). `ShapeLens` calls `Shapes.composeRecordHeaderAt`
once for the survivor-side fields and input count, then `Shapes.composeRecordInputAt` once per
input; it checks `depth` against `Shapes.composeDepth` itself and reverts `ComposeRecordOutOfRange`
when `depth >= composeDepth(survivorId)`, matching what the removed `Shapes.composeRecordAt` did.

Reconstruction recipe: rebuild the donor array with the survivor's snapshot first, then the
`inputs` sorted ascending by id (they are stored in calldata order, not canonical order), recompute
`burnSeedFold` as the XOR of the recorded input seeds, and call `GeometrySampling.sampleCompose`
with the survivor's own live seed (unchanged by compose) and its post-compose denomination index.
The result equals the survivor's live materialized bytes at that stack depth.

### `ShapeLens.splitOriginOf(childId)`

Split has no equivalent storage before this change: the parent is burned and its seed and modules
deleted, so a child previously carried no on-chain trace of its origin. `_splitTo` now writes one
append-only `SplitRecord` per split call (parent seed, parent denomination index, parent ink gene,
and the parent's effective modules read before it is burned), shared by every child of that split,
and one `SplitOriginRef` per child (which record, and the child's index within it). `splitOriginOf`
returns `(parentSeed, parentDenomIndex, parentInkGene, parentModules, childIndex)` — a passthrough
over `Shapes.splitOriginRaw`, already minimal — and reverts `NotASplitChild` when `childId` carries
no entry.

Reconstruction recipe: call `GeometrySampling.sampleSplitChild(parentModules, parentSeed,
childDenom, childIndex)`, where `childDenom` is the child's own live denomination index. This is
exactly what `_splitTo` samples at split time, so the result equals the child's modules as
recorded then, valid whenever the child has not since been recomposed (see below).

No entry exists for an original mint, nor for a token re-minted verbatim by `decompose`: that path
restores a `ComposeInput` from the compose record and never touches `_splitOriginRef`. This cannot
collide with a genuine split child's id: `decompose` only ever re-mints an id that was previously
burned as a compose input (DECOMPOSE_SPEC.md), while `split` always mints under a fresh id taken
from `totalMinted`, which strictly exceeds every id issued so far. A split child's id is therefore
never reused for anything other than that one split, and `decompose` never re-mints under an id
that only a split ever issued.

A split child's `SplitOriginRef` is never deleted, so `splitOriginOf` keeps answering after the
child is subsequently mutated: composed into a survivor (its `_sampledModules` then reflects the
newer compose, not the split), or burned as a later compose's input and restored by that compose's
own `decompose` (same id, same record, unaffected by the round trip in between). The view answers
"how was this token created," not "what does it currently look like" — `ShapeLens.shapeState(childId)
.modules` is the latter.

### Gas

`composeRecordAt` and `splitOriginOf` are views; they add no write cost. The split write is one
`SplitRecord` (a seed slot, a packed denomination-index/ink-gene/length slot, and the modules
byte array, which fits in one slot since `parentModules` is at most 25 bytes) shared across the
whole split, plus one `SplitOriginRef` (one slot) per child. Measured on a 2-way 100 ETH -> 2x50
ETH split: 251,813 gas without this feature, 387,109 gas with it (+135,296 gas, dominated by the
new SSTOREs, all cold-to-nonzero on a fresh split).

## 13. Testing

- Extend `Parity.t.sol` (byte encoding, sampling streams, sampled render paths).
- Extend `Decompose.t.sol` (round-trip restores arrays; stacked compose/decompose; records
  with and without materialized inputs).
- Fuzz: invariant 1 over arbitrary compose/split/decompose sequences; invariant 2 by
  multiset check against inputs.
- `Invariants.t.sol` / `ExploitAttempts.t.sol`: assert invariant 5 (no value-path drift).

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
2. `k = rnd.nextBelow(remaining_donor)`, where `remaining_donor` starts at `cells_donor` and
   decreases by one each time a module of that donor is used. The destination module is the
   `(k+1)`-th not-yet-used entry of `mods_donor`, scanning ascending from index 0; that entry is
   then marked used. `moduleIndex` as reported/traced is the module's index in `mods_donor`,
   i.e. its position in the donor's full effective module list, not its position among the
   not-yet-used entries.

Donor choice is with replacement and units-weighted, matching the ink-gene pool weighting
(`sumW` in `_compose`); a 50 ETH input and fifty 1 ETH inputs contribute equally in aggregate,
regardless of how many cells each card has. Module choice within a donor is without replacement:
each donor module is usable at most once per compose, so every result cell traces to a distinct
donor module (D1′, section 11). Every donor's module count is at least `cellCount(newIndex)`
(section 10 invariant 6), so a donor is never asked for a module it has already used up.

The resulting byte array is stored on the survivor, emitted (section 8), and is the token's
geometry until the next compose/decompose/split.

## 6. Operation semantics

- **compose**: snapshot `survivorModules` and each burn's `modules` into the record (section 4),
  then sample per section 5 and store on the survivor. Everything else (value, origin count,
  ink gene, escrow) is unchanged.
- **decompose**: pop the record; restore the survivor's bytes verbatim; re-mint each input with
  its bytes verbatim. A token round-trips to its exact prior look.
- **split**: each child samples from a pool that depends on whether the parent has a compose
  record at split time (decision D3', section 11; supersedes D3). Stream:
  `keccak256(abi.encodePacked("Shapes/sample-split/v1", parentSeed, uint8(childDenom), uint256(i)))`,
  uniform draw over the pool, with replacement, one draw per child cell. `i` is the untruncated
  child index, the same value `_childSeed` takes; an earlier revision of this spec specified
  `uint8(i)`, which aliased children 256 apart in one split at one denomination onto an identical
  stream.

  - **Parent has a compose record** (`_composeStack[parentId]` nonempty at split time, i.e.
    `Shapes.composeDepth(parentId) > 0`): the pool is the concatenation of the effective modules of
    every donor of that top record — the record's pre-compose survivor first (`rec.survivorModules`
    if nonempty, else grammar v1 of `(parentSeed, rec.survivorDenomIndex, rec.survivorInkGene)`),
    then the record's inputs ascending by id. `rec.inputs` is stored in calldata order (the loop in
    `_compose` pushes them in that order); the pool builder sorts by id before concatenating, or the
    split result would depend on that earlier compose's burnIds calldata order, breaking burn-order
    independence the same way section 5's donor order does. The pool is child-denomination-
    independent: built once per split call and shared by every child regardless of `outDenoms`.
    `_splitTo` reads `_composeStack[parentId]` but never deletes it, so reconstruction (section 12)
    can redo the same branch decision later.
  - **No compose record** (a direct mint, or a materialized-but-recordless token: a split child, or
    a decompose-restored input with an empty stack): the pool is grammar v1 of `(parentSeed, CHILD
    denomination, parentInkGene)` — the parent seed's expression at the child's OWN denomination,
    not the parent's. The parent's own `parentModules` (materialized or seed-derived) plays no part;
    a materialized-but-recordless parent's stored bytes are never read for this. The pool is
    child-denomination-dependent: rebuilt fresh for each child, not cached per distinct denomination
    across a split with repeated `outDenoms` (see section 12's Gas subsection).

  `moduleIndex` as reported/traced by `sampleSplitChild` indexes the pool, not the parent's own
  module list: for the grammar branch the pool is sized to the child's own grid (the same reason a
  compose donor's own module count equals its own grid); for the record branch the pool spans every
  donor of the record concatenated, generally not any single denomination's grid.

  D3' fixes a degeneracy in D3 (issue #21B): D3 sampled every child from the parent's own effective
  modules, so a low-module parent (the 1x1 100 ETH apex is the extreme) produced monoculture
  children — every cell of every child the same byte, sticky under further composes, since
  re-composing such a child could only re-sample that one byte. The record branch escapes this by
  drawing from the modules that made the card at its last merge (the same pool decompose pops), a
  strictly larger set whenever the parent has one. The grammar branch escapes it for a direct-mint
  parent by expressing the parent's seed at the child's own, smaller and more numerous denomination
  instead of re-sampling the parent's own, fewer modules.
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
6. Compose provenance is injective: no two result cells trace to the same `(donorIndex,
   moduleIndex)` pair, and a donor is never drawn from after its module count is exhausted.
   Holds because a compose's donors are its own pre-compose survivor plus its burned inputs, and
   `Denominations.gridAt` is strictly decreasing in denomination index while `newIndex` is the
   denomination of the merged (higher-value) result — every donor's `amountAt` is strictly below
   the result's, so every donor's cell count is at least the result's cell count. Total draws
   equal the result's cell count, so no donor's `remaining` can reach zero while it is still
   being drawn from.

## 11. Decisions

- **D1′ — weighting (supersedes D1).** Donor choice is units-weighted, with replacement, unchanged
  from D1. Module choice within a donor is uniform over that donor's not-yet-used modules,
  without replacement: each donor module contributes to at most one result cell, so compose
  provenance is injective at the cell level (issue #21A). D1's reasoning for units-weighted
  donor selection over the pooled multiset stands unchanged; this only removes replacement at
  the module level, which the section 10 invariant 6 argument shows can never exhaust a donor.
  Superseded rule (D1): uniform within donor, with replacement — a single parent cell could
  source several result cells, which read as "duplicated" rather than "moved" in per-cell
  provenance views.
- **D2 — solid bits.** Copied verbatim, so ink is inherited literally and the gene remains the
  pool statistic that drives labels and future composes. The rejected alternative was
  re-drawing solids at the new gene's probability.
- **D3' — split pool (supersedes D3, issue #21B).** Each child's pool is the parent's top compose
  record's donor modules (concatenated, canonical order) when the parent has one, else the parent
  seed's grammar v1 expression at the CHILD's own denomination (section 6). Fixes D3's monoculture
  degeneracy: D3 sampled every child from the parent's own module list, which for a low-module
  parent (the 1x1 100 ETH apex is the extreme) forced every child cell to the same byte, sticky
  under further composes. The record branch is symmetric with decompose (same pool, same record);
  the grammar branch keeps a never-composed parent's children legibly related to it (same seed)
  without reproducing its own scarcity. The softer provenance claim this accepts: a grammar-branch
  trace's `moduleIndex` refers to the parent's expression at the child's denomination, not to marks
  that were ever on the minted parent card. Section 12 documents the reconstruction.
  Superseded rule (D3): every child sampled from the parent's own effective modules, with
  replacement, uniform (single donor, no units weighting). The rejected alternative to D3 (fresh
  child seeds, full diversity but no legible lineage) remains rejected under D3' for the same
  reason.

## 12. Provenance views

Compose and split already store everything needed to reconstruct per-cell sampling provenance
for any live token. Two read-only views expose that storage without adding new state.

Both views are on `Shapes`, as is every other protocol read. Their bodies live in the linked
`RecompositionOps` library beside the mutators whose records they decode.

### `composeRecordAt(survivorId, depth)`

`_composeStack[survivorId]` already holds a `ComposeRecord` per stacked compose (`decompose`'s
own reversal data). `composeRecordAt` returns the record at `depth` (0 the oldest, `composeDepth
(survivorId) - 1` the newest) as a `ComposeRecordView`: the survivor's pre-compose state
(denomination index, origin count, ink gene, materialized modules, empty if the survivor was
unmaterialized at that point) and one `ComposeInputView` per burned input (id, seed, denomination
index, origin count, ink gene, materialized modules). It reverts `ComposeRecordOutOfRange` when
`depth >= composeDepth(survivorId)`. `ownerTokenFrom` is returned as a token id, or
`type(uint256).max` when that compose moved no collection ownership; the id-plus-one form the record
stores is never returned.

Reconstruction recipe: rebuild the donor array with the survivor's snapshot first, then the
`inputs` sorted ascending by id (they are stored in calldata order, not canonical order), recompute
`burnSeedFold` as the XOR of the recorded input seeds, and call `GeometrySampling.sampleCompose`
with the survivor's own live seed (unchanged by compose) and its post-compose denomination index.
The result equals the survivor's live materialized bytes at that stack depth.

### `splitOriginOf(childId)`

Split has no equivalent storage before this change: the parent is burned and its seed and modules
deleted, so a child previously carried no on-chain trace of its origin. `_splitTo` now writes one
append-only `SplitRecord` per split call (parent id, parent seed, parent denomination index, root
split ancestor's denomination index, parent ink gene, and the parent's own effective modules read
before it is burned), shared by every child of that split, and one `SplitOriginRef` per child
(which record, and the child's index within it). `splitOriginOf` returns `(parentSeed, parentId,
parentDenomIndex, originDenomIndex, parentInkGene, parentModules, childIndex)` and reverts
`NotASplitChild` when `childId` carries no entry.

`originDenomIndex` is the root split ancestor's denomination: the parent's own
`originDenomIndex` when the parent was itself a split child, else `parentDenomIndex`. It backs the
"Split Origin" metadata trait (METADATA.md) and, unlike every other `SplitRecord` field, cannot be
reconstructed from chain history after the fact: a compose record or a later split carries only its
inputs' immediate state, not their full split ancestry. It is computed once at split time and
stored directly for that reason.

`parentModules` is informational only since D3' (section 6, section 11 D3'): it is the parent's own
effective geometry snapshot, and neither sampling branch reads it. Reconstruction needs `parentId`
instead, to redo the branch decision `_splitTo` made at split time — `parentId` is the burned
parent's token id; `_composeStack[parentId]` is read by split but never deleted, so it is still
there to read back.

Reconstruction recipe:

1. Read `Shapes.composeDepth(parentId)`.
2. If it is nonzero (record branch): read `composeRecordAt(parentId, composeDepth(parentId)
   - 1)` for the parent's top compose record, rebuild the donor array with the record's survivor
   snapshot first then its `inputs` sorted ascending by id (stored in calldata order, not canonical
   order, the same as the compose recipe above), and pass it to
   `GeometrySampling.buildSplitRecordPool(survivorModules, parentSeed, survivorDenomIndex,
   survivorInkGene, sortedInputs)` for the pool.
3. If it is zero (grammar branch): the pool is
   `GeometrySampling.grammarSplitPool(parentSeed, childDenom, parentInkGene)`, where `childDenom` is
   the child's own live denomination index.
4. Call `GeometrySampling.sampleSplitChild(pool, parentSeed, childDenom, childIndex)`.

This is exactly what `_splitTo` samples at split time, so the result equals the child's modules as
recorded then, valid whenever the child has not since been recomposed (see below).

No entry exists for an original mint, nor for a token re-minted verbatim by `decompose`: that path
restores a `ComposeInput` from the compose record and never touches `_splitOriginRef`. This cannot
collide with a genuine split child's id: `decompose` only ever re-mints an id that was previously
burned as a compose input (DECOMPOSE_SPEC.md), while `split` always mints under a fresh id taken
from `totalMinted`, which strictly exceeds every id issued so far. A split child's id is therefore
never reused for anything other than that one split, and `decompose` never re-mints under an id
that only a split ever issued.

A split child's `SplitOriginRef` is never deleted, so `splitOriginOf` keeps answering after the
child is subsequently mutated: composed into a survivor (its stored modules then reflect the
newer compose, not the split), or burned as a later compose's input and restored by that compose's
own `decompose` (same id, same record, unaffected by the round trip in between). The view answers
"how was this token created", not "what does it currently look like": `shapeState(childId).modules`
is the latter.

### Gas

`composeRecordAt` and `splitOriginOf` are views; they add no write cost. The split write is one
`SplitRecord` (a seed slot; a packed id/denomination-index/ink-gene/length slot, `parentId` sharing
the slot `parentDenomIndex`/`parentInkGene`/`originDenomIndex` already occupied since a `uint96` id
plus the three `uint8`s is 15 bytes, no new slot; and the modules byte array, which fits in one slot
since `parentModules` is at most 25 bytes) shared across the whole split, plus one `SplitOriginRef`
(one slot) per child. Measured on a 2-way 100 ETH -> 2x50 ETH split (direct-mint parent, grammar branch):
251,813 gas without split provenance recording at all, 421,143 gas with D3'. The D3'-over-D1-era-
recording delta (387,109 gas measured before D3') comes from the grammar branch deriving a full
grammar v1 sequence per child (`GrammarV1Modules.all`, rebuilt fresh each time, not cached per
distinct child denomination — see the tradeoff note below) instead of reusing the parent's own
already-known module bytes; the record branch's added cost is one extra `_composeStack[parentId]`
read (already-warm storage the compose that created the record wrote) and the donor-modules
concatenation, not a new SSTORE class. A split with many children at the same denomination pays the
grammar rebuild once per child rather than once per distinct denomination: `Shapes.sol`'s own
runtime bytecode was within ~130 bytes of the EIP-170 24,576-byte limit before D3', and the
per-denomination cache (`bytes[9]`/`bool[9]` scratch arrays keyed by `Denominations.COUNT`) that
would remove this repeat cost added enough bytecode on its own to push it over; dropped in favor of
lowering `foundry.toml`'s `optimizer_runs` (100 -> 25) instead, which trades marginally higher
runtime gas on every repeatedly called function (not just split) for deployment headroom. The
resulting margin is thin (~9 bytes at the mainnet ladder); a further pass to shrink `Shapes`'s own
bytecode, not just retune `optimizer_runs`, should reclaim real headroom — and could reintroduce the
per-denomination cache — before mainnet deploy.

## 13. Testing

- Extend `Parity.t.sol` (byte encoding, sampling streams, sampled render paths).
- Extend `Decompose.t.sol` (round-trip restores arrays; stacked compose/decompose; records
  with and without materialized inputs).
- Fuzz: invariant 1 over arbitrary compose/split/decompose sequences; invariant 2 by
  multiset check against inputs.
- `Invariants.t.sol` / `ExploitAttempts.t.sol`: assert invariant 5 (no value-path drift).

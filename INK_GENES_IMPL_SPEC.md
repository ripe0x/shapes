# Ink Genes — Implementation Spec (v1.0)

Status: implemented; design rationale preserved as written. Current project status:
project/STATE.md.

Audience: an implementation agent. Follow this document exactly. Where this document and
your own judgment differ, this document wins. Where this document and the actual code
differ (a line anchor doesn't match, a signature moved), STOP and report the mismatch
instead of improvising.

Design rationale lives in `INK_GENES_DRAFT.md` and `SPEC.md`. Read both before starting,
plus the parity rules in `SPEC.md` (D3d, D3e, D4, D5). This spec only says WHAT to build.

## 0. Scope

IN: ink gene storage, mint assignment, compose walk, decompose/split inheritance,
renderer integration (Solidity + TS canonical), simulate views, events, traits, tests,
fixtures, parity.

OUT (do not build, do not scaffold): epoch commit-reveal seeding (draft §6), Monte Carlo
tuning, any change to fees, backing, redemption, sacrifice, or the reserve. The ⚙ constants
below are implemented as named constants exactly as given; do not tune them.

Assumption: the contracts are not yet deployed; interface-breaking changes are allowed.
If `broadcast/` indicates a live mainnet deployment, STOP and report.

## 1. Constants (single source of truth, duplicated in two files)

Create `src/lib/InkGenes.sol` (pure library, no storage) and
`preview/src/canonical/ink.ts`. Both define, with identical values:

```
GENE_COUNT = 7
// gene ids
VOID=0 FAINT=1 SPARSE=2 MURK=3 DENSE=4 RICH=5 SOLID=6

// rendered solid probability per gene, WAD (1e18)
GENE_PROBABILITY = [0, 0.15e18, 0.35e18, 0.5e18, 0.65e18, 0.85e18, 1e18]

// gene names, for the metadata trait, exact strings:
GENE_NAMES = ["Void","Faint","Sparse","Murk","Dense","Rich","Solid"]

// mint distribution thresholds over a uniform roll r in [0,100):
// dust (denomIndex == 0):
//   r<3→VOID  r<10→FAINT  r<25→SPARSE  r<75→MURK  r<90→DENSE  r<97→RICH  else SOLID
// non-dust (denomIndex > 0):
//   r<20→SPARSE  r<80→MURK  else DENSE

// compose walk thresholds over a uniform roll in [0,100):
//   roll<70 → step toward center
//   roll<90 → step toward best
//   else    → step toward worst
```

The TS file is the canonical reference; the Solidity library is a direct port. The parity
suite must assert the two constant tables are equal (same pattern as
`Denominations` ↔ `denominations.ts`).

## 2. Pure functions (define in both `InkGenes.sol` and `ink.ts`)

All hashing is `keccak256` over `abi.encodePacked` with the exact argument types shown.
In TS, use the same keccak/encoding helper the preview already uses for seeds (check
existing imports in `preview/src/canonical/` and reuse it; byte-for-byte identical
encoding to Solidity's `abi.encodePacked` is REQUIRED).

### 2.1 Mint gene

```solidity
function geneAtMint(bytes32 seed, uint8 denomIndex) internal pure returns (uint8) {
    uint256 r = uint256(keccak256(abi.encodePacked("ink:mint", seed))) % 100;
    // then the threshold tables from §1
}
```

### 2.2 Compose walk

```solidity
struct InkInput { uint8 gene; uint256 units; }   // units = Denominations.unitsAt(denomIndex)

function geneAtCompose(
    bytes32 survivorSeed,
    uint256 burnSeedFold,       // XOR of uint256(seed) over all burned tokens
    uint8 survivorGene,
    uint8 oldIndex,             // survivor's denomIndex BEFORE compose
    uint8 newIndex,             // after
    uint8 best,                 // max gene over {survivor + burns}, unweighted
    uint8 worst,                // min gene over {survivor + burns}, unweighted
    uint8 center                // see 2.3
) internal pure returns (uint8 g) {
    bytes32 R = keccak256(abi.encodePacked("ink:compose", survivorSeed, burnSeedFold, newIndex));
    g = survivorGene;
    uint256 T = newIndex - oldIndex;          // always >= 1
    for (uint256 k = 1; k <= T; ++k) {
        uint256 roll = uint256(keccak256(abi.encodePacked(R, k))) % 100;
        uint8 target = roll < 70 ? center : roll < 90 ? best : worst;
        if (g < target) g += 1;
        else if (g > target) g -= 1;
        // equal: unchanged
    }
}
```

Notes, all binding:
- `burnSeedFold` is XOR so `burnIds` calldata ORDER MUST NOT affect the result. Do not
  hash seeds sequentially.
- Fresh entropy is forbidden: no block data, no msg.sender, nothing beyond the arguments.
- Homogeneous check: if `best == worst` the loop is a no-op by construction (center is
  also equal); do not special-case it, the math already handles it.

### 2.3 Center (units-weighted mean gene, rounds half up)

Over the multiset {survivor + all burns}:

```
sumW = Σ gene_i × units_i
U    = Σ units_i
center = (2*sumW + U) / (2*U)      // integer division
```

Worked example (must appear as a unit test): survivor SOLID(6) dust (1 unit) + four
burns MURK(3) dust (1 unit each): sumW = 6 + 12 = 18, U = 5,
center = (36+5)/10 = 4 (true mean 3.6 → rounds to 4 = DENSE).

### 2.4 Decompose / split

No function needed: a split's children copy the parent's gene verbatim, and decompose writes
back the genes the compose record captured.

## 3. Solidity changes (`src/Shapes.sol`)

### 3.1 Storage

`ShapeData` gains one field: `uint8 inkGene;` — placed with the packed group
(`denomIndex`, `originCount`, `isBlack`), which stays within one slot. Struct is at
~line 59.

### 3.2 Mint (`_mintBatch`, loop at ~line 252)

In the per-token loop, after computing `seed`:
`inkGene: InkGenes.geneAtMint(seed, uint8(denomIndex))` in the `ShapeData` literal.
Emit `InkGene(tokenId, gene)` (event, §3.6) after `ShapeMinted`.

### 3.3 Compose (~line 361)

TRAP: the existing burn loop `delete`s each burned token's storage (line 385) — all gene
inputs must be read BEFORE the delete. Extend the existing loop (do not add a second
loop over live storage):

- before the loop: capture `uint8 oldIndex = s.denomIndex;` and initialize
  `best`/`worst` with `s.inkGene`, `sumW`/`U` with survivor's gene×units and units.
- inside the loop, before `delete _shapes[bid]`: fold `uint256(b.seed)` into
  `burnSeedFold` (XOR); update best/worst; add `b.inkGene × unitsAt(b.denomIndex)` to
  `sumW` and units to `U`.
- after `newIndex` is known (line 390) and BEFORE overwriting `s.denomIndex`: compute
  center (§2.3) and `s.inkGene = InkGenes.geneAtCompose(...)`.
- emit `InkGene(survivorId, s.inkGene)` next to the existing `Composed` event.

Do not modify the `Composed` event signature.

### 3.4 Decompose and split

- Split: capture `uint8 parentGene = p.inkGene;` before `delete _shapes[tokenId]`. Every child's
  `ShapeData` literal gets `inkGene: parentGene`. One `InkGene(nid, parentGene)` per child.

### 3.5 Views

```solidity
function inkGeneOf(uint256 tokenId) external view returns (uint8);   // _requireOwned first

function simulateCompose(uint256 survivorId, uint256[] calldata burnIds)
    external view returns (uint8 newGene, uint8 newDenomIndex);
```

`simulateCompose` mirrors `compose`'s validation (existence via `ownerOf`, not-black,
no self, no duplicate ids, total lands on a denomination) but requires NO ownership by
the caller and touches no state. Duplicate detection cannot rely on `_burn` here: reject
duplicates explicitly (O(n²) over calldata is acceptable; n is small).

```solidity
function simulateDecompose(uint256 tokenId) external view returns (uint8 childGene);
// trivially inkGeneOf(tokenId); include for interface symmetry
```

### 3.6 Event

```solidity
event InkGene(uint256 indexed tokenId, uint8 gene);
```

Emitted on every gene assignment: mint, compose, decompose (per revived input), split (per child).

### 3.7 Renderer plumbing

`IShapeRenderer` (src/interfaces/IShapeRenderer.sol): add `uint8 inkGene` as the LAST
parameter of `renderSVG`, `metadataJSON`, `tokenURI`, and `moduleSequence` (module
solid/outline states depend on it). Update the call site in `Shapes.tokenURI`
(~line 620–627) to pass `d.inkGene`. Update `_requireRendererHasCode` staticcall probes
if any encode a fixed selector.

## 4. Renderer changes

### 4.1 TS canonical (`preview/src/canonical/render.ts`) — do this FIRST, it is the
source of truth

- REMOVE the prototype `inkScale?: bigint` parameter and its multiplicative rule
  (line 123: `mulWad(seedFill, inkScale)`). It is superseded.
- `composeShape` and `renderShape` gain `inkGene: number` (0–6, required).
- In `composeShape`: the existing `drawSolidProbability(rand.next(), p)` call REMAINS
  (the stream must keep consuming that draw — SPEC.md D5) but its value is discarded;
  `solidProbability = GENE_PROBABILITY[inkGene]`.
- Update `preview/scripts/inkDemo.ts` or delete it (it demos the dead model B; prefer
  delete plus a note in the commit message).
- All other draw logic is untouched. Run the sweep to confirm nothing else moved.

### 4.2 Solidity renderer (`src/ShapeRenderer.sol`)

Direct port of 4.1: consume the fill draw, discard it, use the gene table. Add the
metadata trait: `{"trait_type": "Ink", "value": GENE_NAMES[inkGene]}` alongside the
existing provenance traits. Black tokens: `isBlack`/`inverted` behavior is UNCHANGED and
takes precedence exactly as today; the Ink trait is still reported.

## 5. Tests (Foundry unless stated; follow existing test style/naming)

1. Constants parity: Solidity table == TS table (extend the existing parity suite).
2. `geneAtMint`: fixed vector seeds → expected genes, vectors generated by the TS
   implementation and frozen in `test/fixtures/` (extend `npm run fixtures`). Include at
   least one seed per gene for dust and per gene for non-dust ({2,3,4} only).
3. Non-dust mints never yield genes outside {2,3,4} (fuzz over seeds).
4. §2.3 worked example verbatim.
5. Compose order-invariance: same burn set, ≥3 permutations of `burnIds` → identical
   gene (fuzz permutations).
6. Survivor choice matters: a fixture set where two different survivors give different
   final genes (find it while generating fixtures; it must exist).
7. Homogeneous pool: all inputs one gene → survivor gene unchanged, for T = 1 and for a
   max jump (10,000 dust → 100, T = 8; use mintBatch, this also gas-profiles the fold).
8. Decompose: the survivor reverts to its recorded gene and every revived input regains its own.
   Split: every child gene == parent gene.
9. `simulateCompose` == the gene a real `compose` of the same set then produces; and
   simulate is `view` (no state diff).
11. Existing suites stay green: `forge test`, `forge test --mc Parity`, and in
    `preview/`: `npm run fixtures` then `npm run sweep`. Fixture JSON gains an
    `inkGene` field per fixture entry; 78 fixtures regenerate deterministically.

## 6. Order of work

1. `preview/src/canonical/ink.ts` + TS-side vectors.
2. `render.ts` integration (4.1); regenerate fixtures.
3. `src/lib/InkGenes.sol` port + parity test (test 1).
4. `Shapes.sol` changes (§3); tests 2–10.
5. `ShapeRenderer.sol` (4.2); full parity + sweep (test 11).
6. Docs: add a short "Ink Genes" section to SPEC.md linking `INK_GENES_DRAFT.md`,
   recording: order-invariant fold, survivor-choice-not-burn-order, per-tier walk,
   entropy-at-mint-only. Update SECURITY.md's grind note: gene extremes above dust are
   unreachable by direct mint; dust grinding unchanged (accepted risk D3e still stands,
   epoch scheme deferred).

## 7. Do-not list

- Do NOT introduce randomness anywhere except `geneAtMint` (which uses only the seed).
- Do NOT let `burnIds` order, calldata layout, or msg.sender affect any gene.
- Do NOT special-case tier jumps: the walk always runs `newIndex − oldIndex` steps.
- Do NOT change fee, backing, redemption, sacrifice, or `Composed`/`Decomposed`/`Split`
  event signatures.
- Do NOT tune the ⚙ tables; implement the values in §1 exactly.
- Do NOT touch `Denominations.sol` or the PRNG (`Round03Rand`) draw order beyond the
  discard rule in §4.1.

## 8. Definition of done

`forge test` fully green; `forge test --mc Parity` green; `preview/`: `npm run
fixtures` regenerates cleanly and `npm run sweep` passes; all §5 tests present and
passing; SPEC.md and SECURITY.md updated; `inkDemo.ts` removed or rewritten; a summary
of every file touched with a one-line rationale each.

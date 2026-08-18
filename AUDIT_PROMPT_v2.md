# Audit brief — Shapes (recomposition, provenance, terminal Black Shape, ink genes, composability)

You are a senior smart-contract security auditor. Perform a thorough, adversarial
security audit of the **Shapes** contract described below. Your mandate is to
construct working exploits, not to read sympathetically. Assume the contract will
hold real ETH on Ethereum mainnet and that any depositor can be an attacker.

## What to audit — scope

- **Audit branch `main`, at its tip.** As of this brief the tip is commit **`fea94f9`**; audit that
  commit or any later `main` commit, and record the exact one you audit in your report. The
  contract is deployed once and is **immutable** on mainnet — no upgrade path, so every finding is
  permanent.
- **Put the working tree on `main` first.** The repository's primary checkout may be sitting on a
  different feature branch, so do not assume the files in front of you are the audit target. From
  the repo root:

  ```bash
  git fetch origin
  git checkout main && git pull --ff-only
  git log -1 --oneline            # record this commit in your report
  git status                      # confirm a clean tree
  ```

  Audit the working tree at that commit directly (not a PR diff).
- Audit the full `Shapes.sol` + renderer surface. Two areas are the newest and have had **no
  external audit**; treat them as the priority:
  1. **Ink genes** — a seven-state per-token trait with a deterministic compose-time inheritance
     walk, `simulate`/`preview` views, and an `InkGene` event.
  2. **The composability layer** — capability-segmented interfaces, recipient-directed value flows
     (`redeemTo` / `redeemBatchTo` / `decomposeTo` / `restoreTo`), full-state read structs, and
     module-level geometry exposure.

The **v2 recomposition / provenance / terminal Black Shape** layer (compose/decompose/restore,
`originCount`, `blacken`) had one prior internal adversarial pass with no Critical/High; it is
described below and remains in scope, but the two areas above are where new surface was added.

The prior internal review's one accepted hazard stands unchanged: an immutable, reverting
`feeRecipient` can brick minting (redemption is unaffected), mitigated by the constructor
zero-check, the deploy-script contract-recipient gate, and SECURITY.md #6.

## System summary

Shapes are ETH-backed ERC721s. Each token wraps an exact ETH amount at one of nine
fixed denominations (the "ladder"): `0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100` ETH.
Redeeming burns the token and returns exactly its backing. The contract does not
lend, stake, or invest; it is a pure reserve.

The contract adds five areas on top of the v1 mint/redeem core (the first three are v2; the last
two are the newest, externally unaudited surface):

1. **Recomposition (no ETH movement).**
   - `compose(survivorId, burnIds[])`: burns the `burnIds`, grows the survivor to
     the summed denomination (survivor keeps its id and seed). Summed backing must
     land on the ladder or it reverts.
   - `decompose(tokenId, outDenoms[])`: burns the input, mints fresh tokens whose
     backing sums to the input's. Child seeds are `keccak256(abi.encodePacked(parentSeed, i))`.

2. **Provenance via origin conservation.** One `uint32 originCount` per token counts
   independent direct-mint events. Rules: mint → 1; compose → sum of inputs;
   decompose → partition the parent's count among children, **survivor/first-order
   first**, each child capped at its capacity `childBacking / 0.01`. The global sum of
   all `originCount` equals (direct mints) − (origins redeemed) and rises **only** by a
   fresh mint of new ETH — the design claim is that origins, and therefore the
   "Complete" trait, cannot be forged. `Complete = !isBlack && units > 1 &&
   originCount == units`, where `units = backing / 0.01`.

3. **Terminal Black Shape.** `blacken(tokenId)` requires an apex Complete (100 ETH with
   `originCount == 10000`). It moves the 100 ETH out of the redeemable reserve to an
   unspendable address (`0x…dEaD`), marks the token Black, and is irreversible. The
   reserve counter is split: `redeemableBacking` (owed to holders) and
   `sacrificedBacking` (burned, monotonic). Black tokens are non-redeemable and
   non-recomposable but stay transferable.

4. **Ink genes (new, `src/lib/InkGenes.sol`, SPEC.md D17).** Each token carries a `uint8 inkGene`
   in `{Void..Solid}` (0..6), packed into the same storage slot as `denomIndex`/`originCount`/
   `isBlack`. It is a **cosmetic** trait: it drives the rendered solid/outline probability and
   nothing about ETH, backing, or redemption. Rules:
   - **Entropy only at mint.** `geneAtMint(seed, denomIndex)` is a pure function of the token's
     seed and tier. Dust (0.01) rolls the full seven-gene lottery; every larger direct mint rolls
     only the narrow `{Sparse, Murk, Dense}` band, so the four extremes enter the population only
     through dust.
   - **Compose walks deterministically.** `geneAtCompose` steps the survivor's gene at most one
     ladder position per denomination tier crossed, each step a pure roll against a
     units-weighted `center` (70%), the pool `best` (20%), or `worst` (10%). Burn seeds are folded
     order-invariantly by XOR, so `burnIds` order cannot affect the result; survivor choice can.
     No fresh entropy enters any compose/decompose/restore.
   - **decompose/restore copy the gene verbatim.** No roll. `InkGenes.sol` is a byte-exact port of
     the TypeScript canonical `preview/src/canonical/ink.ts`, under the parity suite.

5. **Composability layer (new).** The external surface is segmented into ERC165-advertised
   capability interfaces (`IShapeValue`, `IShapeRecomposition`, `IShapeProvenance`,
   `IShapeSimulation`, `IShapeGeometry`) with new members:
   - **Recipient-directed value flows:** `redeemTo` / `redeemBatchTo` (burn, pay ETH to an
     arbitrary recipient), `decomposeTo` / `restoreTo` (reshape, mint outputs to a recipient).
     Each is a thin wrapper over the same private CEI-guarded impl its owner-directed form uses
     (`redeem` and `redeemTo` both call `_redeemTo`, etc.); only the destination is parameterised.
   - **Structured reads:** `shapeState` returns full state in one call (`faceValueWei` vs
     `redeemableValueWei`, the latter 0 for Black); a `ShapeFormation` enum with stable numeric
     values; `previewCompose`/`previewDecompose`/`previewRestore` return full result structs,
     `view`, no ownership required.
   - **Geometry:** `IShapeGeometry` (`cardGeometry`, `moduleAt`) exposes the renderer's
     module-level geometry, version-pinned by `grammarHash`.

There are three value-bearing `CALL`s: redemption payout (`_settle`, after burn),
the mint-fee forward (fee is 1% of backing, received in the same tx, never counted as
backing), and the `blacken` sacrifice (fixed 100 ETH to the burn address).

The renderer (`ShapeRenderer.sol`) is a byte-for-byte port of a TypeScript canonical
renderer; a Foundry parity suite asserts identical output against generated fixtures.
The renderer is owner-replaceable until `lockRenderer`, and is read only by `tokenURI`.

## The core invariants (these must never break)

1. Solvency: `address(this).balance >= redeemableBacking()` at all times.
2. Backing conservation: `redeemableBacking == Σ backing(live non-Black) ==
   (ETH in) − (ETH redeemed) − (ETH sacrificed)`. compose/decompose leave it unchanged.
3. Origin conservation: `Σ originCount(live, incl. Black) == (mint origins) − (redeemed origins)`;
   no operation manufactures origins except a fresh mint.
4. Capacity: every token `originCount <= backing / 0.01`.
5. Sacrifice: `sacrificedBacking == 100 ether * blackCount`, both monotonic.
6. Every live non-Black Shape is redeemable for exactly its backing.
7. Ink is cosmetic and consumes no reserve: no gene path (`mint`/`compose`/`decompose`/`restore`/
   the `simulate`/`preview` views) reads or moves ETH, backing, or ownership.
8. Ink entropy at mint only: after a token exists, no sequence of compose/decompose/restore/
   redeem/re-mint rerolls its gene without paying a mint fee for fresh seeds; the reachable gene
   tree is finite and deterministic.
9. Ink determinism and parity: `geneAtCompose`/`geneAtMint` are pure functions of on-chain state
   (seed, gene, denomination index), byte-identical to the TypeScript canonical, and independent
   of `burnIds` calldata order.

## Primary files (Solidity is the priority)

- `src/Shapes.sol` — core: mint/redeem (+`*To`), compose/decompose/restore (+`*To`), blacken,
  the `simulate`/`preview` views, accounting, guards.
- `src/lib/InkGenes.sol` — the ink-gene mint lottery, compose walk, and units-weighted center.
- `src/ShapeRenderer.sol` — SVG + metadata, provenance/ink traits, color inversion, `IShapeGeometry`.
- `src/interfaces/IShapeCapabilities.sol` — the capability interfaces + `ShapeState`/`ShapeFormation`.
- `src/interfaces/IShapes.sol`, `src/interfaces/IShapeRenderer.sol`, `src/interfaces/IShapeGeometry.sol`
- `src/lib/Denominations.sol` — the ladder, `unitsAt`, index lookups.
- `src/lib/FixedPoint.sol`, `src/lib/Round03Rand.sol`
- `script/DeployShapes.s.sol` — constructor args, deploy-time invariant checks.

Secondary (TypeScript, lower value-at-risk but in scope for parity/provenance/preview correctness):

- `preview/src/canonical/render.ts` — the renderer source of truth.
- `preview/src/canonical/ink.ts` — the ink-gene canonical `InkGenes.sol` is a byte-exact port of.
- `preview/src/decomposeSeed.ts` — the child-seed derivation the frontend previews with.
- `preview/src/chain/ChainApp.tsx`, `preview/src/chain/abi.ts` — the chain tester UI.

Docs: `SHAPES_V2_SPEC.md` (authoritative v2 design, incl. §17 locked decisions),
`SPEC.md` (rendering decisions; D17 is the ink-gene spec), `INK_GENES_IMPL_SPEC.md` and
`INK_GENES_DRAFT.md` (ink formulas + rationale), `METADATA.md` (every tokenURI trait),
`BUILDING.md` (the composability surface for integrators), `SECURITY.md`, `README.md`.

Toolchain: Solidity 0.8.28, Foundry, `via_ir = true`, OpenZeppelin v5.

## Build and test

```bash
forge build
forge test                       # unit + parity + invariants (default depth)
FOUNDRY_PROFILE=ci forge test    # deep stateful invariants (512 runs × 128 depth)
cd preview && npm run fixtures   # regenerate parity fixtures if you touch the renderer
cd preview && npx tsc --noEmit   # typecheck the frontend + canonical renderer
```

`test/Parity.t.sol` reads `test/fixtures/fixtures.json`; regenerate it before running
parity if you change either renderer.

## What is already tested (find gaps, don't re-derive)

- ~190 unit/integration tests; 10 stateful invariants at CI depth (65,536 calls each,
  0 reverts) covering solvency, backing/origin conservation, capacity, sacrifice.
- Forgery: mint 100 → decompose → recompose ⇒ `originCount == 1`, not Complete.
- Complete propagation; Complete excludes tier 0; Fragment (zero-origin) labelling.
- blacken happy path (a genuine 10,000-origin apex build), terminal guards
  (non-redeemable, non-recomposable, one-way), non-apex/non-owner rejections.
- Deterministic child seeds: exact derivation, invariance across
  roll/warp/prevrandao/fee/chainid, and Solidity↔TypeScript parity.
- Renderer byte-parity across 78 fixtures incl. inverted/Black and every density branch;
  the metadata JSON (incl. the `Ink` trait) is asserted byte-identical to the TypeScript.
- **Ink genes:** constant-table and mint-vector parity; the compose walk cross-checked against
  the TypeScript at every tier span T=1..8 with heterogeneous pools; compose order-invariance;
  homogeneous-pool fixed point; survivor-choice sensitivity; center half-up rounding.
- **Recipient-directed flows:** the `*To` variants are driven in the stateful invariant suite
  against reverting-ETH, non-receiver, and reentrant recipients, with the reserve invariants
  holding throughout and every live Shape still drainable.

Assume these pass. Your job is what they miss.

## Attack surfaces to probe specifically

Treat each as "construct an exploit or prove it safe." Prioritise anything that
removes ETH without an equal burn, forges provenance, or breaks an invariant.

1. **Origin forgery / inflation.** Any compose/decompose sequence that ends with more
   origins than were minted, or a token reading Complete without `units` genuine
   mint-origins. Examine the decompose partition (survivor-first, capacity cap) and the
   `assert(remaining == 0)` — can a rounding or ordering case leave origins unaccounted,
   or over-credit? Cross-lineage or self-referential compositions.
2. **Accounting split desync.** Any path where `redeemableBacking` and
   `sacrificedBacking` drift from real ETH: double-decrement, decrement-without-transfer,
   sacrifice that doesn't leave the balance, or a Black token that remains redeemable.
   Re-derive solvency after `blacken` specifically.
3. **blacken CEI / reentrancy.** It sends 100 ETH to `0x…dEaD` (a fixed address that
   cannot re-enter today — but audit the ordering as if it could). Is state fully
   updated before the external call? Can the guard be bypassed? Can a non-apex or
   already-Black token be blackened? Can `blackCount`/`sacrificedBacking` be desynced?
4. **Reentrancy across new functions.** compose/decompose/blacken and their interaction
   with `_safeMint` receiver callbacks and `onERC721Received`. decompose mints outputs
   via `_safeMint` after accounting — verify a malicious receiver observes only
   consistent state and cannot re-enter to double-mint or corrupt counters.
5. **Denomination / units edge cases.** The new ladder mixes ×5 and ×2 steps. Verify
   `requireIndexOf`, `unitsAt`, and the compose-sum / decompose-sum validation reject
   every off-ladder amount and accept every on-ladder one. Integer truncation in
   `uint8(denomIndex)`, `uint32(originCount)`, `backing / 0.01`.
6. **Decompose seed grinding.** Child seed is `keccak256(parentSeed, i)`. Confirm no
   block data leaks in (no per-block re-roll), and that the seed cannot be steered to a
   chosen artwork given the economic irrelevance of the seed. Seed collisions across
   lineages.
7. **ERC-4906 / metadata.** `MetadataUpdate` emission correctness on compose/decompose/
   blacken. Renderer inversion (Black) and the provenance traits — can metadata assert
   something false about a token (the Fragment label was one such case; look for others)?
8. **Renderer trust boundary.** The renderer is owner-replaceable until locked. Confirm
   it can never touch ETH/backing/ownership, that `tokenURI` is its only caller, and that
   a hostile renderer's worst case is cosmetic. Constructor/`setRenderer` codeless-address
   guard.
9. **Griefing / DoS.** Batch sizes, gas, a token stuck in the contract's own custody, a
   reverting fee recipient, forced-ETH surplus. Any way to brick compose/decompose/redeem
   for a victim.
10. **Frontend/provenance correctness (secondary).** Does `ChainApp.tsx` /
    `decomposeSeed.ts` mislead a user about what a recomposition will produce (the split
    preview claims to be exact)? Any place the UI's formation/complete logic diverges from
    the contract.

### Ink genes

11. **Gene reroll / free entropy.** Construct any sequence (compose / decompose / restore /
    redeem / re-mint) that changes a token's gene without paying a mint fee for fresh seeds.
    decompose→recompose of a token's own children is a homogeneous pool and must be a fixed
    point; confirm the reachable gene tree is finite and deterministic. Grep every gene path for
    block data, `msg.sender`, or any input other than `(seed, gene, denomIndex)`.
12. **Compose-walk determinism and parity.** `geneAtCompose` must be a pure function and
    byte-identical to `ink.ts`. Check the domain strings (`"ink:mint"`, `"ink:compose"`), the
    `abi.encodePacked` types, the thresholds, the center rounding `(2*sumW + U)/(2*U)`, the
    per-tier `keccak(R, k)` roll, and that `newIndex > oldIndex` always holds (no underflow) and
    the gene stays in `[0,6]`. `burnSeedFold` is an XOR fold — confirm no path lets `burnIds`
    order, duplicates, or calldata layout affect the outcome.
13. **`simulate` / `preview` soundness.** `simulateCompose`/`previewCompose` etc. are `view` and
    must mirror what a real `compose` would do exactly, mutate no storage, require no ownership,
    and reject the same inputs (esp. the explicit duplicate-burn-id check standing in for
    `_burn` reverting). Any divergence lets a UI or an integrator be lied to.
14. **Restore soundness with genes.** `restore` captures the gene from the first child only,
    claiming all children of a split share it. Try to break that: transfer, nested split/restore,
    compose-then-restore, or any state where the first child's gene differs from the others while
    the count and backing checks still pass.

### Composability layer

15. **Recipient-directed value flows.** `redeemTo`/`redeemBatchTo`/`decomposeTo`/`restoreTo` send
    ETH or mint to an arbitrary recipient. Confirm the reserve invariant holds against hostile
    recipients (reverting on ETH, non-receiver, reentrant) — the guard, CEI, and the shared
    private impls. Confirm they grant no authority the owner-directed forms don't (caller still
    owns the inputs) and cannot strand a Shape or desync accounting.
16. **Capability / ERC165 and struct correctness.** `supportsInterface` must return true for each
    advertised capability and the `ShapeFormation` enum's numeric values are part of the API — a
    reordering silently misreports formation to every integrator. `shapeState.redeemableValueWei`
    must be 0 for a Black Shape and equal `faceValueWei` otherwise. Any read returning a value
    inconsistent with the live token.
17. **Geometry exposure.** `IShapeGeometry` (`cardGeometry`, `moduleAt`) and `grammarHash` are a
    surface other contracts will pin to. Confirm `moduleAt` bounds-checks, the tuple returns match
    the renderer's own `Card`/`Module`, and whether `grammarHash`/`grammarVersion` is intended to
    be frozen for the renderer's life (it changes if the renderer is replaced before `lockRenderer`).
18. **Gas estimation headroom (informational).** Every `nonReentrant` function's `eth_estimateGas`
    is a lower bound: the guard's SSTORE reset earns a refund credited only at tx end, so a call
    funded with the bare estimate reverts out of gas at the guard cleanup. Wallets buffer; confirm
    the deploy/integration docs warn programmatic callers, and that no on-chain caller forwards a
    bare-estimate gas limit into a Shapes call.

## Deliverable

For each finding: severity (Critical / High / Medium / Low / Informational), the exact
file and line, a concrete exploit scenario or failing input, the broken invariant, and a
recommended fix. Include a runnable Foundry PoC test for every Critical/High. If you find
nothing exploitable on an axis, say so explicitly and state what you checked. End with an
overall risk assessment and any systemic concerns about the origin-conservation model, the
accounting split, the ink-gene determinism/parity model, or the composability surface added on
top of an immutable custodial contract.

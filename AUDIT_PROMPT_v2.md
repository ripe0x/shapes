# Audit brief — Shapes v2 (recomposition, provenance, terminal Black Shape)

You are a senior smart-contract security auditor. Perform a thorough, adversarial
security audit of the **Shapes v2** changes described below. Your mandate is to
construct working exploits, not to read sympathetically. Assume the contract will
hold real ETH on Ethereum mainnet and that any depositor can be an attacker.

## What to audit — exact branch and commits

- Repository branch: **`claude/project-review-planning-e549e5`**
- v2 base (audited-against baseline, already reviewed as v1): **`0e608bb`**
- v2 implementation range to audit: **`e0aec4e..4c22cf6`** (HEAD = `4c22cf6`)

Full diff under review:

```bash
git diff 0e608bb..4c22cf6
```

The nine commits in scope, oldest first:

| Commit | Title |
|---|---|
| `e0aec4e` | v2 Phase 1: swap the denomination ladder to the alternating ×5/×2 set |
| `ae367f5` | v2 Phase 2: originCount provenance storage |
| `27c080a` | v2 Phase 3: compose and decompose |
| `6840058` | Shapes v2 Phase 4: accounting split + terminal Black Shape |
| `85fbfd8` | Shapes v2 Phase 5: renderer inversion + provenance metadata |
| `fb8bba8` | Shapes v2 Phase 6: chain tester UI for recomposition + Black |
| `deda2b9` | Shapes v2 doc-sweep: reflect three ETH-out paths and the accounting split |
| `071ce37` | Shapes v2 review fixes: Fragment label, seed-rule tests, type/wording nits |
| `4c22cf6` | Shapes v2 frontend: local recomposition previews |

## System summary

Shapes are ETH-backed ERC721s. Each token wraps an exact ETH amount at one of nine
fixed denominations (the "ladder"): `0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100` ETH.
Redeeming burns the token and returns exactly its backing. The contract does not
lend, stake, or invest; it is a pure reserve.

v2 adds three things on top of the v1 mint/redeem core:

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

## Primary files (Solidity is the priority)

- `src/Shapes.sol` — core: mint/redeem, compose, decompose, blacken, accounting, guards.
- `src/ShapeRenderer.sol` — SVG + metadata, provenance traits, color inversion.
- `src/interfaces/IShapes.sol`, `src/interfaces/IShapeRenderer.sol`
- `src/lib/Denominations.sol` — the ladder, `unitsAt`, index lookups.
- `src/lib/FixedPoint.sol`, `src/lib/Round03Rand.sol`
- `script/DeployShapes.s.sol` — constructor args, deploy-time invariant checks.

Secondary (TypeScript, lower value-at-risk but in scope for provenance/preview correctness):

- `preview/src/canonical/render.ts` — the renderer source of truth.
- `preview/src/decomposeSeed.ts` — the child-seed derivation the frontend previews with.
- `preview/src/chain/ChainApp.tsx`, `preview/src/chain/abi.ts` — the chain tester UI.

Docs: `SHAPES_V2_SPEC.md` (authoritative v2 design, incl. §17 locked decisions),
`SPEC.md`, `SECURITY.md`, `README.md`.

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

- 130+ unit/integration tests; 10 stateful invariants at CI depth (65,536 calls each,
  0 reverts) covering solvency, backing/origin conservation, capacity, sacrifice.
- Forgery: mint 100 → decompose → recompose ⇒ `originCount == 1`, not Complete.
- Complete propagation; Complete excludes tier 0; Fragment (zero-origin) labelling.
- blacken happy path (a genuine 10,000-origin apex build), terminal guards
  (non-redeemable, non-recomposable, one-way), non-apex/non-owner rejections.
- Deterministic child seeds: exact derivation, invariance across
  roll/warp/prevrandao/fee/chainid, and Solidity↔TypeScript parity.
- Renderer byte-parity across 78 fixtures incl. inverted/Black and every density branch.

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

## Deliverable

For each finding: severity (Critical / High / Medium / Low / Informational), the exact
file and line, a concrete exploit scenario or failing input, the broken invariant, and a
recommended fix. Include a runnable Foundry PoC test for every Critical/High. If you find
nothing exploitable on an axis, say so explicitly and state what you checked. End with an
overall risk assessment and any systemic concerns about the origin-conservation model or
the accounting split.

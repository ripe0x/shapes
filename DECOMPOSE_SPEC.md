# Recomposition rename + reversible compose

Status: design, pre-implementation. Contract + tests first; preview app deferred.

## Vocabulary

Four verbs, two reversible pairs, every name a real word.

| verb | direction | id/seed | reverse of |
|------|-----------|---------|------------|
| `compose` | many burned into one survivor | survivor keeps id + seed, grows | — |
| `decompose` | survivor un-merged into its exact inputs | **inputs regain their original ids + seeds** | `compose` |
| `split` | one burned into many fresh | fresh sequential ids, seeds derived from parent | — |
| `restore` | a split's complete child set reassembled | fresh id carrying the split input's seed | `split` |

The prior `decompose` (free-choice shatter into fresh ids) is renamed `split`. Its inverse `restore` is unchanged. A new `decompose` is added as the exact inverse of `compose`.

Rationale for keeping `split`: `decompose`/`redeem` do not cover splitting a token with no compose history (minted-whole or bought big tokens) or reshaping into a shape the compose history cannot produce. `split` is the only fee-free, ETH-free downward reshape. See conversation for the full case.

## New decompose — exact inverse of compose

### Storage: a per-survivor LIFO stack of self-contained records

```
struct ComposeInput {   // one burned input, everything needed to re-mint it verbatim
    bytes32 seed;       // slot 0
    uint96  id;         // slot 1: token id (uint96 — 8e28 mints to overflow)
    uint32  originCount;// slot 1
    uint8   denomIndex; // slot 1
    uint8   inkGene;    // slot 1
}

struct ComposeRecord {
    uint8   survivorDenomIndex; // survivor's pre-compose state, restored on decompose
    uint32  survivorOriginCount;
    uint8   survivorInkGene;
    ComposeInput[] inputs;
}

mapping(uint256 survivorId => ComposeRecord[] stack) private _composeStack;
```

Self-contained: the record holds every input's full state, so `decompose` reads storage and re-mints with no caller-supplied data and no dependency on event history. Chosen over a hash-commitment + calldata scheme because the token must remain reversible for years without an indexer. Cost: `compose` writes O(n) input slots — same complexity class as `compose`'s existing per-input loop and burns.

A **stack**, not a single slot: `compose` pushes, `decompose` pops the top. Stacking lets the same survivor be composed repeatedly and still unwind fully, one melt at a time, newest first.

### Gas and batching — no in-contract cap

Measured marginal cost: **~52k gas/input to compose, ~67k/input to decompose** (`_safeMint` > `_burn`). Trivial for the realistic reversibility case (small merges); large only at apex scale, which is not practically reversible in bulk either way.

**No input cap in the contract.** The "always decomposable within a block" property is gas-limit-relative, and the contract is immutable — a hardcoded constant would either be permanently too tight (256 forever) or stop guaranteeing anything as the network's block gas limit rises. So the constraint lives in the client, which sizes batches to the live block gas limit. This is also more future-flexible: a record too large to decompose under today's block gas becomes one-shot-decomposable automatically once the limit rises, whereas a cap would forbid even creating it.

Safety is unaffected: an out-of-gas `decompose` reverts atomically (no partial state), and the survivor's funds are always recoverable via `redeem` or `split` regardless. Worst case is "this large record cannot be one-shot decomposed *yet*."

### Batch entrypoints

`composeMany(ComposeCall[] calls)` and `decomposeMany(uint256[] survivorIds)` run their items in order under one reentrancy guard, so a deep build or unwind is a handful of transactions instead of thousands. Both are non-payable, avoiding the `msg.value`-reuse vulnerability a generic `multicall(bytes[])` would open against the payable `mint`/`mintBatch`. Batch order is client-supplied: repeat a survivor to pop several stacked records; list a nested tree parent-before-child (a re-minted input exists by the time its own id is reached). Each is bounded by block gas; the caller sizes the batch. A batch is atomic — any item reverting rolls back the whole call.

### compose (added effect)

Before the input loop, push a record and write the survivor's pre-compose `(denomIndex, originCount, inkGene)`. Inside the loop, before `delete _shapes[bid]` / `_burn(bid)`, push each input's `(id, seed, denomIndex, originCount, inkGene)` to `rec.inputs`. Everything else unchanged. `compose` still keeps `survivorId`'s id and seed.

### decompose(survivorId)

Guards: caller owns `survivorId`; not Black; stack non-empty (`NoComposeRecord`).

Effects (CEI, mint last):
1. Pop-target = top record `rec`.
2. Restore survivor: `s.denomIndex/originCount/inkGene = rec.survivor*`. Seed untouched (compose never changed it).
3. For each `inp` in `rec.inputs`: write `_shapes[inp.id] = ShapeData(inp.seed, inp.denomIndex, inp.originCount, false, inp.inkGene)`.
4. `totalSupply += rec.inputs.length` (compose did `-= n`; symmetric). `totalMinted` untouched — ids are reused, not freshly issued.
5. `redeemableBacking` untouched — backing is conserved (survivor shrinks by exactly the inputs' summed backing; inputs regain it). Same as compose/split/restore.
6. `stack.pop()` (clears the record incl. its inputs array).
7. Emit `Decomposed(survivorId, restoredIds, survivorDenomIndex, survivorOriginCount)`, `InkGene` for survivor + each restored id, `MetadataUpdate(survivorId)`.
8. Interactions: `_safeMint(msg.sender, inp.id)` for each input.

## Safety — why re-minting burned ids is collision-free

- **Fresh mints never collide.** `mint`/`split`/`restore` issue `totalMinted + 1`, strictly greater than any id ever issued. A re-minted input id is `<= totalMinted`, so no fresh mint reproduces it.
- **An input id belongs to at most one live record.** An id is burned when it becomes a compose input. To be an input to a *second* compose it must first be alive again — which only `decompose` does, and `decompose` pops the record that held it in the same call. So no id sits in two live records at once.
- **`_safeMint` is a backstop.** If a malformed stack ever pointed at a live id, OZ `_mint` reverts (`previousOwner != 0`). Worst case is a revert, never corruption.

## Safety — the record is never stale-and-actionable

Every write to a live survivor's `ShapeData` either overwrites/extends its stack or is caught by a guard:

- **`compose(survivorId, …)` again** pushes a new top; `decompose` pops it first (LIFO), restoring to that melt's pre-state — correct.
- **`split`/`redeem`/being a compose input** burn the survivor. `decompose(survivorId)` then reverts on `_requireOwned` — inert. (When burned *as an input*, the record is intentionally kept: the outer `decompose` re-mints the survivor at its snapshot state, matching its own record's post-state, enabling nested unwind.)
- **`blacken`** sets `isBlack` without touching the stack; `decompose`'s `isBlack` guard rejects it.

No path leaves a survivor alive with mutated state and an out-of-date top record.

## LIFO forfeit and nesting

- **Same survivor, stacked:** `compose #3 (0.01→1)` then `compose #3 (1→10)` pushes two records. `decompose #3` twice unwinds 10→1→0.01, re-minting each melt's inputs. Full recovery.
- **Nested, different survivors:** `#3` composed to 1 ETH (record on #3), then `#3` burned into survivor `#50` (record on #50 snapshots #3 at 1 ETH). `decompose #50` re-mints #3 at 1 ETH; `#3`'s own record survives, so `decompose #3` then recovers the atoms.
- **Non-reversal ops forfeit:** `split`/`redeem`/`blacken` on a survivor abandon its stack (records become inert). Consistent with "you chose not to un-merge first."

## Rename blast radius (contract + tests + docs this pass)

- `Shapes.sol`: `decompose`→`split`; `Decomposed` event→`Split`; `DecompositionMismatch`→`SplitMismatch`; `simulateDecompose`→`simulateSplit`; add `decompose` + `decomposeMany` (private `_decompose` core), `composeMany` (private `_compose` core), `Decomposed` (new event), `NoComposeRecord`, `_composeStack`, `ComposeInput`/`ComposeRecord` structs, `composeDepth` view.
- `IShapes.sol`: mirror all of the above; add `ComposeCall` struct.
- `ShapeRenderer.sol`: comment-only (provenance category prose says "decompose remainder" → "split remainder"); no logic change.
- `foundry.toml`: raise `gas_limit`/`block_gas_limit` so the 10,000-origin apex fixtures build with per-input records in the inflated test env.
- Tests: rename split-path tests + event/error names; new `test/Decompose.t.sol` matrix (round trip incl. original ids/seeds, stacked-LIFO, nested, guards, id-reuse safety, batch, atomic-rollback); `decompose` action added to the invariant handler; Black-token decompose guard added to `test_BlackIsTerminal`; mega-gas ceiling updated for the record cost.
- `SPEC.md`, `SHAPES_V2_SPEC.md`: rename + new decompose section.
- Preview app: deferred to a follow-up pass.

## Status: implemented

Contract + interface + tests complete; full suite green (194 passed, 4 fork-only skipped). Invariants (backing/origin/supply conservation, solvency) hold across 8,192 fuzzed calls with `decompose` in the action set. SPEC.md / SHAPES_V2_SPEC.md prose update and the preview app remain.

# Shapes v2 — Composition, Provenance, Black Shape

**Status:** implemented; design rationale preserved as written. Current project status:
project/STATE.md.

This document is written to be reviewed independently. It states the design, the locked
decisions, and — for the non-obvious parts — *why* the design is safe.

---

## 0. Goals & the guiding invariant

Add composition, decomposition, splitting, collectible provenance, and a
terminal Black state to the existing Shapes primitive **without weakening the ETH
backing/redemption guarantees**. `compose` (many into one survivor) is reversed by `decompose`;
`split` (one into many fresh ids) is final. See DECOMPOSE_SPEC.md for the recomposition vocabulary
in full.
The Black state is terminal, but its zero-value NFT may still be burned.

Priority order (from the product owner):
1. Trustworthiness of the ETH backing and redemption system.
2. Composition and provenance as a genuinely meaningful collectible system.
3. Keeping the primitive simple enough for other contracts to build on.

**Top invariant, always true:** `address(this).balance >= redeemableBacking`.

Recomposition moves **no ETH** and conserves backing by an explicit equality check, so it cannot
affect solvency. The only new path that moves ETH out of the contract is `sacrifice`, which sends a
fixed 100 ETH to `0x…dEaD`.

---

## 1. Historical v1 baseline

- ERC721 (`Shapes`) + `ReentrancyGuard` + a separate presentation admin. D-27 later added bounded
  authority to redirect future mint fees without reaching the reserve. Per token it stores only
  `ShapeData { bytes32 seed; uint8 denomIndex }`. Backing is derived from `denomIndex` against a
  fixed denomination table — an off-ladder wei amount is not representable in storage.
- Accounting: `totalBacking`, `totalSupply`, `totalMinted`. Reserve invariant
  `balance >= totalBacking`, asserted by stateful fuzz invariants. Two value-bearing calls exist:
  the mint-fee forward (money received the same tx) and `_payRedemption` (redemption payout, reached only
  after the token is burned).
- Mint charges the immutable flat `mintFee` for each Shape created; the mainnet value is 0.001 ETH
  and `msg.value == backing + mintFee`. Seed derives from
  block data only (no caller-controlled input): `keccak(prevrandao, blockhash, number, timestamp,
  chainid, address(this), firstTokenId)`, then `seed = keccak(batchRoot, tokenId)`.
- Redemption is owner-only, all-or-nothing, `nonReentrant`, checks-effects-interactions; the token
  is burned before any ETH moves.
- Renderer (`ShapeRenderer`) is `pure`/`view`-only, byte-parity with a canonical TypeScript
  renderer (10 primitive kinds, 52 module appearances), and is admin-replaceable until
  `lockPresentation` (a cosmetic power only; the renderer never touches ETH).
- Token IDs are sequential from 0 (`firstTokenId = totalMinted`), so lower ID ⟺ minted earlier.

---

## 2. The core idea: origin conservation (one integer of provenance)

Store **one number per token: `originCount`** = the count of independent direct-mint events
credited to this Shape. It starts at one per mint and is conserved thereafter.

Rules:
- **Direct mint** → each new Shape gets `originCount = 1`.
- **Compose** N→1 → `output.originCount = Σ inputs`.
- **Decompose** (the exact inverse of compose) → the survivor reverts to its pre-compose
  `originCount`; each revived input regains its own original `originCount`. Conserved by
  construction, since it restores the exact pre-compose state (DECOMPOSE_SPEC.md).
- **Split** 1→k → partition the parent's count among children (Σ children = parent), each child
  capped at its capacity `childBacking / 0.01`.

Origins are **conserved** under compose/decompose/split and are **only created by minting new
ETH**.

**Why the count cannot be forged.** Mint one 100 ETH Shape (`originCount = 1`), split it to
10,000 × 0.01, recombine → the count is still **1**, never 10,000. You cannot manufacture origins;
the global sum of all `originCount` equals (direct mints) − (origins redeemed), and no operation
increases it except a fresh mint of new ETH.

**Everything the collectible needs derives from `(backing, originCount, isBlack)`,** with
`units = backing / UNIT`:
- **Formation:** `isBlack ? "Black" : (units > 1 && originCount == units) ? "Complete" :
  originCount == 0 ? "Fragment" : originCount == 1 ? "Direct" : "Composed"`. **Fragment** is a
  zero-origin token: legal per §4 (a split can credit a child no origins — e.g. the 0-origin
  50 ETH half of a split Direct 100). It is a distinct label because such a token was never
  composed; labelling it "Composed" would be the one trait in the system that states something
  false about a token's history.
- **Independent origins:** `originCount`.
- **Origin density** (display): `originCount / units`, expressed as a percentage.
- **Complete** (canonical, on-chain): `!isBlack && units > 1 && originCount == units`.

**Fees are deliberately per object, not backing-neutral:** building a top Shape from 10,000 ×
0.01 pays 10 ETH in fees at the mainnet setting, while minting one direct 100 ETH Shape pays
0.001 ETH. This changes collectible and reroll economics but never backing or redemption.

---

## 3. Complete, in detail

**Complete = maximum origin density:** a token whose `originCount` equals its unit count,
`units = backing / UNIT`, with `units > 1`. It carries as many independent mint events as its
backing has 0.01 units. A lone 0.01 token (`units = 1`) is "Direct," never "Complete."

**An origin is one direct-mint event of any denomination, not a unit of 0.01 ETH.** `originCount`
is a conserved credit; it does not record the denomination the ETH entered at. So Complete does
**not** prove the backing entered as all-0.01 mints. The split partition credits origins to
children up to capacity, which can concentrate credits onto backing they did not enter with.

*Concentration counterexample:* mint 10 × 1 ETH (10 origins), compose to 10 ETH, split to
100 × 0.1. The first child (capacity 10) takes all 10 origins and reads as a "Complete 0.1" whose
origins were 1 ETH mints. This is inherent to integer conservation plus fungible composition and
cannot be closed by any partition rule.

**Origin conservation, not the fee, protects provenance.** One origin is created per Shape mint.
The flat fee makes an origin cost the same at every tier, so the previous claim that dust origins
were always cheapest no longer holds. Concentrating origins still cannot create origin credit or
forge Complete without the required number of distinct mints, but path costs now differ sharply.

**Complete propagates upward.** Composing all-Complete pieces yields a Complete, because
`Σ units_i = units_out` and `Σ originCount_i = originCount_out`, so `originCount_out == units_out`.
Five Complete 1 ETH Shapes (each `originCount = 100`) compose into a Complete 5 ETH
(`originCount = 500 = units`). A mix (a Complete 1 ETH + a *direct* 1 ETH → `originCount 101 ≠ 200`)
is correctly **not** Complete.

**Complete is a live computed property, not a stored flag** — split a Complete and it is no
longer Complete; recompose the pieces (without redeeming any) and it is Complete again. Only the
**100 ETH Complete** (`originCount == 10,000`) can be sacrificed into Black.

Because redemption deletes a token and its origins permanently, the lifetime supply of tokens that
can ever be Complete — and therefore Black — is bounded by cumulative mint history: origins spent on
redemption are gone and cannot be re-earned without new mints.

---

## 4. Split origin partition (worked)

When a Shape splits, its `originCount` is handed to the outputs **in the listed order, each capped
at its capacity** (`backing/0.01`), until exhausted. The total is always conserved, so this is
cosmetic (it only decides which output visibly carries the provenance) and can never enable
forgery.

| Parent | originCount | Split into | Origins land as | Result |
|---|---|---|---|---|
| Complete 1 ETH | 100 | 10 × 0.1 | 10,10,…,10 | ten Complete 0.1s |
| Direct 1 ETH | 1 | 10 × 0.1 | 1,0,…,0 | one 1-origin 0.1, nine 0-origin |
| Composed 5 ETH (50×0.1) | 50 | 5 × 1 ETH | 50,0,0,0,0 | one 50-origin, four 0-origin |
| Complete 100 ETH | 10,000 | 100 × 1 ETH | 100,…,100 | one hundred Complete 1 ETHs |
| Direct 100 ETH | 1 | 2 × 50 ETH | 1,0 | one 1-origin 50, one 0-origin 50 |

`originCount == 0` is legal: backing split off a larger direct mint, carrying no independent
origin. It redeems and recomposes normally; it just is not a provenance leaf.

---

## 5. Token identity (Checks-inspired)

Modeled on Checks (VV Edition) `composite(tokenId, burnId)`, where the caller names which ID
survives. Adapted asymmetrically:

- **Compose (many → one):** caller-named `survivorId` keeps its ID and seed and grows to the summed
  denomination; the other inputs burn. Identity carries **up**. (A meaningful `#837` survives.)
- **Decompose (many → one reversed):** the exact inverse of compose, and the one exception to
  "compose is one-way". The survivor keeps its ID and seed and reverts to its pre-compose
  denomination, origins, and gene; every burned input is re-minted under its **original ID and
  seed** (not a fresh sequential ID). Both the survivor's identity and each input's original
  identity return, so a composed object can be fully unwound (§9.3, DECOMPOSE_SPEC.md).
- **Split (one → many):** the input token is **fully burned**; every output is a fresh
  sequential ID with a seed derived deterministically from the parent's (§9.4). Identity **ends**,
  and so does the artwork: no fragment inherits either, and nothing reassembles them. Composing
  the pieces back yields a token carrying the survivor's own seed, not the split input's.
- **Sacrifice:** in-place transform, same ID/seed/geometry inverted. The Black state is terminal,
  but its zero-value NFT may subsequently be destroyed through `burn`.

So `compose` is the one reversible direction: `decompose` undoes it and returns every original ID.
`split` and `sacrifice` are the only paths that end an identity, and both are final.

Do **not** copy Checks' on-chain composite-history storage: Checks is bounded (tiers only halve, so
≤ ~7 deep), but a Shapes Complete swallows up to 10,000 tokens. Lineage goes in **events**, not
storage.

**Marketplace consequence:** under a live listing, compose only moves backing **up** (seller's
risk, never a buyer rug), and split **burns** the input (stale listing auto-voids). Two in-place
mutation-rug vectors remain, both keeping the token's ID under a standing listing or bid. **Sacrifice**
(100 ETH → 0, in place) on an apex Complete. And **decompose**, which shrinks the survivor's backing
**down** to its pre-compose denomination in place while keeping the same ID and seed: an owner can
reverse a compose and hand a bidder a smaller token than the listing advertised. Decompose is
therefore a buyer-beware vector of the same shape as sacrifice, not the always-up-or-burn safety that
compose and split provide. ERC-4906 `MetadataUpdate` speeds refresh of the token's own listing, but
it does **not** invalidate standing collection- or trait-level WETH offers and bids: a bidder on an
apex Complete can receive a Black Shape if the owner sacrifices and then accepts the bid, and a bidder
on a composed token can receive a decomposed one. Any integrator that values a token by `backingOf`
must treat an owner-held apex Complete as mutable to zero, and any composed token as mutable down to
its pre-compose backing.

---

## 6. Black Shape & ETH sacrifice

A 100 ETH Complete can be permanently transformed into a Black Shape by its owner. The token keeps
its ID, seed, geometry, and lineage; only the colors invert (`#000↔#fff`). After: not redeemable,
not recomposable, `backingOf` = `valueOf` = 0, `burnedBacking` permanently reports 100 ETH.
Black Shapes remain transferable and may be destroyed through `burn` for zero; `sacrifice` itself
does not burn the token. Black burns do not reduce the cumulative sacrifice counters. Black Shapes
remain transferable ERC721s (not soulbound).

**Sacrifice mechanism (decided): send 100 ETH to `0x…dEaD`.** A real, visible burn (contract
balance drops). `0xdEaD` has no code, so no reentrancy; the call is behind
checks-effects-interactions and `nonReentrant`. This is an *economic* burn (the ETH becomes
permanently unspendable) — Ethereum has no way to truly destroy arbitrary ETH, so an unspendable
address is the standard. The sacrifice is independently verifiable on-chain (`burnedBacking`
and the `Blackened` event, plus the balance decrease).

This adds a **third** ETH-out path to the contract (fee forward, redeem/burn payout, sacrifice). It
is tightly bounded: a **fixed 100 ETH** to a **fixed unspendable address**, callable only by the
owner of a **Complete apex, not-yet-Black** Shape.

*(An alternative was an internal accounting sacrifice — keep the ETH in the contract as inert
surplus, no external call. It is arguably safer, but the owner chose the visible 0xdEaD burn for
optics/verifiability.)*

---

## 7. Storage model

```solidity
uint256 constant UNIT             = 0.01 ether;                 // min tier
uint256 constant COMPLETE_ORIGINS = 10_000;                     // 100 ETH / 0.01
address constant UNSPENDABLE             = 0x000000000000000000000000000000000000dEaD;

struct ShapeData {
    bytes32 seed;         // slot 1 (unchanged)
    uint8   denomIndex;   // slot 2
    uint32  originCount;  // slot 2  (max 10,000 << 2^32)
    bool    isBlack;      // slot 2
}
mapping(uint256 => ShapeData) private _shapes;

uint256 public redeemableBacking;   // renamed from totalBacking
uint256 public burnedBacking;   // monotonic; Black Shapes' burned backing
uint256 public blackShapeCount;          // monotonic; number of Shapes ever made Black
uint256 public totalSupply;         // live tokens, INCLUDING Black
uint256 public totalMinted;         // ids issued; the highest is totalMinted-1 (bumped by split mints; NOT by decompose, which reuses ids)

// mintFee is immutable; feeRecipient is admin-updateable for future mints;
// renderer, collection and metadata copy are admin-controlled and one-way lockable together

// per-survivor LIFO stack of self-contained compose records, enabling decompose (§9.3)
struct ComposeInput {           // one burned input, everything needed to re-mint it verbatim
    bytes32 seed;
    uint96  id;                 // original token id, reused on decompose
    uint32  originCount;
    uint8   denomIndex;
    uint8   inkGene;
}
struct ComposeRecord {
    uint8   survivorDenomIndex; // survivor's pre-compose state, restored on decompose
    uint32  survivorOriginCount;
    uint8   survivorInkGene;
    ComposeInput[] inputs;
}
mapping(uint256 survivorId => ComposeRecord[] stack) private _composeStack;
```

**Per-token invariant:** `originCount <= backing / UNIT`. On-chain state per token is one integer of
provenance plus a bool. Lineage is in events; full ancestor trees are reconstructed off-chain. The
compose stack is the one exception to "lineage in events, not storage": `decompose` must re-mint
burned inputs verbatim with no indexer, so each record is self-contained (holds every input's full
state) and `compose` writes O(n) input slots. The stack survives for years without an indexer
(DECOMPOSE_SPEC.md).

---

## 8. Denomination ladder

Replace the table in `Denominations.sol`. Nine tiers; the alternating ×5/×2 progression gives clean
integer tier-to-tier ratios (the old ladder had a ×2.5 gap at 10→25 that broke integer
composition). Grid mapping (density by tier index) is unchanged.

| idx | ETH | units (÷0.01) | grid | modules |
|---|---|---|---|---|
| 0 | 0.01 | 1 | 5×5 | 25 |
| 1 | 0.05 | 5 | 4×5 | 20 |
| 2 | 0.1 | 10 | 4×4 | 16 |
| 3 | 0.5 | 50 | 3×4 | 12 |
| 4 | 1 | 100 | 3×3 | 9 |
| 5 | 5 | 500 | 2×3 | 6 |
| 6 | 10 | 1,000 | 2×2 | 4 |
| 7 | 50 | 5,000 | 1×2 | 2 |
| 8 | 100 | 10,000 | 1×1 | 1 |

`amountAt`, `indexOf`, `labelAt` change; `gridAt` unchanged. Add `unitsAt(i) = amountAt(i)/UNIT`.

---

## 9. Functions

### 9.1 Mint (existing, one change)
`_mintBatch` sets `originCount = 1` per token; `redeemableBacking += backing`. The flat fee applies
to each newly minted Shape. Seed derivation unchanged. Recompose functions take no `msg.value`, so **no fee** applies
to already-wrapped ETH.

### 9.2 compose — many → one, survivor keeps ID
```solidity
function compose(uint256 survivorId, uint256[] calldata burnIds)
    external nonReentrant returns (uint256 outId);
```
- **Checks:** caller owns `survivorId` and every `burnId`; none Black — the survivor included, not
  only the burned inputs (§9.7); `burnIds.length >= 1`; no id equals `survivorId`;
  `total = backing(survivor) + Σ backing(burnIds)` is a valid ladder denom.
- **Effects (no external calls — `_burn` triggers no callback):** push a `ComposeRecord` onto
  `_composeStack[survivorId]` capturing the survivor's pre-compose `(denomIndex, originCount,
  inkGene)`; for each `burnId`, before deleting its state, append its full `(id, seed, denomIndex,
  originCount, inkGene)` to `rec.inputs`, then burn it (`delete` state, `_burn`),
  `totalSupply -= burnIds.length`; set `survivor.denomIndex = indexOf(total)` and
  `survivor.originCount += Σ originCount(burnIds)` (seed unchanged); `redeemableBacking` unchanged
  (backing conserved). The record is self-contained so `decompose` (§9.3) can re-mint every input
  verbatim with no caller data and no indexer.
- **Duplicates:** a repeated id in `burnIds` reverts, because the second `_burn` targets a token
  that no longer exists (mirroring v1 `redeemBatch`), so the pre-summed backing cannot double-count.
- **Emit** `Composed(survivorId, burnIds, newDenomIndex, newOriginCount)`, `ShapeAbsorbed` per
  burned input, `InkGene(survivorId, …)` + `MetadataUpdate(survivorId)`. Returns `survivorId`.
- Backing only ever increases here → no buyer-rug risk.
- **`composeMany(ComposeCall[] calls)`** runs a list of composes in order under one reentrancy
  guard (non-payable, so no `msg.value`-reuse against the payable mint paths). Atomic: any item
  reverting rolls back the whole call. No in-contract cap; the caller sizes the batch to block gas.

### 9.3 decompose — many → one reversed, the exact inverse of compose
```solidity
function decompose(uint256 survivorId) external nonReentrant returns (uint256[] memory restoredIds);
function decomposeTo(uint256 survivorId, address recipient) external nonReentrant returns (uint256[] memory restoredIds);
function decomposeMany(uint256[] calldata survivorIds) external nonReentrant returns (uint256[][] memory restoredIds);
function decomposeManyTo(uint256[] calldata survivorIds, address recipient) external nonReentrant returns (uint256[][] memory restoredIds);
```
Pops the survivor's most-recent compose and reverses it exactly. The compose stack is per-survivor
LIFO (§7): `compose` pushes, `decompose` pops the top, so a survivor composed repeatedly unwinds one
step at a time, newest first.

- **Checks:** caller owns `survivorId`; not Black; the stack is non-empty (`NoComposeRecord`).
- **Effects (CEI, mint last):** pop the top record `rec`; restore the survivor's
  `(denomIndex, originCount, inkGene)` from `rec.survivor*` (seed untouched, since compose never
  changed it); for each `inp` in `rec.inputs`, write `_shapes[inp.id]` back to its captured
  `(seed, denomIndex, originCount, isBlack=false, inkGene)`; `totalSupply += rec.inputs.length`
  (compose did `-= n`; symmetric); **`totalMinted` untouched, since ids are reused, not freshly
  issued**;
  `redeemableBacking` unchanged (backing conserved: the survivor shrinks by exactly the inputs'
  summed backing, which the inputs regain); `stack.pop()`. **Interaction:** `_safeMint` each input
  under its **original id** to the caller (or `recipient`).
- **Why re-minting burned ids is collision-free:** fresh mints always issue `totalMinted`, above every id already issued,
  strictly greater than any reused id; an input id belongs to at most one live record at a time; and
  `_safeMint` reverts rather than corrupting if a malformed stack ever pointed at a live id
  (DECOMPOSE_SPEC.md).
- **No in-contract input cap.** Reversibility "within a block" is gas-limit-relative and the
  contract is immutable, so the batch-size constraint lives in the client, which sizes to the live
  block gas limit. An out-of-gas `decompose` reverts atomically; the survivor's funds stay
  recoverable via `redeem` or `split` regardless.
- **`decomposeMany(survivorIds)`** pops in order under one reentrancy guard: repeat a survivor to
  pop several stacked records; list a nested tree parent-before-child so a re-minted input exists by
  the time its own id is reached. Atomic. The `*To` variants direct the revived tokens to a named
  recipient.
- **Emit** `Decomposed(survivorId, restoredIds, survivorDenomIndex, survivorOriginCount)`,
  `ShapeRevived` per revived id, `InkGene` for the survivor and each revived id, and
  `MetadataUpdate(survivorId)`. Re-minted inputs do **not** emit `ShapeMinted` (no origin is
  created). Returns `restoredIds`.

### 9.4 split — one → many, input burned, all fresh IDs
```solidity
function split(uint256 tokenId, uint8[] calldata outDenoms)
    external nonReentrant returns (uint256[] memory newIds);
function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient)
    external nonReentrant returns (uint256[] memory newIds);
```
- **Checks:** caller owns `tokenId`; not Black; `outDenoms.length >= 2`;
  `Σ amountAt(outDenoms) == backing(tokenId)`. (Each output is a valid tier by construction; the
  `>= 2` + equal-sum constraints force every child strictly smaller than the parent.) Free-form:
  the breakdown is **not** tied to how the token was composed.
- **Effects:** burn `tokenId` (`delete`, `_burn`), `totalSupply -= 1`. For each `outDenoms[i]` in
  order, mint a fresh sequential id; child `i`'s seed is `keccak256(abi.encodePacked(parentSeed, i))`,
  where `parentSeed` is the burned token's seed and `i` is the index into `outDenoms` — no block
  data is read; `originCount_i = min(remaining, amountAt(i)/UNIT)`; `remaining -= originCount_i`;
  assert `remaining == 0`. `redeemableBacking` unchanged. All accounting is done **before** the
  `_safeMint` loop (receiver-callback safe, mirroring `_mintBatch`); `nonReentrant`.
- **Emit** `Split(tokenId, parentSeed, newIds, outDenoms, originCounts)`, carrying the parent
  seed (so indexers can associate sibling sets) and the per-child origin
  partition so indexers do not re-implement the fill-in-order rule. Split outputs do **not**
  emit `ShapeMinted`: `ShapeMinted` is a strict origin-creation signal, and a split creates tokens
  without creating origins. Returns `newIds`.

**Seed derivation rationale.** Any rule that gives split outputs new block-entropy seeds would
permit seed re-rolling through split-then-compose loops, so re-rolling cannot be prevented, only
priced. Deriving child seeds deterministically from the parent seed fixes the full split tree of
every token at mint: owners navigate a possibility space set at mint rather than rolling per-block
entropy, and the frontend can preview split results exactly before executing. Siblings are
distinct (index-salted) yet derived from the parent, consistent with the "split ends identity"
decision. Mint seed derivation is unchanged.

### 9.6 sacrifice — apex Complete → Black, in place
```solidity
function sacrifice(uint256 tokenId) external nonReentrant;
```
- **Checks:** caller owns `tokenId`; `!isBlack`; `originCount == COMPLETE_ORIGINS && denomIndex == 8`.
- **Effects (CEI):** `isBlack = true`; `redeemableBacking -= 100 ether`;
  `burnedBacking += 100 ether`; `blackShapeCount += 1`. **Interaction:**
  `UNSPENDABLE.call{value: 100 ether}("")`, require success. Token keeps ID/seed/denom/originCount.
- **Emit** `Blackened(tokenId, 100 ether)` + `MetadataUpdate(tokenId)`.

### 9.7 Guards on existing paths
Normal redemption rejects Black Shapes; the draft ERC-8060 `burn` path destroys one for zero.
Compose/decompose/split reject Black inputs. `decompose` additionally reverts on an empty stack
(`NoComposeRecord`). `split`/`redeem`/`sacrifice`
on a survivor abandon its compose stack (the records become inert), consistent with "you chose not
to un-merge first" (DECOMPOSE_SPEC.md).

### 9.8 Views
`exists(id)` → a non-reverting ERC-721 liveness check, true for every live token including Black and
false for never-issued or retired ids; `denomIndexOf(id)` → the stored 0..8 ladder index for a live
token (including 8 for Black), reverting for a nonexistent id; `backingOf(id)` → 0 if Black else
`amountAt(denomIndex)`; `originCountOf`, `isBlack`, `isComplete`
(`!Black && units > 1 && originCount == units`, `units = backing/UNIT`), `redeemableBacking`,
`burnedBacking`, `blackShapeCount`, `composeDepth(survivorId)` → `_composeStack[survivorId].length`
(how many stacked composes `decompose` can still reverse). `tokenURI` passes
`(seed, amount, id, originCount, isBlack, composeDepth)` to the renderer.

---

## 10. Events

```solidity
event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint32 originCount);
event Decomposed(uint256 indexed survivorId, uint256[] restoredIds, uint8 survivorDenomIndex, uint32 survivorOriginCount);
event Split(uint256 indexed tokenId, bytes32 parentSeed, uint256[] newIds, uint8[] outDenoms, uint32[] originCounts);
event Blackened(uint256 indexed tokenId, uint256 sacrificedWei);
event ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount);
event ShapeRevived(uint256 indexed survivorId, uint256 indexed revivedId);   // one per input re-minted by decompose
event MetadataUpdate(uint256 tokenId);          // ERC-4906
// existing: ShapeMinted (+ originCount=1), MintFeePaid, RendererUpdated, PresentationLocked
// filterable edges: ShapeAbsorbed (per compose input), ShapeFragmentCreated (per split child)
// new error NoComposeRecord(survivorId): raised by decompose on an empty stack
```
`ShapeRedeemed` carries the redeemed token's `originCount` so an event-only indexer can maintain the
global origin balance (mint origins − redeemed origins) without a pre-burn state read. Adding this
field changed the event's topic0 versus the three-argument form used in earlier development builds;
this is the canonical shape for the initial (and only) deployment, so there is no on-chain predecessor
and no indexer back-compat obligation. Integrators index the four-argument signature.

`Split` carries the per-child origin partition (`originCounts`) so indexers never re-implement
the fill-in-order rule. Split outputs do **not** emit `ShapeMinted`: that event is a strict
origin-creation signal, so token creation from a split is signalled by `Split` alone. Advertise
ERC-4906 in `supportsInterface` (`0x49064906`).

`Decomposed` signals the reverse of a compose: `restoredIds` are the burned inputs re-minted under
their **original** ids, and the survivor reverts to `survivorDenomIndex` / `survivorOriginCount`.
Re-minted inputs do **not** emit `ShapeMinted` (no origin is created; ids are reused, not issued), so
an indexer maintaining the origin balance ignores them and instead pairs each `Decomposed` with the
`Composed` it reverses.

---

## 11. Renderer & metadata

- The new ladder flows through `Denominations` (the renderer already reads it); grids unchanged.
- Interface expands: `renderSVG(seed, amount, inverted)`,
  `metadataJSON(seed, amount, id, originCount, inverted, composeDepth)`, and the matching `tokenURI`.
  The renderer is upgradeable, so this is a clean extension. `composeDepth` is the one mutable-state
  input the renderer reads, plumbed through from `Shapes.tokenURI`'s `_composeStack[id].length`; the
  rest are seed-derived.
- Color: `(bg, fg) = inverted ? (#fff, #000) : (#000, #fff)`; replace the two hardcoded literals.
  Black Shape is the exact inverse (same seed, geometry, coordinates). Deterministic.
- Metadata traits, in emission order: `ETH Value`, `Grid`, `Fill`, `Ink`, `Modules`,
  `Module Count`, then the **visual-rarity block** `Primitive` / `Variety` / `Ink Tier`, then the
  **provenance block** `Formation` / `Independent Origins` / `Origin Density` (`originCount / units`
  as a percentage) / `Complete` (bool) / `Black` (bool), and finally `Compose Depth` last.
  - `Primitive`: the dominant of the ten primitive kinds on the card, ties resolving to the lowest
    KIND index.
  - `Variety`: the count of distinct kinds present, `"1"`..`"10"`.
  - `Ink Tier`: the 7-state ink gene banded to `Mythic` (Void/Solid), `Rare` (Faint/Rich), or
    `Common` (the rest).
  - `Compose Depth`: `Shapes.composeDepth(id)`, the reversible-compose stack depth; `0` at mint,
    incremented by each `compose`, decremented by the matching `decompose`.
  The visual-rarity and `Compose Depth` traits are **aesthetic only** and carry no economic weight;
  redemption value stays denomination-only (SPEC.md D15). See TRAIT_SPEC.md.
- The TypeScript canonical renderer is updated in lockstep; fixtures regenerated; byte-parity suite
  must stay green (`Compose Depth` is a plain `metadataJSON` parameter, a fixture input rather than
  something the TS renderer derives).

---

## 12. Tests

**New invariants (stateful fuzz, ci profile):**
1. Solvency: `balance >= redeemableBacking`.
2. Backing conservation: compose/split leave `redeemableBacking` unchanged; `redeemableBacking
   + burnedBacking` never exceeds cumulative real ETH in.
3. Origin conservation: `Σ live originCount (incl Black) == Σ mint-origins − Σ redeemed-origins`.
4. Capacity: every token `originCount <= backing/UNIT`.
5. Global capacity: `Σ originCount over live tokens <= Σ units of live backing`.
6. Sacrifice accounting: `burnedBacking == 100 ether * blackShapeCount`.

**Unit / regression:**
- Forgery: mint 100 → split → recompose ⇒ `originCount == 1`, not Complete.
- Complete propagation: five Complete-1ETH compose ⇒ Complete 5 ETH.
- Complete excludes tier 0: a 0.01 token (`units == 1`) is "Direct", never "Complete".
- compose: ownership, Black-reject, invalid-sum reject, survivor ID/seed retained, backing up-only.
- split: sum check, `>= 2`, all-fresh IDs, origin partition (§4 cases), input burned.
- sacrifice: apex-gated, non-Complete reverts, double-sacrifice reverts, post-Black redeem/compose/
  decompose/split revert, `backingOf == valueOf == 0`, `burnedBacking == 100`, balance −100 to 0xdEaD,
  transfers and zero-value `burn` still work.
- ERC-4906 emission; `supportsInterface`.
- Existing suite updated for the new ladder + provenance (fixtures, any hardcoded `25 ETH`).

---

## 13. Gas & scalability

Building a Complete 100 ETH is irreducibly ~10,000 mints + ~10,000 burns spread across **many
transactions** (hundreds of millions of gas total). No representation avoids consuming 10,000 token
IDs, because each 0.01 origin *is* a token. This is a deliberate multi-transaction monument. The
contract supports **incremental** builds (compose subsets into valid-denom intermediates); the
**frontend orchestrates** the climb and reconstructs progress from events. **No hard per-call cap**
(gas is the natural limit, self-inflicted — operations only touch the caller's own tokens; matches
the existing "no batch cap" stance). Split fanout is similarly gas-bounded; exploding to 10,000
is possible but impractical and pointless.

`decompose` is likewise uncapped in the contract. Measured marginal cost is ~52k gas/input to
compose and ~67k/input to decompose (`_safeMint` > `_burn`), trivial for the realistic small merges
and large only at apex scale, which is not practically reversible in bulk either way. The
"decomposable within a block" property is gas-limit-relative and the contract is immutable, so no
hardcoded cap is used: a record too large to decompose under today's block gas becomes one-shot
decomposable automatically once the limit rises. `composeMany`/`decomposeMany` batch a deep build or
unwind into a handful of transactions, each sized to block gas by the client (DECOMPOSE_SPEC.md).

Because recompose charges no fee, ID and seed generation is fee-free: one small mint funds unlimited
split/compose cycles, inflating `totalMinted` and event volume without bound (paying only gas).
This is economically harmless — no ETH or origins are created — but indexers must not assume
`totalMinted` approximates mint volume; it counts ids issued, not mints.
`decompose` does **not** bump `totalMinted` (it reuses ids), so a decompose-heavy history leaves
`totalMinted` unmoved while `totalSupply` rises.

---

## 14. Security notes & documentation sweep

- **ETH-out paths: three now** — fee forward, redeem/burn payout, and sacrifice → 0xdEaD
  (fixed 100 ETH, fixed unspendable dest, apex-Complete + owner gated, CEI + `nonReentrant`). Add
  invariant coverage.
- Recompose has **zero external calls** (compose) / callback-safe minting (split, decompose), and
  backing is conserved by an explicit equality check ⇒ it cannot break solvency. `decompose` moves
  no ETH; it is not a fourth ETH-out path.
- Marketplace mutation has **two in-place vectors**: **sacrifice** (compose up-only, split burns, so
  those two never rug) and **decompose**, which shrinks the survivor's backing **down** in place
  while keeping its id and seed, a buyer-beware vector of the same shape as sacrifice. ERC-4906
  speeds refresh of the token's own listing but does not cancel standing WETH offers/bids (§5); an
  integrator valuing a token by `backingOf` must treat an owner-held apex Complete as mutable to
  zero, and any composed token as mutable down to its pre-compose backing.
- Mint-time seed grinding (the v1 SPEC.md D3e residual, one attempt per block) now selects an entire
  deterministic split tree rather than a single seed. Accepted for the same reason: seeds have
  no economic effect, since redemption value is set by denomination alone.
- Re-minting burned ids on `decompose` is collision-free: fresh mints always issue `totalMinted`
  (strictly greater than any reused id), an input id belongs to at most one live record at a time,
  and `_safeMint` reverts rather than corrupting on any malformed stack (§9.3, DECOMPOSE_SPEC.md).
- `0xdEaD` is an economic burn (unspendable); Ethereum cannot truly destroy arbitrary ETH.

**Adversarial checklist covered:** reserve insolvency (conservation), rounding (all denoms exact wei
multiples), provenance forgery (origin-*count* conservation; the denominational claim is not made —
see §3), duplicate-origin accounting (conservation; duplicate `burnIds` revert), split-recombine
(conservation), token-ID manipulation (caller-named survivor, own tokens only), reentrancy
(nonReentrant + CEI + compose has no calls), malicious receivers (accounting before mint),
large-batch griefing (self-inflicted only), gas DoS (no third-party forcing), overflow (uint32 vs
10,000; uint256 sums), event ambiguity (explicit lineage events), sacrifice twice (state flag), redeem
after sacrifice (guard), recompose Black (guard), burned-ETH-as-backing (sacrificed excluded from
redeemable), forced ETH (inert surplus, unchanged), fee/reserve interaction (fee only on new ETH),
apex Complete without 10,000 mints (impossible — `originCount == 10,000` requires 10,000 mints by
conservation; density concentration cannot lower this).

**Documentation stale after v2 ships (sweep before deploy):**
- `Shapes.sol` contract header — the "exactly one code path that moves ETH out" claim (now three).
- `SECURITY.md` — the "only two value-bearing CALLs" table row (now three).
- `SPEC.md` — D3e, rewritten per change set 1 (deterministic split seeds; grinding now selects a
  full tree, not a single seed).
- `README.md` — "lower ID means minted earlier" no longer holds: split outputs receive fresh
  high IDs unrelated to their provenance age.

---

## 15. Migration

None. Pre-deployment, fresh non-proxy deploy. Confirmed: no git remote, no broadcast artifacts, no
tokens exist anywhere.

---

## 16. Phased build order (each phase keeps invariants green before the next)

1. **Ladder swap** (`Denominations` table) + regenerate fixtures + full green. Isolated, no new
   surface.
2. **`originCount` storage** — set `=1` on mint, add views + `ShapeMinted` provenance,
   origin-conservation invariant (trivially holds). No behavior change.
3. **`compose` + `decompose` + `split`** — no ETH movement, conservation asserts, ERC-4906, events.
   Highest scrutiny: CEI, `nonReentrant`, invariants + fuzz, forgery test. `compose` writes the
   per-survivor stack that `decompose` reverses (original-id revival, id-reuse collision safety);
   `split` introduces the child seed rule `childSeed_i = keccak256(abi.encodePacked(parentSeed, i))`
   (SPEC.md D3e); its TypeScript twin (`preview/src/splitSeed.ts`) and a Solidity↔TS parity fixture
   land here too, since the frontend must preview split children before their ids exist and phase 5's
   fixture/parity story otherwise covers only the renderer.
4. **Accounting split + `sacrifice`** — `redeemableBacking`/`burnedBacking`, 0xdEaD sacrifice,
   Black guards, updated solvency invariant + SECURITY.md.
5. **Renderer** — inversion + provenance traits, TS lockstep, parity, metadata tests.
6. **Frontend** — multi-tx compose orchestration, provenance UI, Complete/Black flows.

---

## 17. Locked decisions

| Topic | Decision |
|---|---|
| Compose identity | Caller-named survivor keeps ID/seed, grows to summed denom; other inputs burn. |
| Compose reversibility | Per-survivor LIFO stack of self-contained records; `composeDepth` view exposes the depth; `decompose` pops the top. |
| Decompose identity | Exact inverse of compose: survivor keeps ID/seed and reverts to its pre-compose state; every input revived under its **original** ID/seed; `totalMinted` unchanged (ids reused). Batch + `*To` variants; no in-contract cap. |
| Split identity | Input fully burned; all outputs are fresh IDs. |
| Sacrifice identity | In-place transform (same ID/seed/geometry, inverted); `sacrifice` never burns. |
| Metadata refresh | ERC-4906 `MetadataUpdate` on every mutation. |
| Provenance | One `uint originCount`, conserved; lineage in events; trees off-chain. |
| Complete | `originCount == units && units > 1` (tier 0 excluded); "Complete" is the trait name. |
| Sacrifice gate | Apex only (`originCount == 10,000 @ 100 ETH`). |
| ETH sacrifice | Send 100 ETH to `0x…dEaD`. |
| Black transferability | Transferable (not soulbound). |
| Composition freedom | Multi-tier allowed to any valid ladder denom; frontend defaults to ladder steps. |
| Per-call caps | None; frontend chunks; gas is the limit. |
| Split freedom | Free-form (`uint8[] outDenoms` summing to backing); not tied to composition history. |
| Split seeds | `keccak256(parentSeed, i)`, deterministic; full tree fixed at mint; previewable off-chain. |
| Origin partition | Fill outputs in listed order, capacity-capped (cosmetic; total conserved). |
| Origin density | Trait `originCount / units` as a percentage (replaces Origin Denomination). |
| Aesthetic traits | `Primitive`, `Variety`, `Ink Tier`, `Compose Depth` added to metadata; aesthetic only, no economic weight (TRAIT_SPEC.md). |
| Ladder | `0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100` (`0.05` replaces `25`). |

---

## 18. Open questions for a reviewer

1. **Resolved.** Origin-*count* conservation holds; the global sum changes only on mint/redeem. The
   earlier denominational claim (that Complete proves all-0.01 origins) was invalid and has been
   removed (§3). Remaining ask: confirm no compose/split sequence increases the global count.
2. **Resolved.** The split origin partition is forgery-safe (the total is always conserved) and
   owner-controlled. Origin-density concentration is inherent to integer conservation and
   acknowledged in §3; it is economically irrational, not preventable by any partition rule.
3. **Decided** (§17): 0xdEaD sacrifice, accepting the third ETH-out path for on-chain visibility.
4. **Decided** (§14 caveat): in-place sacrifice can rug standing WETH bids on an apex Complete;
   documented, and ERC-4906 does not cancel offers.
5. **Confirmed fine.** `uint32 originCount` (max 10,000) + `uint8 denomIndex` + `bool isBlack` pack
   into one slot with headroom; `uint256` backing sums stay far below overflow at any bounded scale.

---

## 19. Final value and position discovery amendment

- `exists(tokenId)` exposes ERC-721 liveness without reverting. It is true for any live
  Shape, including Black, and false for never-issued, redeemed/burned, split-parent and
  compose-consumed ids. Decompose can make a compose-consumed id live again.
- `denomIndexOf(tokenId)` exposes the stored denomination index directly, returns 0..8 for a live
  Shape (8 for Black), and reverts for a nonexistent id like the other token-state getters.
- `valueOf(tokenId)` exactly aliases `backingOf(tokenId)`. It returns the native ETH the current
  owner would receive by burning now, returns zero for Black, and reverts for nonexistent IDs.
- Shapes implements the current draft ERC-8060 `IERC721Value` interface (`valueOf` + owner-only
  `burn`) and advertises its current interface ID through ERC-165. The proposal is still a draft.
- `burn` destroys a normal Shape for its exact current value or a Black Shape for zero. Structural
  burns in compose/split and identity revival in decompose remain value-conserving and
  never settle ETH.
- Fresh token IDs use the monotonic `totalMinted` count as the next id. Decompose may revive only
  the exact inputs recorded by the compose it reverses; redemption, public burn and split do not
  recycle retired IDs.
- `positions()` and `market()` each start at `(address(0), false)`. The transferable admin may set,
  replace or clear either through `setPointer` while that entry is unlocked. `lockPointer`
  permanently freezes only the selected entry and may lock it while zero. Pointer id 0 means
  Positions and 1 means Market; every other id reverts. Nonzero targets must carry code when set,
  but locking freezes only the stored address, not the target's implementation.
- `positionOf(tokenId)` returns zero without a positions target. Otherwise it queries the
  target without checking token existence, backing or position status; failures and malformed
  address returns become zero.
- A positions target may aggregate future position systems. The market pointer is discovery only.
  Neither target is exclusive, and no core state-changing Shapes operation calls either one.
- Reverse compose ancestry is not stored as a separate core mapping. On-chain code can inspect a
  survivor's compose records; historical reverse lookup remains event/indexer territory unless a
  concrete protocol later establishes semantics that justify permanent per-input storage.
- Renouncing admin permanently ends any remaining renderer or pointer administration; a prior
  admin transfer moves all still-unlocked authority to the new admin. Shape #0 ownership is
  independent and moves no authority.

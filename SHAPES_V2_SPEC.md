# Shapes v2 — Composition, Provenance, Black Shape

**Status:** proposal, pre-implementation. This is a design spec for review, not yet built.
The current contracts (v1) are pre-deployment (no remote, no deployment anywhere).

This document is written to be reviewed independently. It states the design, the locked
decisions, and — for the non-obvious parts — *why* the design is safe.

---

## 0. Goals & the guiding invariant

Add composition, decomposition, collectible provenance, and a terminal Black Shape state to the
existing Shapes primitive **without weakening the ETH backing/redemption guarantees**.

Priority order (from the product owner):
1. Trustworthiness of the ETH backing and redemption system.
2. Composition and provenance as a genuinely meaningful collectible system.
3. Keeping the primitive simple enough for other contracts to build on.

**Top invariant, always true:** `address(this).balance >= redeemableBacking`.

Recomposition moves **no ETH** and conserves backing by an explicit equality check, so it cannot
affect solvency. The only new path that moves ETH out of the contract is `blacken`, which sends a
fixed 100 ETH to `0x…dEaD`.

---

## 1. How Shapes works today (v1 summary)

- ERC721 (`Shapes`) + `ReentrancyGuard` + `Ownable`. Per token it stores only
  `ShapeData { bytes32 seed; uint8 denomIndex }`. Backing is derived from `denomIndex` against a
  fixed denomination table — an off-ladder wei amount is not representable in storage.
- Accounting: `totalBacking`, `totalSupply`, `totalMinted`. Reserve invariant
  `balance >= totalBacking`, asserted by stateful fuzz invariants. Two value-bearing calls exist:
  the mint-fee forward (money received the same tx) and `_settle` (redemption payout, reached only
  after the token is burned).
- Mint charges a fee of `feeBps` (1%) on new ETH; `msg.value == backing + fee`. Seed derives from
  block data only (no caller-controlled input): `keccak(prevrandao, blockhash, number, timestamp,
  chainid, address(this), firstTokenId)`, then `seed = keccak(batchRoot, tokenId)`.
- Redemption is owner-only, all-or-nothing, `nonReentrant`, checks-effects-interactions; the token
  is burned before any ETH moves.
- Renderer (`ShapeRenderer`) is `pure`/`view`-only, byte-parity with a canonical TypeScript
  renderer (10 primitive kinds, 52 module appearances), and is owner-replaceable until
  `lockRenderer` (a cosmetic power only; the renderer never touches ETH).
- Token IDs are sequential (`firstTokenId = totalMinted + 1`), so lower ID ⟺ minted earlier.

---

## 2. The core idea: origin conservation (one integer of provenance)

Store **one number per token: `originCount`** = the count of independent direct-mint events
credited to this Shape. It starts at one per mint and is conserved thereafter.

Rules:
- **Direct mint** → each new Shape gets `originCount = 1`.
- **Compose** N→1 → `output.originCount = Σ inputs`.
- **Decompose** 1→k → partition the parent's count among children (Σ children = parent), each child
  capped at its capacity `childBacking / 0.01`.

Origins are **conserved** under compose/decompose and are **only created by minting new ETH**.

**Why the count cannot be forged.** Mint one 100 ETH Shape (`originCount = 1`), decompose it to
10,000 × 0.01, recombine → the count is still **1**, never 10,000. You cannot manufacture origins;
the global sum of all `originCount` equals (direct mints) − (origins redeemed), and no operation
increases it except a fresh mint of new ETH.

**Everything the collectible needs derives from `(backing, originCount, isBlack)`,** with
`units = backing / UNIT`:
- **Formation:** `isBlack ? "Black" : (units > 1 && originCount == units) ? "Complete" :
  originCount == 1 ? "Direct" : "Composed"`.
- **Independent origins:** `originCount`.
- **Origin density** (display): `originCount / units`, expressed as a percentage.
- **Complete** (canonical, on-chain): `!isBlack && units > 1 && originCount == units`.

**Fee neutrality falls out:** building a top Shape from 10,000 × 0.01 pays the same total fee as
minting it directly (10,000 × 1% of 0.01 = 1% of 100 ETH). No fee arbitrage between paths.

---

## 3. Complete, in detail

**Complete = maximum origin density:** a token whose `originCount` equals its unit count,
`units = backing / UNIT`, with `units > 1`. It carries as many independent mint events as its
backing has 0.01 units. A lone 0.01 token (`units = 1`) is "Direct," never "Complete."

**An origin is one direct-mint event of any denomination, not a unit of 0.01 ETH.** `originCount`
is a conserved credit; it does not record the denomination the ETH entered at. So Complete does
**not** prove the backing entered as all-0.01 mints. The decompose partition credits origins to
children up to capacity, which can concentrate credits onto backing they did not enter with.

*Concentration counterexample:* mint 10 × 1 ETH (10 origins), compose to 10 ETH, decompose to
100 × 0.1. The first child (capacity 10) takes all 10 origins and reads as a "Complete 0.1" whose
origins were 1 ETH mints. This is inherent to integer conservation plus fungible composition and
cannot be closed by any partition rule.

**Why concentration is economically irrelevant.** One origin is created per mint, and the mint fee
is proportional to size, so the cheapest origin is a 0.01 mint. Reaching any given `originCount` by
the honest all-0.01 path is therefore always the cheapest route; concentration requires minting
larger, more expensive tokens to earn the origins and then stranding those credits on smaller
backing, which is strictly more costly than minting the 0.01 tokens directly. No rational actor
fabricates density.

**Complete propagates upward.** Composing all-Complete pieces yields a Complete, because
`Σ units_i = units_out` and `Σ originCount_i = originCount_out`, so `originCount_out == units_out`.
Five Complete 1 ETH Shapes (each `originCount = 100`) compose into a Complete 5 ETH
(`originCount = 500 = units`). A mix (a Complete 1 ETH + a *direct* 1 ETH → `originCount 101 ≠ 200`)
is correctly **not** Complete.

**Complete is a live computed property, not a stored flag** — decompose a Complete and it is no
longer Complete; recompose the pieces (without redeeming any) and it is Complete again. Only the
**100 ETH Complete** (`originCount == 10,000`) can be blackened.

Because redemption deletes a token and its origins permanently, the lifetime supply of tokens that
can ever be Complete — and therefore Black — is bounded by cumulative mint history: origins spent on
redemption are gone and cannot be re-earned without new mints.

---

## 4. Decompose origin partition (worked)

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
- **Decompose (one → many):** the input token is **fully burned**; every output is a fresh
  sequential ID with a seed derived deterministically from the parent's (§9.3). Identity **ends** —
  you shattered the object, so no fragment inherits it.
- **Blacken:** in-place transform, same ID/seed/geometry inverted. Identity is **terminal**.

Do **not** copy Checks' on-chain composite-history storage: Checks is bounded (tiers only halve, so
≤ ~7 deep), but a Shapes Complete swallows up to 10,000 tokens. Lineage goes in **events**, not
storage.

**Marketplace consequence:** under a live listing, compose only moves backing **up** (seller's
risk, never a buyer rug), and decompose **burns** the input (stale listing auto-voids). The only
remaining mutation-rug vector is **blacken** (100 ETH → 0, in place) on an apex Complete. ERC-4906
`MetadataUpdate` speeds refresh of the token's own listing, but it does **not** invalidate standing
collection- or trait-level WETH offers and bids: a bidder on an apex Complete can receive a Black
Shape if the owner blackens and then accepts the bid. Any integrator that values a token by
`backingOf` must treat an owner-held apex Complete as mutable to zero.

---

## 6. Black Shape & ETH sacrifice

A 100 ETH Complete can be permanently transformed into a Black Shape by its owner. The token keeps
its ID, seed, geometry, and lineage; only the colors invert (`#000↔#fff`). After: not redeemable,
not recomposable, `backingOf` = 0, `sacrificedBacking` permanently reports 100 ETH. Black Shapes
remain transferable ERC721s (not soulbound).

**Sacrifice mechanism (decided): send 100 ETH to `0x…dEaD`.** A real, visible burn (contract
balance drops). `0xdEaD` has no code, so no reentrancy; the call is behind
checks-effects-interactions and `nonReentrant`. This is an *economic* burn (the ETH becomes
permanently unspendable) — Ethereum has no way to truly destroy arbitrary ETH, so an unspendable
address is the standard. The sacrifice is independently verifiable on-chain (`sacrificedBacking`
and the `Blackened` event, plus the balance decrease).

This adds a **third** ETH-out path to the contract (fee forward, redeem payout, blacken burn). It
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
address constant BURN             = 0x000000000000000000000000000000000000dEaD;

struct ShapeData {
    bytes32 seed;         // slot 1 (unchanged)
    uint8   denomIndex;   // slot 2
    uint32  originCount;  // slot 2  (max 10,000 << 2^32)
    bool    isBlack;      // slot 2
}
mapping(uint256 => ShapeData) private _shapes;

uint256 public redeemableBacking;   // renamed from totalBacking
uint256 public sacrificedBacking;   // monotonic; Black Shapes' burned backing
uint256 public blackCount;          // monotonic; number of Black Shapes
uint256 public totalSupply;         // live tokens, INCLUDING Black
uint256 public totalMinted;         // high-water ID (also bumped by decompose mints)

// unchanged: feeBps, feeRecipient (immutable); renderer, rendererLocked (owner, lockable); Ownable
```

**Per-token invariant:** `originCount <= backing / UNIT`. On-chain state is minimal: one integer of
provenance plus a bool. Lineage is in events; full ancestor trees are reconstructed off-chain.

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
`_mintBatch` sets `originCount = 1` per token; `redeemableBacking += backing`. Fee still 1% on new
ETH only. Seed derivation unchanged. Recompose functions take no `msg.value`, so **no fee** applies
to already-wrapped ETH.

### 9.2 compose — many → one, survivor keeps ID
```solidity
function compose(uint256 survivorId, uint256[] calldata burnIds)
    external nonReentrant returns (uint256 outId);
```
- **Checks:** caller owns `survivorId` and every `burnId`; none Black; `burnIds.length >= 1`; no id
  equals `survivorId`; `total = backing(survivor) + Σ backing(burnIds)` is a valid ladder denom.
- **Effects (no external calls — `_burn` triggers no callback):** burn each `burnId` (`delete`
  state, `_burn`), `totalSupply -= burnIds.length`; set `survivor.denomIndex = indexOf(total)` and
  `survivor.originCount += Σ originCount(burnIds)` (seed unchanged); `redeemableBacking` unchanged
  (backing conserved).
- **Duplicates:** a repeated id in `burnIds` reverts, because the second `_burn` targets a token
  that no longer exists (mirroring v1 `redeemBatch`), so the pre-summed backing cannot double-count.
- **Emit** `Composed(survivorId, burnIds, newDenomIndex, newOriginCount)` +
  `MetadataUpdate(survivorId)`. Returns `survivorId`.
- Backing only ever increases here → no buyer-rug risk.

### 9.3 decompose — one → many, input burned, all fresh IDs
```solidity
function decompose(uint256 tokenId, uint8[] calldata outDenoms)
    external nonReentrant returns (uint256[] memory newIds);
```
- **Checks:** caller owns `tokenId`; not Black; `outDenoms.length >= 2`;
  `Σ amountAt(outDenoms) == backing(tokenId)`. (Each output is a valid tier by construction; the
  `>= 2` + equal-sum constraints force every child strictly smaller than the parent.) Free-form:
  the breakdown is **not** tied to how the token was composed.
- **Effects:** burn `tokenId` (`delete`, `_burn`), `totalSupply -= 1`. For each `outDenoms[i]` in
  order: mint a fresh sequential id; child `i`'s seed is `keccak256(abi.encodePacked(parentSeed, i))`,
  where `parentSeed` is the burned token's seed and `i` is the index into `outDenoms` — no block
  data is read; `originCount_i = min(remaining, amountAt(i)/UNIT)`; `remaining -= originCount_i`;
  assert `remaining == 0`. `redeemableBacking` unchanged. All accounting is done **before** the
  `_safeMint` loop (receiver-callback safe, mirroring `_mintBatch`); `nonReentrant`.
- **Emit** `Decomposed(tokenId, newIds, outDenoms, originCounts)`, carrying the per-child origin
  partition so indexers do not re-implement the fill-in-order rule. Decompose outputs do **not**
  emit `ShapeMinted`: `ShapeMinted` is a strict origin-creation signal, and a split creates tokens
  without creating origins. Returns `newIds`.

**Seed derivation rationale.** Any rule that gives decompose outputs new block-entropy seeds would
permit seed re-rolling through decompose-then-compose loops, so re-rolling cannot be prevented, only
priced. Deriving child seeds deterministically from the parent seed fixes the full decompose tree of
every token at mint: owners navigate a possibility space set at mint rather than rolling per-block
entropy, and the frontend can preview decompose results exactly before executing. Siblings are
distinct (index-salted) yet derived from the parent, consistent with the "decompose ends identity"
decision. Mint seed derivation is unchanged.

### 9.4 blacken — apex Complete → Black, in place
```solidity
function blacken(uint256 tokenId) external nonReentrant;
```
- **Checks:** caller owns `tokenId`; `!isBlack`; `originCount == COMPLETE_ORIGINS && denomIndex == 8`.
- **Effects (CEI):** `isBlack = true`; `redeemableBacking -= 100 ether`;
  `sacrificedBacking += 100 ether`; `blackCount += 1`. **Interaction:**
  `BURN.call{value: 100 ether}("")`, require success. Token keeps ID/seed/denom/originCount.
- **Emit** `Blackened(tokenId, 100 ether)` + `MetadataUpdate(tokenId)`.

### 9.5 Guards on existing paths
`_burnForRedemption`: `require(!isBlack)`. compose/decompose reject Black inputs.

### 9.6 Views
`backingOf(id)` → 0 if Black else `amountAt(denomIndex)`; `originCountOf`, `isBlack`, `isComplete`
(`!Black && units > 1 && originCount == units`, `units = backing/UNIT`), `redeemableBacking`,
`sacrificedBacking`, `blackCount`. `tokenURI` passes `(seed, amount, id, originCount, isBlack)` to
the renderer.

---

## 10. Events

```solidity
event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint256 originCount);
event Decomposed(uint256 indexed tokenId, uint256[] newIds, uint8[] outDenoms, uint32[] originCounts);
event Blackened(uint256 indexed tokenId, uint256 sacrificedWei);
event MetadataUpdate(uint256 tokenId);          // ERC-4906
// existing: ShapeMinted (+ originCount=1), ShapeRedeemed, MintFeePaid, RendererUpdated, RendererLocked
```
`Decomposed` carries the per-child origin partition (`originCounts`) so indexers never re-implement
the fill-in-order rule. Decompose outputs do **not** emit `ShapeMinted`: that event is a strict
origin-creation signal, so token creation from a split is signalled by `Decomposed` alone. Advertise
ERC-4906 in `supportsInterface` (`0x49064906`).

---

## 11. Renderer & metadata

- The new ladder flows through `Denominations` (the renderer already reads it); grids unchanged.
- Interface expands: `renderSVG(seed, amount, inverted)`,
  `metadataJSON(seed, amount, id, originCount, inverted)`, and the matching `tokenURI`. The renderer
  is upgradeable, so this is a clean extension.
- Color: `(bg, fg) = inverted ? (#fff, #000) : (#000, #fff)`; replace the two hardcoded literals.
  Black Shape is the exact inverse (same seed, geometry, coordinates). Deterministic.
- New metadata traits: `Formation`, `Independent Origins`, `Origin Density` (`originCount / units`
  as a percentage), `Complete` (bool), `Black` (bool).
- The TypeScript canonical renderer is updated in lockstep; fixtures regenerated; byte-parity suite
  must stay green.

---

## 12. Tests

**New invariants (stateful fuzz, ci profile):**
1. Solvency: `balance >= redeemableBacking`.
2. Backing conservation: compose/decompose leave `redeemableBacking` unchanged; `redeemableBacking
   + sacrificedBacking` never exceeds cumulative real ETH in.
3. Origin conservation: `Σ live originCount (incl Black) == Σ mint-origins − Σ redeemed-origins`.
4. Capacity: every token `originCount <= backing/UNIT`.
5. Global capacity: `Σ originCount over live tokens <= Σ units of live backing`.
6. Sacrifice accounting: `sacrificedBacking == 100 ether * blackCount`.

**Unit / regression:**
- Forgery: mint 100 → decompose → recompose ⇒ `originCount == 1`, not Complete.
- Complete propagation: five Complete-1ETH compose ⇒ Complete 5 ETH.
- Complete excludes tier 0: a 0.01 token (`units == 1`) is "Direct", never "Complete".
- compose: ownership, Black-reject, invalid-sum reject, survivor ID/seed retained, backing up-only.
- decompose: sum check, `>= 2`, all-fresh IDs, origin partition (§4 cases), input burned.
- blacken: apex-gated, non-Complete reverts, double-blacken reverts, post-Black redeem/compose/
  decompose revert, `backingOf == 0`, `sacrificedBacking == 100`, balance −100 to 0xdEaD, transfers
  still work.
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
the existing "no batch cap" stance). Decompose fanout is similarly gas-bounded; exploding to 10,000
is possible but impractical and pointless.

Because recompose charges no fee, ID and seed generation is fee-free: one small mint funds unlimited
decompose/compose cycles, inflating `totalMinted` and event volume without bound (paying only gas).
This is economically harmless — no ETH or origins are created — but indexers must not assume
`totalMinted` approximates mint volume; it is a high-water ID counter, not a mint count.

---

## 14. Security notes & documentation sweep

- **ETH-out paths: three now** — fee forward, redeem payout (after burn), and blacken → 0xdEaD
  (fixed 100 ETH, fixed unspendable dest, apex-Complete + owner gated, CEI + `nonReentrant`). Add
  invariant coverage.
- Recompose has **zero external calls** (compose) / callback-safe minting (decompose), and backing
  is conserved by an explicit equality check ⇒ it cannot break solvency.
- Marketplace mutation is reduced to **blacken only** (compose up-only, decompose burns). ERC-4906
  speeds refresh of the token's own listing but does not cancel standing WETH offers/bids on an apex
  Complete (§5); an integrator valuing a token by `backingOf` must treat an owner-held apex Complete
  as mutable to zero.
- Mint-time seed grinding (the v1 SPEC.md D3e residual, one attempt per block) now selects an entire
  deterministic decompose tree rather than a single seed. Accepted for the same reason: seeds have
  no economic effect, since redemption value is set by denomination alone.
- `0xdEaD` is an economic burn (unspendable); Ethereum cannot truly destroy arbitrary ETH.

**Adversarial checklist covered:** reserve insolvency (conservation), rounding (all denoms exact wei
multiples), provenance forgery (origin-*count* conservation; the denominational claim is not made —
see §3), duplicate-origin accounting (conservation; duplicate `burnIds` revert), split-recombine
(conservation), token-ID manipulation (caller-named survivor, own tokens only), reentrancy
(nonReentrant + CEI + compose has no calls), malicious receivers (accounting before mint),
large-batch griefing (self-inflicted only), gas DoS (no third-party forcing), overflow (uint32 vs
10,000; uint256 sums), event ambiguity (explicit lineage events), blacken twice (state flag), redeem
after blacken (guard), recompose Black (guard), burned-ETH-as-backing (sacrificed excluded from
redeemable), forced ETH (inert surplus, unchanged), fee/reserve interaction (fee only on new ETH),
apex Complete without 10,000 mints (impossible — `originCount == 10,000` requires 10,000 mints by
conservation; density concentration cannot lower this).

**Documentation stale after v2 ships (sweep before deploy):**
- `Shapes.sol` contract header — the "exactly one code path that moves ETH out" claim (now three).
- `SECURITY.md` — the "only two value-bearing CALLs" table row (now three).
- `SPEC.md` — D3e, rewritten per change set 1 (deterministic decompose seeds; grinding now selects a
  full tree, not a single seed).
- `README.md` — "lower ID means minted earlier" no longer holds: decompose outputs receive fresh
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
3. **`compose` + `decompose`** — no ETH movement, conservation asserts, ERC-4906, events. Highest
   scrutiny: CEI, `nonReentrant`, invariants + fuzz, forgery test.
4. **Accounting split + `blacken`** — `redeemableBacking`/`sacrificedBacking`, 0xdEaD sacrifice,
   Black guards, updated solvency invariant + SECURITY.md.
5. **Renderer** — inversion + provenance traits, TS lockstep, parity, metadata tests.
6. **Frontend** — multi-tx compose orchestration, provenance UI, Complete/Black flows.

---

## 17. Locked decisions

| Topic | Decision |
|---|---|
| Compose identity | Caller-named survivor keeps ID/seed, grows to summed denom; other inputs burn. |
| Decompose identity | Input fully burned; all outputs are fresh IDs. |
| Blacken identity | In-place transform (same ID/seed/geometry, inverted). |
| Metadata refresh | ERC-4906 `MetadataUpdate` on every mutation. |
| Provenance | One `uint originCount`, conserved; lineage in events; trees off-chain. |
| Complete | `originCount == units && units > 1` (tier 0 excluded); "Complete" is the trait name. |
| Blacken gate | Apex only (`originCount == 10,000 @ 100 ETH`). |
| ETH sacrifice | Send 100 ETH to `0x…dEaD`. |
| Black transferability | Transferable (not soulbound). |
| Composition freedom | Multi-tier allowed to any valid ladder denom; frontend defaults to ladder steps. |
| Per-call caps | None; frontend chunks; gas is the limit. |
| Decompose freedom | Free-form (`uint8[] outDenoms` summing to backing); not tied to composition history. |
| Decompose seeds | `keccak256(parentSeed, i)`, deterministic; full tree fixed at mint; previewable off-chain. |
| Origin partition | Fill outputs in listed order, capacity-capped (cosmetic; total conserved). |
| Origin density | Trait `originCount / units` as a percentage (replaces Origin Denomination). |
| Ladder | `0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100` (`0.05` replaces `25`). |

---

## 18. Open questions for a reviewer

1. **Resolved.** Origin-*count* conservation holds; the global sum changes only on mint/redeem. The
   earlier denominational claim (that Complete proves all-0.01 origins) was invalid and has been
   removed (§3). Remaining ask: confirm no compose/decompose sequence increases the global count.
2. **Resolved.** The decompose origin partition is forgery-safe (the total is always conserved) and
   owner-controlled. Origin-density concentration is inherent to integer conservation and
   acknowledged in §3; it is economically irrational, not preventable by any partition rule.
3. **Decided** (§17): 0xdEaD sacrifice, accepting the third ETH-out path for on-chain visibility.
4. **Decided** (§14 caveat): in-place blacken can rug standing WETH bids on an apex Complete;
   documented, and ERC-4906 does not cancel offers.
5. **Confirmed fine.** `uint32 originCount` (max 10,000) + `uint8 denomIndex` + `bool isBlack` pack
   into one slot with headroom; `uint256` backing sums stay far below overflow at any bounded scale.

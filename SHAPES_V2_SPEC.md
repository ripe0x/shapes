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

Store **one number per token: `originCount`** = the number of independent *direct mints* whose ETH
is contained in this Shape.

Rules:
- **Direct mint** → each new Shape gets `originCount = 1`.
- **Compose** N→1 → `output.originCount = Σ inputs`.
- **Decompose** 1→k → partition the parent's count among children (Σ children = parent), each child
  capped at its capacity `childBacking / 0.01`.

Origins are **conserved** under compose/decompose and are **only created by minting new ETH**.

**Why this is forgery-proof.** Mint one 100 ETH Shape (`originCount = 1`), decompose it to
10,000 × 0.01, recombine → the count is still **1**, never 10,000. You cannot manufacture origins;
the global sum of all `originCount` equals (direct mints) − (origins redeemed), and no operation
increases it except a fresh mint of new ETH.

**Everything the collectible needs derives from `(backing, originCount, isBlack)`:**
- **Formation:** `isBlack ? "Black" : originCount == backing/0.01 ? "Complete" : originCount == 1 ?
  "Direct" : "Composed"`.
- **Independent origins:** `originCount`.
- **Origin denomination** (display only): `backing / originCount` if it equals a valid tier, else
  "Mixed".
- **Complete** (canonical, on-chain): `originCount == backing / 0.01`.

**Fee neutrality falls out:** building a top Shape from 10,000 × 0.01 pays the same total fee as
minting it directly (10,000 × 1% of 0.01 = 1% of 100 ETH). No fee arbitrage between paths.

---

## 3. Complete, in detail

**Complete = `originCount == backing / 0.01`** (its maximum possible origin count), at **every**
tier. It means "every unit of my backing entered the system as an independent 0.01 ETH mint."

**Why the arithmetic forces it:** every origin is a direct mint of at least 0.01 ETH. If a Shape
holds `backing/0.01` origins summing to exactly `backing`, then each origin must be exactly 0.01
(0.01 is the floor; there is no room for any origin to be larger). So `originCount == backing/0.01`
provably means all-0.01 origins — at any size.

**It propagates upward:** composing all-Complete pieces always yields a Complete, because
`Σ(pieceBacking/0.01) = (Σ pieceBacking)/0.01 = outBacking/0.01`. Five Complete 1 ETH Shapes
(each `originCount = 100`) compose into a Complete 5 ETH (`originCount = 500 = 5/0.01`). A mix
(a Complete 1 ETH + a *direct* 1 ETH = `originCount 101 ≠ 200`) is correctly **not** Complete.

Examples across tiers: Complete 0.05 → 5 origins; 0.1 → 10; 1 ETH → 100; 100 ETH → 10,000 (the
apex). **Complete is a live computed property, not a stored flag** — decompose a Complete and it is
no longer Complete; recompose the pieces (without redeeming any) and it is Complete again.

Only the **100 ETH Complete** (`originCount == 10,000`) can be blackened.

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
  sequential ID with a fresh seed. Identity **ends** — you shattered the object, so no fragment
  inherits it.
- **Blacken:** in-place transform, same ID/seed/geometry inverted. Identity is **terminal**.

Do **not** copy Checks' on-chain composite-history storage: Checks is bounded (tiers only halve, so
≤ ~7 deep), but a Shapes Complete swallows up to 10,000 tokens. Lineage goes in **events**, not
storage.

**Marketplace consequence (positive):** under a live listing, compose only moves backing **up**
(seller's risk, never a buyer rug), and decompose **burns** the input (stale listing auto-voids).
The only remaining mutation-rug vector is **blacken** (100 ETH → 0, in place) — a rare, deliberate
act on an apex Complete. Mitigated by ERC-4906 `MetadataUpdate` events and documentation.

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
- **Effects:** burn `tokenId` (`delete`, `_burn`), `totalSupply -= 1`. Derive a fresh seed root
  from block data + first new id. For each `outDenoms[i]` in order: mint a fresh sequential id with
  a fresh seed; `originCount_i = min(remaining, amountAt(i)/UNIT)`; `remaining -= originCount_i`;
  assert `remaining == 0`. `redeemableBacking` unchanged. All accounting is done **before** the
  `_safeMint` loop (receiver-callback safe, mirroring `_mintBatch`); `nonReentrant`.
- **Emit** `Decomposed(tokenId, newIds, outDenoms)`. Returns `newIds`.

### 9.4 blacken — apex Complete → Black, in place
```solidity
function blacken(uint256 tokenId) external nonReentrant;
```
- **Checks:** caller owns `tokenId`; `!isBlack`; `originCount == COMPLETE_ORIGINS && denomIndex == 8`.
- **Effects (CEI):** `isBlack = true`; `redeemableBacking -= 100 ether`;
  `sacrificedBacking += 100 ether`. **Interaction:** `BURN.call{value: 100 ether}("")`, require
  success. Token keeps ID/seed/denom/originCount.
- **Emit** `Blackened(tokenId, 100 ether)` + `MetadataUpdate(tokenId)`.

### 9.5 Guards on existing paths
`_burnForRedemption`: `require(!isBlack)`. compose/decompose reject Black inputs.

### 9.6 Views
`backingOf(id)` → 0 if Black else `amountAt(denomIndex)`; `originCountOf`, `isBlack`, `isComplete`
(`!Black && originCount == backing/UNIT`), `redeemableBacking`, `sacrificedBacking`. `tokenURI`
passes `(seed, amount, id, originCount, isBlack)` to the renderer.

---

## 10. Events

```solidity
event Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint256 originCount);
event Decomposed(uint256 indexed tokenId, uint256[] newIds, uint8[] outDenoms);
event Blackened(uint256 indexed tokenId, uint256 sacrificedWei);
event MetadataUpdate(uint256 tokenId);          // ERC-4906
// existing: ShapeMinted (+ originCount=1), ShapeRedeemed, MintFeePaid, RendererUpdated, RendererLocked
```
Advertise ERC-4906 in `supportsInterface` (`0x49064906`).

---

## 11. Renderer & metadata

- The new ladder flows through `Denominations` (the renderer already reads it); grids unchanged.
- Interface expands: `renderSVG(seed, amount, inverted)`,
  `metadataJSON(seed, amount, id, originCount, inverted)`, and the matching `tokenURI`. The renderer
  is upgradeable, so this is a clean extension.
- Color: `(bg, fg) = inverted ? (#fff, #000) : (#000, #fff)`; replace the two hardcoded literals.
  Black Shape is the exact inverse (same seed, geometry, coordinates). Deterministic.
- New metadata traits: `Formation`, `Independent Origins`, `Origin Denomination` (or "Mixed"),
  `Complete` (bool), `Black` (bool).
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

**Unit / regression:**
- Forgery: mint 100 → decompose → recompose ⇒ `originCount == 1`, not Complete.
- Complete propagation: five Complete-1ETH compose ⇒ Complete 5 ETH.
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

---

## 14. Security notes (SECURITY.md deltas)

- **ETH-out paths: three now** — fee forward, redeem payout (after burn), and blacken → 0xdEaD
  (fixed 100 ETH, fixed unspendable dest, apex-Complete + owner gated, CEI + `nonReentrant`). Add
  invariant coverage.
- Recompose has **zero external calls** (compose) / callback-safe minting (decompose), and backing
  is conserved by an explicit equality check ⇒ it cannot break solvency.
- Marketplace mutation is reduced to **blacken only** (compose up-only, decompose burns). ERC-4906
  + a documented buyer-beware caveat.
- `0xdEaD` is an economic burn (unspendable); Ethereum cannot truly destroy arbitrary ETH.

**Adversarial checklist covered:** reserve insolvency (conservation), rounding (all denoms exact wei
multiples), provenance forgery (origin conservation), duplicate-origin accounting (conservation),
split-recombine (conservation), token-ID manipulation (caller-named survivor, own tokens only),
reentrancy (nonReentrant + CEI + compose has no calls), malicious receivers (accounting before
mint), large-batch griefing (self-inflicted only), gas DoS (no third-party forcing), overflow
(uint32 vs 10,000; uint256 sums), event ambiguity (explicit lineage events), blacken twice
(state flag), redeem after blacken (guard), recompose Black (guard), burned-ETH-as-backing
(sacrificed excluded from redeemable), forced ETH (inert surplus, unchanged), fee/reserve
interaction (fee only on new ETH), manufacturing Complete without 10,000 genuine origins (impossible
by conservation).

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
| Complete | `originCount == backing/0.01`, at every tier; "Complete" is the trait name. |
| Blacken gate | Apex only (`originCount == 10,000 @ 100 ETH`). |
| ETH sacrifice | Send 100 ETH to `0x…dEaD`. |
| Black transferability | Transferable (not soulbound). |
| Composition freedom | Multi-tier allowed to any valid ladder denom; frontend defaults to ladder steps. |
| Per-call caps | None; frontend chunks; gas is the limit. |
| Decompose freedom | Free-form (`uint8[] outDenoms` summing to backing); not tied to composition history. |
| Origin partition | Fill outputs in listed order, capacity-capped (cosmetic; total conserved). |
| Mixed origins | Allowed; display "Mixed" when `backing/originCount` isn't a clean tier. |
| Ladder | `0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100` (`0.05` replaces `25`). |

---

## 18. Open questions for a reviewer

1. Is the origin-conservation model airtight against every forgery, including partial
   compose/decompose sequences and cross-token interactions? (We believe yes: the global origin sum
   changes only on mint/redeem.)
2. Is the decompose origin partition (fill-in-order, capacity-capped) acceptable as purely cosmetic,
   or does any observable rule create an incentive to game which child carries provenance?
3. Is the 0xdEaD sacrifice preferable to an internal accounting sacrifice given it adds a third
   ETH-out path? (Owner chose 0xdEaD for optics.)
4. Any marketplace/indexer failure mode from in-place blacken beyond the ERC-4906-mitigated
   listing race?
5. Any packing/overflow concern with `uint32 originCount` + `uint8 denomIndex` + `bool isBlack` in
   one slot, or with `uint256` backing sums at extreme (but bounded) scales?

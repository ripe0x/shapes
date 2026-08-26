# Ink Genes — Draft Spec (v0.1, for discussion)

Status: implemented; design rationale preserved as written. Current project status:
project/STATE.md. Strawman numbers are marked ⚙ (tunable before freeze, immutable
after). Reference: Checks – VV Originals (`0x036721e5A769Cc48B3189EFbb9CCe4471E8A48B1`),
whose composite-gene design this adapts.

## Design goals

1. Entropy enters ONCE, at mint. Nothing downstream rolls dice.
2. Every downstream outcome is a pure function of participating seeds — previewable
   on-chain via `simulate*` views before committing.
3. Each attempt consumes something real: composed-away seeds die forever; new entropy
   costs mint fees. Gas alone never buys a reroll.
4. Rare traits travel through lineage by ODDS, not by perfection of every input.
5. The game is strategic pairing and inventory, not botted grinding.
6. Zero floating point. All math is integer/WAD, portable to the canonical TS renderer
   and `ShapeRenderer.sol` under the existing parity strategy.

## 1. The gene

One `uint8 inkGene` per token, seven states:

| gene | name   | rendered solidProbability (WAD) |
|-----:|--------|--------------------------------:|
| 0    | Void   | 0%   |
| 1    | Faint  | 15%  |
| 2    | Sparse | 35%  |
| 3    | Murk   | 50%  |
| 4    | Dense  | 65%  |
| 5    | Rich   | 85%  |
| 6    | Solid  | 100% |

⚙ The seven probability values. The seven-step ladder itself is load-bearing (step
distances define "toward"), the mapping to percentages is cosmetic.

Rendering: the gene REPLACES the seed's card-level fill draw. The renderer still consumes
that draw (D5: streams never desync), it just ignores the value. `isBlack` overrides
everything, as today.

Storage: packs into `ShapeData` slot 2 beside `denomIndex` / `originCount` / `isBlack`.

## 2. Mint — where dice live

Gene is a pure function of the token's seed, assigned at mint.

**0.01 (dust) — the full lottery** ⚙:

| Void | Faint | Sparse | Murk | Dense | Rich | Solid |
|-----:|------:|-------:|-----:|------:|-----:|------:|
| 3%   | 7%    | 15%    | 50%  | 15%   | 7%   | 3%    |

**All higher direct mints — the narrow band** ⚙:

| Sparse | Murk | Dense |
|-------:|-----:|------:|
| 20%    | 60%  | 20%   |

Why the split: extremes (Void, Faint, Rich, Solid) enter the population ONLY at 0.01.
A direct 100 can never roll Solid, so mint-redeem reroll shopping at scale caps out at
Dense — which lineage reaches trivially anyway. Every mint still gets a reveal moment;
the summits stay lineage-only. (This replaces the rejected "fixed 59%" rule: bought scale
isn't blank and isn't lucky — it's ordinary.)

## 3. Compose — the inheritance function

`compose(survivorId, burnIds)` today: survivor keeps its seed, burns die, total backing
must equal a supported denomination. The gene rule layers on top; nothing about ETH,
backing, or originCount changes.

### Randomizer (order-invariant, role-aware)

```
burnFold = seed(b₁) ^ seed(b₂) ^ … ^ seed(bₙ)        // XOR: calldata order is irrelevant
R        = keccak256(survivorSeed, burnFold, newIndex)
```

Reordering `burnIds` MUST NOT change the outcome — otherwise argument order becomes a
free reroll dimension. XOR-fold guarantees this. The survivor's seed is kept separate
because choosing the survivor is a deliberate, finite strategic choice (Checks'
"Burner's Choice").

**Why survivor choice matters but burn order doesn't** (decision record, contested):
Checks' `swap` flag is real gameplay — but it's a trade-off: it decides which token ID,
seed, and art survive forward. Our survivor choice preserves exactly that game (a 5-dust
compose has 5 explorable outcomes, each keeping a different identity). Burn order is
different: Checks never had it (strictly pairwise composites), and it trades nothing —
it would be a free reroll knob (5-dust: 24 orderings ⇒ ~99.5% chance some ordering
rescues at p=20%; mega-composes: factorial). Principle: every player choice must trade
something real — tokens acquired cost ETH, burns cost seeds, survivor costs the
alternative identity; calldata order costs nothing, so it must not matter.

Note for tuning (§8): survivor choice already multiplies effective rescue odds
(~n+1 shots per candidate set). The Monte Carlo must model players exploiting this, or
published odds will overstate difficulty.

### Pool statistics (computed once per compose)

Over the multiset {survivor + all burns}, weighted by units (0.01-multiples of backing):

- `best`   = max gene present
- `worst`  = min gene present
- `center` = units-weighted mean gene, integer-rounded (Checks' `avg` trick, widened)

A 50 outweighs a dust card 5000:1 in `center`. `best`/`worst` are unweighted — one dust
card CAN carry a Solid gene into a huge composition. That asymmetry is the game.

### The per-tier walk (tier-jump handling)

Let `T = newIndex − survivorIndex` (tiers crossed; a 10,000-dust → 100 compose has T = 8).
Start from `g = survivorGene`. For each tier `k = 1..T`:

```
roll = keccak256(R, k) as uniform [0, 100)
if roll < 70:  g steps one toward center     // murk pulls          ⚙ 70%
elif roll < 90: g steps one toward best      // rescue              ⚙ 20%
else:           g steps one toward worst     // slip                ⚙ 10%
("toward" moves at most one ladder step; already there → stays)
```

Final `g` is the composed token's gene.

Properties worth stating:

- **Homogeneous is deterministic.** All-Solid inputs → center = best = worst = Solid →
  the result is Solid with certainty, any T. Pure in, pure out — no attrition tax on
  honest purity. Same for any uniform pool.
- **Mixed is a gauntlet.** Every tier crossed is one roll. A single-tx mega-compose
  (T = 8) faces the same eight rolls a step-by-step climb does — jumping tiers saves gas,
  never risk.
- **Rescue is real but bounded.** A lone Solid dust in a murky pool survives a tier with
  20% odds — and because outcomes are deterministic per candidate SET, players search
  pairings off-chain and only execute winners. The cost of "odds" is therefore inventory:
  ~1/p distinct candidate partner-sets per tier. At low tiers that's spare dust; at
  50 → 100 it's owning alternative large tokens. Difficulty at the top is measured in
  temporarily-parked (fully redeemable) ETH and combinatorial legwork, not burned money.
  For a wrapper protocol, "the endgame is parking more ETH" is the right kind of
  difficulty.

## 4. Split and decompose

- **Split:** every child inherits the parent's gene, unchanged. Splitting the liquid
  doesn't change the dye.
- **Decompose:** the survivor and revived inputs recover the genes captured by the compose record.
- **No reroll machine:** child seeds derive from the parent seed, so split → compose
  explores a FINITE deterministic tree. Recomposing a token's own children (uniform pool)
  returns the same gene with certainty. Fresh outcomes require fresh seeds, and fresh
  seeds cost mint fees.

## 5. Simulation views (ship these — they're half the elegance)

```solidity
function simulateCompose(uint256 survivorId, uint256[] calldata burnIds)
    external view returns (uint8 inkGene);
function simulateDecompose(uint256 tokenId, uint8[] calldata outDenoms)
    external view returns (uint8 childGene);   // trivially = parent gene, but symmetric
```

Checks shipped `simulateComposite` / `simulateCompositeSVG` and the community built its
meta-game on them. Previewability is a feature, not a leak: it converts gambling into
strategy, and strategy into a market for well-paired tokens.

## 6. Companion recommendation: epoch commit-reveal for seeds

Today (D3e) seeds are grindable at ~1 attempt/block via revert-if-unwanted — accepted
when traits were cosmetic. Genes raise the stakes: a revert-grinder pays only gas per
dust lottery ticket, honest minters pay fees.

Checks' fix, verified in source: mint finalizes immediately; the epoch's randomness is
`keccak(blockhash(commitBlock + 50), prevrandao)`, revealed later by anyone. The token
exists before its randomness does — there is nothing to observe-and-revert. Adopting
this makes every lottery ticket fee-priced and closes the accepted-risk note for good.
Costs: a ~50-block unrevealed window (an Art Blocks-style reveal moment — arguably a
feature) and a modest contract-surface addition. Decide separately from the gene rule;
the gene rule works either way.

## 7. Exploit checklist

| Attack | Answer |
|---|---|
| Mint-redeem reroll at scale | Higher mints roll the narrow band; extremes are dust-only |
| Revert-grind dust jackpots | §6 epoch reveal (recommended); else unchanged accepted risk |
| Reorder burnIds to reroll | XOR-fold randomizer is order-invariant |
| Decompose→recompose reroll | Child seeds deterministic; uniform pools compose deterministically |
| Tier-jump to skip gauntlet | Per-tier walk: T rolls regardless of path |
| Off-chain pairing search | Embraced. Bounded by inventory (~1/p partner-sets per tier), which is parked ETH + fees |

## 8. What must be tuned before freeze (immutable after)

1. Mint distributions (dust pyramid, narrow band) — ⚙
2. Walk odds (70/20/10) and whether "toward best" should be rarer at high tiers — ⚙
3. Gene → probability rendering table — ⚙
4. Target difficulty: pick a headline ("a Solid 100 should take roughly X ETH parked,
   Y dust mints, Z weeks of play") and Monte-Carlo the knobs against it in `preview/`
   (the fixture harness already exists). Tuning is a simulation task, not a taste task.

## 9. Interactions with existing decisions

- D3d/D3e: unchanged; gene derivation uses the token seed, never batch-correlated inputs.
- D5: renderer consumes the legacy fill draw and discards it — streams stay aligned.
- `sacrifice`: gate unchanged (apex + originCount = 10,000). Open flavor question: should
  the Black record the gene it died with (a Solid-gened Black vs a Void-gened Black), even
  though `isBlack` overrides rendering? Zero protocol cost, pure lore. — open
- Parity: gene logic is small pure integer functions; port to TS canonical + fixtures
  same as everything else.

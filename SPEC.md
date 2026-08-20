# Shapes — implementation plan and resolved rendering decisions

This document is the bridge between two authorities:

- **The Claude Design project "Shapes Explorations", Round 03** — authoritative for
  visual language, geometry, typography and composition.
- **The protocol specification** — authoritative for contract behaviour,
  denominations, economics, security and architecture.

Round 03's generative logic is fully self-contained in the inline
`<script type="text/x-dc">` block of `Shapes Explorations.dc.html` (`rng`, `GRAM`,
`FIELD`, `geom`, `OPT`, `compose`, `grammarCard`). `support.js` is the Design
Compiler runtime harness (React, `DCLogic`, `sc-for`) and has no bearing on the
rendering mathematics.

Where the two authorities disagree, the disagreement is recorded below with the
decision taken and the reason. Nothing was resolved silently.

---

## Part 1 — Implementation plan

| # | Stage | Output |
|---|---|---|
| 1 | Canonical renderer in TypeScript, exact integer arithmetic only | `preview/src/canonical/` |
| 2 | Fidelity check against the Round 03 float64 source | `preview/scripts/verifyStream.ts` |
| 3 | Preview harness: ladder, batch, controls, collisions, distributions, inspect, export | `preview/src/app/` |
| 4 | 500-sample collision + distribution sweep, all nine denominations | `preview/scripts/collisionSweep.ts` |
| 5 | Fixture generation | `preview/scripts/genFixtures.ts` → `test/fixtures/` |
| 6 | Solidity port of the canonical renderer | `src/ShapeRenderer.sol`, `src/lib/` |
| 7 | ERC721 + reserve | `src/Shapes.sol` |
| 8 | Byte-parity tests, unit tests, fuzz tests, stateful solvency invariant | `test/` |
| 9 | Deployment script and local Anvil run | `script/DeployShapes.s.sol` |
| 10 | Adversarial security review | `SECURITY.md` |

The ordering matters in one respect: **the renderer is written in TypeScript
first and ported to Solidity second.** The TypeScript is the specification; the
Solidity is the port. Byte parity is then a property that can be tested rather
than a coincidence to be chased.

---

## Part 2 — The parity strategy

Byte-identical output between TypeScript and Solidity is an acceptance
requirement. Achieving it by "being careful with floats" is not achievable.
The approach taken instead:

**The canonical TypeScript renderer contains no floating point at all.** Every
geometric quantity is a `bigint` in WAD units (1e18 = 1.0). Every operation is
an integer operation that floors. The Solidity renderer performs the identical
operations in the identical order on `uint256`. Parity is therefore structural,
not empirical — the two implementations cannot drift, because there is nothing
to drift.

The only place a number becomes text is the canonical decimal formatter
(`fmt`), specified in D2 below.

This decision has a cost: the committed renderer is not *bit*-identical to the
Round 03 page, which does its arithmetic in float64. The measured difference is
**at most 2.8e-14 user units** across 57,000 modules spanning every denomination
and 600 seeds — roughly one ten-billionth of a pixel. The kind, solid and
rotation decisions match the original in **100%** of those 57,000 modules.

---

## Part 3 — Decisions the specification left open

### D1. Fixed-point representation

- Scale: **WAD, 1e18**.
- `mulWad(a, b) = (a * b) / 1e18`, flooring.
- Division by a small integer count is plain integer division, flooring.
- All geometric values are non-negative, so flooring and truncation coincide.

Rationale: 1e18 is the EVM's native fixed-point convention, gives 18 significant
fractional digits against a canvas only 350 units tall, and leaves ~59 orders of
magnitude of headroom before `uint256` overflow.

### D2. Canonical decimal formatter

`fmt(v)` emits a WAD value with **at most 6 fractional digits**, rounding **half
away from zero**, with trailing fractional zeros stripped and no trailing
decimal point. `-0` is never emitted.

**Why 6 and not 3.** At 100 ETH a card is a single module. A *solid* module
there is fully determined by its kind, rotation and one radius, so radius
precision is the only thing separating two otherwise identical 100 ETH cards.
The radius range at 100 ETH is about 7.3 user units wide. At 3 decimals that is
7,300 distinct radii and a 500-sample batch would be expected to produce ~17
exact geometry collisions. At 6 decimals it is 7.3 million buckets and the
expectation falls to ~0.017. Measured collision counts are in
`preview/scripts/collisionSweep.ts` output.

### D3. The random stream

Round 03 **does** contain an explicit deterministic stream, so per the
specification it is preserved rather than replaced with a keccak counter:

```
a = (seed * 1831565813 + 0x6D2B79F5) mod 2^32
next():
  a = (a + 0x6D2B79F5) mod 2^32
  x = imul32(a ^ (a >>> 15), 1 | a)
  x = ((x + imul32(x ^ (x >>> 7), 61 | x)) mod 2^32) ^ x
  return ((x ^ (x >>> 14)) mod 2^32) / 2^32
```

Two things the JavaScript original leaves undefined are pinned here:

**D3a. Seeding is exact 32-bit integer arithmetic.** In JavaScript
`seed * 1831565813` is a float64 multiply. Above roughly `seed = 4,918,296`
(2^53 / 1831565813) the product exceeds `Number.MAX_SAFE_INTEGER` and silently
loses low bits, so the original is *not* reproducible for large seeds. The
canonical definition is exact integer arithmetic mod 2^32. Verified identical to
the original for every seed in `0..200,000`, which covers the entire seed range
the design page uses (1007..6596) with a factor of 30 to spare.

**D3b. Draws are consumed as exact `uint32`s.** The original returns
`u32 / 2^32` as a float and then compares and floors it. The canonical
implementation keeps the `uint32`:

- `floor(rand() * n)` → `(u32 * n) / 2^32`
- `rand() > t` → `u32 * 1e18 > t_wad * 2^32`
- a WAD fraction where one is needed → `(u32 * 1e18) / 2^32`

These agree with the float forms except on a measure-zero set: `rand() > 0.3`
differs from the exact comparison only when `u32/2^32` lands between float64's
`0.3` (0.29999999999999998889…) and exact `0.3`, an interval containing an
integer `u32` with probability about 5e-8. The exact comparison is canonical.

**D3c. Stream seeding from the stored `bytes32`.** The token stores a full
`bytes32` seed. The Round 03 stream has a 32-bit state, so the renderer consumes
`uint32(uint256(seed))`. This is a property of the preserved algorithm, not of
the token. Consequence, stated plainly: **the artwork space is 2^32 compositions
per denomination.** For a collection of *n* tokens at one denomination the
expected number of exactly duplicated compositions is `n² / 2^33` — 0.012 at
10,000 tokens, 1.2 at 100,000. The 500-sample acceptance test expects 3e-5. If
you would rather have the full 256-bit seed drive the artwork, the preview
exposes a `keccak256` stream alternative side by side; it must be chosen before
the renderer is permanently locked.

**D3d. The stream is counter-based, and every seed is a window into one shared
sequence.** The seeding multiplier and the per-draw increment are the *same*
constant, `0x6D2B79F5 = 1831565813`, so the state reduces to

```
a(seed, draw) = 0x6D2B79F5 * (seed + draw + 1)   (mod 2^32)
```

The consequences are worth stating plainly, because they are easy to miss:

- Seeds `s` and `s + 1` produce *shifted* draw sequences, not independent ones.
  Their cards are visibly related.
- Rendering a batch from consecutive integer seeds does not sample the design
  space at all; it slides a window along a single sequence. The first version of
  the collision sweep did exactly this and produced meaningless distributions
  (270° rotations at 20.3% against an expected 25%, solid modules at 52.4%
  against an expected 56%) — an artefact of an effective sample size of ~2,000
  underlying draws rather than the 81,320 the counter claimed.
- This is inherent to the mulberry32 family and cannot be fixed by reseeding;
  only replacing the stream would remove it, and the specification says to
  preserve it.

On chain this is benign, because token seeds are keccak256 outputs whose low 32
bits are uniform: two tokens' windows overlap only by coincidence. For *n*
tokens the expected number of pairs whose windows overlap at all is about
`n² · 100 / 2^33` — roughly one pair at 10,000 tokens, and such a pair is
merely correlated, not identical.

The preview harness therefore derives its seeds as `keccak256(bytes32(index))`
by default, exactly as the contract does, so that what you are judging is the
real distribution. A `raw` seed mode is provided solely to reproduce the design
page's own cards.

**D3e. Seed entropy excludes everything the minter controls.** §9 suggests the seed root may
include the minter and the recipient. It must not, and the first implementation that did was
demonstrably attackable: because every other input is known before the transaction is sent, a
minter could enumerate candidate recipient addresses off chain, for free, until the artwork
came out the way they wanted. The adversarial review selected a specific 100 ETH composition
— a solid triangle at 270°, probability ≈ 3.5% — in **85 tries at zero cost**. At 50 and 100
ETH a card is one or two modules, so trait selection is effectively total.

The committed root is therefore:

```solidity
keccak256(abi.encodePacked(
    block.prevrandao, blockhash(block.number - 1), block.number,
    block.timestamp, block.chainid, address(this), firstTokenId
))
```

with `seed_i = keccak256(batchRoot, tokenId)`. Nothing caller-controlled appears.

This is the same construction Art Blocks uses for its own token hashes — its
`PseudorandomAtomic` primitive is
`keccak256(entropy, block.number, blockhash(block.number-1), timestamp, (timestamp % 200) + 1)`
— pseudorandom, atomic at mint, block-derived, no VRF, and likewise free of minter-controlled
inputs.

**The residual, stated plainly:** a minter can still grind by minting through a contract that
reverts unless the outcome suits them. That costs gas per attempt and yields one attempt per
block, so the ~3.5% trait above goes from 85 free tries to roughly 28 paid ones. Art Blocks
has the same residual and has addressed it at the minter layer rather than in the randomizer.
Shapes accepts it, because the seed has no economic effect: redemption value is set by
denomination alone, and every Shape of a given denomination redeems for exactly the same ETH
no matter what it looks like.

A commit-reveal seed was considered and rejected. The clean form — deriving the seed lazily
from a future `blockhash` — degrades after 256 blocks, so it requires a mandatory second
transaction within ~51 minutes and a token that is not fully formed at mint. That is a large
amount of machinery for a primitive whose §26 mandate is to stay extremely narrow, bought
against a property the reference implementation in this space does not have either.

**Split child seeds are deterministic, not block-derived.** A `split` mints its outputs
with `childSeed_i = keccak256(abi.encodePacked(parentSeed, i))`, where `i` is the output index.
No block value enters. The parent seed is already fixed and free of caller control (it was set
at the parent's own mint under the rule above), and the index is not a free parameter, so the
full split tree is determined the moment the parent exists. Using block entropy here would
instead grant one fresh re-roll per block: burn, observe the children, and if they are unwanted,
revert and retry next block. Deriving from the parent seed removes that grind entirely.

**Decompose reads no seed entropy at all.** `decompose` is the exact inverse of `compose`, not a
downward reshape like `split`. It pops the survivor's most-recent compose record and re-mints every
burned input under its **original id and its original stored seed** (the record captured them at
compose time), so no seed is derived and no block value enters. The survivor keeps its own id and
seed unchanged, as it did through the compose. Where `split` fixes a deterministic tree of *new*
child seeds, `decompose` simply restores seeds that already existed. See DECOMPOSE_SPEC.md.

### D4. Inset of outlined primitives — **specifications disagree**

Round 03's source applies the half-stroke inset to **circle, ring and half
circle only**. Square and triangle are drawn at their full optical size with the
stroke straddling the edge, so an outlined square's outer extent is `d + w`
while a solid square's is `d`.

The protocol specification §15 states the general rule: *"Inset outlined forms
by half the stroke weight so the stroke remains inside the intended footprint."*

**Decision: inset every outlined primitive (the general rule).**

Reasons: the `OPT` table exists specifically to make each primitive read at the
same visual weight in its cell, and the source's behaviour defeats that for two
of the five — an outlined square lands between 11% and 19% larger than a solid
one. The specification states the rule explicitly and generally. The difference
is most visible at 50 and 100 ETH, exactly where §16 demands optical care.

This is the one place the committed renderer intentionally departs from the
reference page. **The preview exposes `insetAll` as a toggle**, so the two can be
compared directly at every denomination; set it to `round-only` to reproduce the
page exactly.

### D5. Conditional draw consumption — **source is authoritative and stricter**

Round 03 evaluates `solid` and `rot` inside a JavaScript object literal with
ternaries:

```js
solid: kind === 'ring' ? false : r() > 0.3,
rot:   kind === 'triangle' || kind === 'half' ? Math.floor(r() * 4) * 90 : 0,
```

so the draws are **consumed conditionally**: a ring never draws for `solid`, and
circle/square/ring never draw for rotation. The written specification reads as
though all three draws always occur. Consuming unconditionally would
desynchronise the stream and change every subsequent cell on the card.

**Decision: conditional consumption, exactly as the source.** Per cell:

1. `kind` — always
2. `solid` — only when `kind != ring`
3. `rot` — only when `kind` is `triangle` or `half`

### D6. Triangle centring

The source's `tri(cx, cy, s)` produces
`cx,cy-h/2  cx+s/2,cy+h/2  cx-s/2,cy+h/2` with `h = 0.866 s` — the triangle's
**bounding box** is centred on the cell centre, not its centroid. Preserved.
`0.866` is used as an exact decimal constant, not `sqrt(3)/2`. Vertex order
apex → right → left is preserved so the emitted `points` string matches.

### D7. Half circle orientation

The specified path `M cx-r,cy A r,r 0 0 1 cx+r,cy Z` sweeps clockwise on screen
from the left point, so the filled half is the **upper** half at rotation 0. The
flat edge passes through the cell centre; the semicircle is therefore not
bounding-box centred, which is the source's behaviour and is preserved.

### D8. Rotation emission

`transform="rotate(deg cx cy)"` is emitted **only when `deg != 0`**. The source
emits `rotate(0 …)` for unrotated forms; suppressing it removes ~30 bytes per
module from onchain output with no visual change. Squares never rotate, per §16.

### D9. Typography — removed

**The committed card carries no type.** Black field, white marks, nothing else. The
denomination and the token number live in the metadata; the object itself does not declare
them. The artwork field is centred at the card's true centre, y 175, rather than the 169 that
existed only to balance against the type below it.

Consequences worth recording:

- `renderSVG` takes no `tokenId`. A Shape's artwork is a pure function of its seed and its
  denomination, and two tokens sharing both render byte-identically by design.
- With nothing on the card to distinguish them, the finite composition space of D15 bites
  harder: at 100 ETH, two Shapes drawing the same archetype are now indistinguishable as
  images, not merely similar. They remain distinct objects — distinct token ids, distinct
  seeds, distinct provenance — but nothing on the face says so.
- No fonts are referenced at all, so the last dependency on type the chain cannot guarantee is
  gone. The minimum card is 235 bytes.

The typographic variant remains available in the preview (`card type`) for comparison. It is a
preview override only; the Solidity renderer implements the text-free path alone. What follows
is the retired specification, kept because it records where the values came from.

#### Retired: the typographic variant

Values taken from the source, which matches the specification: `SHAPE` at
(22, 32) size 8 letter-spacing 3.4; the ETH label at (22, 322) size 11
letter-spacing 1.2; the token number at (228, 322) size 8, monospace, anchored
end. Two details the specification omits, taken from the source: the token
number's letter-spacing is **0.6**, and all three elements are `font-weight 500`.

Font families are name references, not embedded or fetched resources:
`'Helvetica Neue', Helvetica, Arial, sans-serif` and
`'IBM Plex Mono', ui-monospace, monospace`.

**`mix-blend-mode: difference` is dropped.** The source applies it so type
inverts over artwork. It provably never triggers here: the artwork field spans
y 54..284 at every denomination, while the two lower text baselines sit at
y 322 and the upper one's ink ends at y 32. The blend mode is dead weight in an
onchain document and is poorly supported by some SVG rasterisers.

**Token number format is `#` + the decimal token id, unpadded** (specification
§17's `#123`). The source pads its *seed* to four digits, but the card shows the
token number, which is contract state.

### D10. Module glyph mapping

The trait must reflect the same random stream that draws the artwork, so it is
derived from the composition rather than re-rolled. Glyphs are taken from the
Geometric Shapes block that Round 04 of the same exploration uses:

| kind | solid | outline |
|---|---|---|
| circle | ● | ○ |
| square | ■ | □ |
| triangle | ▲ ▶ ▼ ◀ | △ ▷ ▽ ◁ |
| ring | — | ◎ |
| half | ◓ ◑ ◒ ◐ | ◓ ◑ ◒ ◐ |

Triangle and half-circle glyph sets are indexed by rotation 0/90/180/270
clockwise. Half circles have no paired solid/outline glyphs in Unicode, so that
one bit is not represented; every other module state is distinguishable.

### D11. Metadata

`attributes` carries, in emission order: `ETH Value`, `Grid`, `Fill`, `Ink`, `Modules` (the glyph
sequence), `Module Count`, then the visual-rarity block `Primitive` / `Variety` / `Ink Tier`, then
the provenance block `Formation` / `Independent Origins` / `Origin Density` / `Complete` / `Black`,
and finally `Compose Depth`. Every `value` is a string, so no trait renders as a numeric range
filter. `ETH Value` is derived from the same denomination index as `backingOf`, so it cannot
disagree with the reserve. Full field-by-field reference in [METADATA.md](METADATA.md).

The four v2 additions are all **aesthetic**, carrying no economic weight (redemption stays
denomination-only, D15): `Primitive` is the dominant of the ten primitive kinds on the card (ties to
the lowest KIND index); `Variety` is the count of distinct kinds present (`"1"`..`"10"`); `Ink Tier`
bands the seven-state ink gene to `Mythic` (Void/Solid), `Rare` (Faint/Rich) or `Common` (the rest);
`Compose Depth` surfaces `Shapes.composeDepth(id)`, the reversible-compose stack depth (`0` at mint,
+1 per `compose`, −1 per matching `decompose`). `Compose Depth` is the one mutable-state input, the
last argument to `metadataJSON`/`tokenURI`; the other three derive from the card the renderer already
builds. The renderer stays byte-parity with the canonical TypeScript renderer. See TRAIT_SPEC.md.

Every string in the SVG, and every string in the JSON other than the `name` prefix and
`description`, comes from a fixed table or from `fmt`. Those two are owner-set copy, stored on
`Shapes` and passed into `metadataJSON`. They are written verbatim, but `Shapes.setTokenCopy`
and `setCollectionCopy` reject any value containing `"`, `\`, or a C0 control byte, and cap their
length, so owner copy cannot break or restructure the document. No other caller-controlled text
reaches either document.

### D13. Sizing: the painted extent is the controlled quantity

**This supersedes the optical size table and the inset rule of D4, and removes the `ring`
primitive. It is a deliberate departure from Round 03, made at the client's direction.**

Round 03 controls the *nominal* path size and lets the stroke add on top. Three problems follow
from that, all visible on a single card:

1. **`ring` ignored the card's stroke.** A ring is a circle with a hard-coded `0.22 x d` stroke
   while every other outlined mark used the card-level `wRatio`. On the same card a ring came
   out 1.27x to 2.15x heavier than the outlined circle beside it, with nothing in the system to
   explain the difference to a viewer. Fill is the only bit that separates a ring from a
   circle, and `solid` already carries it, so the primitive was redundant as well as
   inconsistent. **Removed. The vocabulary is circle, square, triangle, half circle.**
2. **Painted footprints drifted by primitive.** The optical table (0.88 to 1.06) plus the
   stroke plus a triangle's miter joins meant no two kinds reached the same distance from
   their cell centre, and an outlined mark reached differently from a solid one.
3. **Containment was an argument, not a guarantee** — 89.3% worst case with 11% headroom, and
   escapes as soon as anyone raised `fitBase` past 0.805.

The committed model inverts the relationship. The controlled quantity is the **painted
half-extent**: the distance from the cell centre to the furthest ink, stroke and miter joins
included. One target per card, `fill x cell/2`, and each footprint is solved backwards from it:

| primitive | solid | outlined |
|---|---|---|
| circle, square, half circle | `size = 2T` | `size = 2T − w` |
| triangle | `size = 2T` | `size = 2T − √3·w` |

The triangle's `√3` inverts the 60° miter overshoot derived below. `w` is one value per card,
`wRatio x 2T`, so every outlined mark on a token emits an identical `stroke-width`.

What this buys:

- **Every mark on a card paints to exactly the same extent**, whatever primitive it is and
  whether it is solid or outlined. Verified forwards over 57,000 modules: 0 off target.
- **Containment is exact by construction.** `fill` is capped at 1.0 and jitter is subtractive,
  so overflow is not merely unlikely, it is unrepresentable. 0 escapes over 57,000 modules.
- **Four parameters instead of eleven.** Gone: five optical multipliers, the ring stroke, the
  inset policy flag, and `fitBase`/`fitFloor`/`fitJitter` collapse to `fillMax`/`fillJitter`.

Committed: `fillMax = 0.83`, `fillJitter = 0.08`, so a card's ink lands between 75% and 83% of
the half-cell. 1.00 would be edge to edge, where adjacent solid squares would meet and read as
one block. Stroke: `wRatio` 0.14–0.17 of the painted width.

The cost, stated plainly: the optical table existed to make each primitive read at the same
*visual weight*, and a triangle inscribed in the same box as a circle carries less area and so
reads a little lighter. Bounding-box normalisation is geometric rather than optical. That is
the trade the client asked for, and the preview's `cell fill` slider makes it easy to revisit.

#### The miter derivation

A miter join at interior angle θ pushes the outer corner out by `(w/2) / sin(θ/2)` along the
bisector. A triangle's corners are 60°, so that is a **full stroke width**, not half of one.
Offsetting the outline outward by `w/2` produces a similar triangle whose side grows by `√3·w`:

| primitive | horizontal | up | down |
|---|---|---|---|
| circle, square | `size/2 + w/2` | same | same |
| half circle | `size/2 + w/2` | same | `(w/2)·√2` |
| triangle | `size/2 + (√3/2)·w` | `h/2 + w` | `h/2 + w/2` |

`testFuzz_EveryMarkPaintsToTheCardTarget` re-derives these forwards from the emitted geometry
and asserts they land back on `card.target` to within 32 wei — twelve orders of magnitude
tighter than the 1e-6 at which coordinates are rounded for output. `npm run verify` runs the
same check over 57,000 modules in TypeScript.

### D14. Fill is drawn per card, with exact extremes

A single global solid rate makes every card the same mixture, and the collection reads flat. So
the rate is itself a card-level draw, taken third, immediately after `fill` and `wRatio`:

```
r <  pureOutlineChance     ->  p = 0     every module outlined
r >= 1 - pureSolidChance   ->  p = 1     every module solid
otherwise                  ->  p remapped linearly onto [bandMin, bandMax]
```

Committed: **5% entirely outlined, 5% entirely solid, 90% drawn from 0.30–0.90**, giving a
collection that averages about 59% solid modules but where individual cards range from wholly
drawn to wholly filled.

**The extremes have to be exact**, or they are not extremes. That required flipping the
per-module test from `rand() > threshold` to `rand() < p`:

- with `> threshold`, a `p = 1` card would still produce one outlined mark roughly every 2^32
  draws, because the draw can be exactly zero;
- with `< p`, a draw lies in `[0, 1)`, so `p = 0` is never true and `p = 1` is always true.

`testFuzz_PureCardsAreActuallyPure` walks every module of any card that drew an extreme and
asserts there is no exception. This is a property of the solid *bit*: the arc and the diagonal
line are open strokes with no solid form (D15), so a pure-solid card that happens to carry one
still paints that stroke. The `Fill` metadata trait (`Solid` / `Outline` / `Mixed`) reports the
card's realized fill: a mark counts as filled only when its solid draw is set and its kind has a
solid form, so the arc and the line never count, all marks filled reads `Solid`, none reads
`Outline`, and any split reads `Mixed`. It is derived from the composition, never re-rolled, and
is independent of the ink gene (D17) rather than a restatement of it. See [METADATA.md](METADATA.md).

### D15. Vocabulary, and the finite composition space

**Ten primitives.** Eight are fillable — solid or outlined; two, the arc and the diagonal line,
are open strokes and are outlined only. Circle, square and diamond are rotation-invariant; the
rest take one of four rotations, except the line, which takes one of two. That is **52 distinct
module appearances**:

| primitive | rotations | fills | states |
|---|---|---|---|
| circle | 1 | 2 | 2 |
| square | 1 | 2 | 2 |
| triangle | 4 | 2 | 8 |
| half circle | 4 | 2 | 8 |
| quarter circle | 4 | 2 | 8 |
| diamond | 1 | 2 | 2 |
| half square | 4 | 2 | 8 |
| right triangle | 4 | 2 | 8 |
| arc | 4 | 1 (outline) | 4 |
| diagonal line | 2 | 1 (outline) | 2 |

The quarter circle is the only fillable form combining a hard right angle with an arc — circle
is pure curve, square pure right angles, triangle pure diagonals, half circle a curve cut
through the centre — and it continues the circle-division series the design source established.
The diamond is the square on its diagonal, the half square the rectangular twin of the half
circle, the right triangle the square cut on its diagonal. The arc is the quarter circle's
curved edge with the radii removed, and the line is the cell diagonal; both are open strokes, so
they have no solid form and appear on a card whatever its fill draw.

**The composition space is finite, and small at the top of the ladder.** Once size and stroke
became collection constants (D13, at the client's direction), nothing continuous remains in the
artwork. A card's appearance is fully determined by which of 52 states lands in each cell:

| band | modules | possible compositions | distinct in 500 mints |
|---|---|---|---|
| 0.01–1 ETH | 25–9 | astronomically many | 500 |
| 5 ETH | 6 | 1.9 × 10¹⁰ | 500 |
| 10 ETH | 4 | 7.3 × 10⁶ | 500 |
| 50 ETH | 2 | 2,704 | 423 |
| **100 ETH** | **1** | **52** | **52** |

**A 100 ETH Shape is one of fifty-two archetypes.** The fifty-third repeats. This is accepted
deliberately, not overlooked:

- It is a direct consequence of making size and stroke constant across the collection, which
  is what makes the collection read as one system.
- With type removed (D9) there is nothing on the card face to tell two same-archetype Shapes
  apart either. They are the same image.
- Expanding the vocabulary raises the count but does not remove the ceiling: six primitives gave
  30 archetypes, ten give 52. Reaching the thousands would need a vocabulary nobody would call
  restrained.
- The composition was never the only thing distinguishing a Shape. Each carries a unique token
  id, a unique `bytes32` seed, and its own provenance and history on chain. Two 100 ETH Shapes
  that draw the same archetype are the same *image*, not the same *object* — exactly as two
  prints from one plate are distinct objects. Since D9 removed the type, that distinction is
  entirely off-card.
- Conceptually it is not a bad fit. 100 ETH is the irreducible end of the ladder: one module,
  nothing left to vary. A finite set there reads as a suit rather than a failure.

Where it *would* matter is if trait rarity were meant to carry economic weight at the top of
the ladder. It is not: redemption value comes from denomination alone (D3e).

The 500-sample sweep in `preview/scripts/collisionSweep.ts` reports this per denomination on
every run, so it can never quietly drift.

### D16. Outlined marks with corners are even-odd rings, not strokes

**Amends the outlined column of D13's footprint table for triangle, right triangle, diamond,
half circle and quarter circle.**

D13 solved each outlined footprint backwards through its stroke's miter overshoot, sized for
the worst corner. The worst corner is not every corner: the allowance that kept a right
triangle's 45° miter tips on target left its flat legs about `0.7·w` short of it, so a solid
and an outlined right triangle in one column had visibly different left edges. The diamond's
90° axis-pointing miters overshot the target instead. Equal *maximum* reach never meant equal
*edge* positions.

The committed construction removes the stroke from every outlined mark with a corner. Those
five kinds are drawn as a filled `fill-rule="evenodd"` ring: the outer subpath is the solid
geometry itself — `size = 2T`, identical bytes to the solid form's boundary — and the inner
subpath is the same shape offset inward by `w`. Every painted edge therefore sits exactly where
the solid form's edge does, corners stay sharp, and no miter arithmetic exists to allow for.

Inner geometry, all in flooring WAD arithmetic:

- **triangle, right triangle**: the outer scaled about its incenter by `(ρ − w)/ρ`, which
  offsets every edge of a tangential polygon inward by exactly `w`. Inradii: equilateral
  `ρ = h/3`; right isoceles `ρ = r·(2 − √2)`.
- **diamond**: a rhombus is tangential too; the scale shortens the half-diagonal by `w·√2`.
- **half circle, quarter circle**: an arc of radius `R − w` about the same centre, chorded
  where it crosses the legs offset inward by `w`; the crossing is `√((R−w)² − w²)` from the
  centre, computed with a floor integer square root (unique, so both renderers agree exactly).

Circle, square and half square keep their strokes: with no corner sharper than 90° pointing
along an axis, a straddling stroke's painted extent already lands exactly on the target
everywhere.

The two open marks stop being strokes as well — a stroked diagonal's butt cap kept its
bounding box on target while its tips stopped `(√2/4)·w` short of the corners the neighbouring
solid shapes reach. Both become filled bands of one weight spanning the full footprint
(`size = 2T`):

- **line**: a band whose centreline is the footprint diagonal, clipped by the footprint
  square, so each tip ends in a point exactly on the corner with a `(√2/2)·w` run along each
  edge.
- **arc**: an annular band. The outer curve has the footprint for its radius and connects two
  footprint corners — the same curve as the outlined quarter circle's outer boundary — and the
  flat radial ends lie on the footprint edges.

- **Two value-inert admin pointers, no economic admin.** `Ownable` is inherited and
  transferable. The owner can replace and permanently lock the renderer, and can set,
  replace, clear and permanently lock the optional position resolver — including locking
  it forever at zero. The renderer is read only by `tokenURI`; the resolver is read only by
  `positionOf`. Neither reaches ETH, backing, redemption or token ownership. There is no
  pause, upgrade path, proxy or administrative reserve path. The owner may renounce at any time.
- `Shapes` stores per token a `bytes32 seed`, `uint8` denomination index, `uint32`
  origin count, Black flag and ink gene. Backing is derived from the index against the
  immutable ladder, so an out-of-range backing value is not representable.
- `feeBps` and `feeRecipient` are `immutable`, set at construction. `renderer` is
  mutable until `lockRenderer`; both `setRenderer` and the constructor refuse a
  codeless renderer, so `tokenURI` can never be pointed at an address without code.
- The mint fee is `feeBps` basis points of the backing (the committed value is
  100, i.e. 1%). One percent of every denomination is a whole number of wei, so
  the fee is exact at each. Fees are forwarded to `feeRecipient` in the same
  transaction and never enter the reserve. A batch forwards its aggregate once.
- `receive` and `fallback` revert, so ETH cannot arrive except through `mint`.
  Forced ETH (selfdestruct, block rewards) is permanently inaccessible; the
  invariant asserted is `address(this).balance >= redeemableBacking`.
- Checks-effects-interactions, plus a reentrancy guard on functions that mint, restructure
  or move ETH: `mint`, `mintBatch`, `redeem`, `burn`, `redeemBatch`, `compose`,
  `decompose`, `split`, `sacrifice`. The inherited
  ERC721 transfer and approval functions are **not** guarded, deliberately —
  they move no ETH. One consequence is worth knowing: a receiver can redeem a
  Shape from inside its own `onERC721Received` during a `safeTransferFrom`.
  Accounting stays exact; an integrator that assumes the token still exists
  after a safe transfer can be griefed into reverting.
- Minting or transferring a Shape to the `Shapes` contract itself is refused.
  The contract can never be `msg.sender`, so such a token could never be
  redeemed, and its backing would be stranded while `redeemableBacking` went on
  counting it.
- The renderer address is checked for code at construction and on replacement. Metadata has
  no fallback path; the renderer becomes permanent only after `lockRenderer`.

### D17. Ink Genes

Full design rationale in `INK_GENES_DRAFT.md`; formulas, file-by-file changes and tests are
pinned in `INK_GENES_IMPL_SPEC.md`. This entry records the load-bearing invariants for anyone
reading `Shapes.sol`/`InkGenes.sol` without the implementation spec open.

- **Entropy only at mint.** A Shape's ink gene (`VOID`..`SOLID`, seven states) is drawn once,
  a pure function of the mint seed and the denomination tier (`InkGenes.geneAtMint`). No
  compose, decompose or split ever consumes fresh randomness for the gene; every later
  transformation is a deterministic function of state already on chain. Non-dust mints draw
  only from the narrow `{Sparse, Murk, Dense}` band; the four extremes are reachable only
  through a dust (0.01 ETH) mint, the same asymmetry the fill-probability table already had.
- **Compose walks toward a pool statistic, order-invariantly.** `compose` folds every burned
  token's seed into `burnSeedFold` via XOR as it iterates — commutative and associative, so
  the `burnIds` calldata order cannot affect the outcome. Over the same pass it accumulates
  `best`, `worst` and a units-weighted `sumW`/`unitsTotal` across `{survivor, all burns}`.
  `InkGenes.center` reduces `sumW`/`unitsTotal` to a single half-up-rounded gene; `geneAtCompose`
  then steps the survivor's gene at most one ladder position per tier crossed (`newIndex -
  oldIndex` tiers), each tier's target chosen by a roll against `center` (70%), `best` (20%) or
  `worst` (10%). A homogeneous pool is a fixed point of the walk by construction, needing no
  special case.
- **Survivor choice matters; burn order does not.** Which token is nominated as the survivor
  changes the roll stream (`R` is keyed on the survivor's own seed), so composing the same
  multiset with a different survivor can produce a different gene — this is deliberate and
  covered by `test_SurvivorChoiceChangesTheGene`. It is the one input to the walk that a caller
  actually controls; `burnIds` order is not, by the fold above.
- **split copies the gene verbatim.** Every child of a split inherits the parent's gene exactly.
  Nothing is rolled, so origins-conservation reasoning applies unchanged to the gene.
- **decompose restores the gene from the record.** `compose` captures the survivor's pre-compose
  gene and each input's gene in the compose record; `decompose` writes them back verbatim (survivor
  reverts to its snapshot gene, each revived input regains its own), so an `InkGene` event fires for
  the survivor and every revived id but no roll occurs. A compose then a decompose leave the gene
  exactly where it started (DECOMPOSE_SPEC.md).
- **`simulateCompose`/`simulateSplit`** preview the exact gene a real `compose`/`split`
  would produce, `view`, touching no storage — mirrors `compose`'s validation with an explicit
  duplicate-burn-id check in place of relying on `_burn` reverting.
- **One-tx apexes are not reachable.** `compose` burns its inputs in an O(n) loop, so a single
  transaction composing 10,000 dust straight into a 100 costs about 70.8M gas
  (`test_ComposeMegaGasProfile_10000Dust`), well over the block gas limit. This is fine for the
  game — a 100 is assembled by laddering through intermediate composes, not in one call — but no
  path should assume a single-transaction dust-to-apex is possible.

### D18. Final value and position discovery interfaces

- **One economic value, two names.** `valueOf(tokenId)` is an exact alias of the existing
  `backingOf(tokenId)`: both return the native ETH the current owner would receive by burning a
  live Shape now and both revert for nonexistent IDs. `backingOf` remains the protocol-native
  descriptive name; `valueOf` is the integration surface.
- **Draft ERC-8060.** `Shapes` implements the current draft `IERC721Value` pair (`valueOf` and
  owner-only `burn`) and advertises its interface ID through ERC-165. A normal `burn` destroys the
  token and pays its exact value. A Black Shape has value zero and can be destroyed without an
  ETH call. `sacrifice` only creates the Black state; it never burns the NFT. The standard is still
  a draft, so this deployment pins one revision rather than promising compatibility with later
  edits to the proposal.
- **Structural burns stay structural.** Tokens consumed by `compose` and `split` never
  pass through the public value-burning path and never settle ETH; `decompose` only reverses a
  recorded compose and likewise moves no ETH. Freshly produced tokens receive monotonically
  increasing IDs. The only identity revival is the exact set of compose inputs restored by its
  LIFO decompose record; redemption, public burn and split never recycle retired IDs.
- **Optional position resolver.** `positionOf(tokenId)` returns `address(0)` without an external
  call while `positionResolver` is empty. Otherwise it delegates the ID exactly to the configured
  resolver and returns its address unchanged. Shapes deliberately performs no token-existence,
  result-code or backing check: the resolver may describe historical/nonexistent IDs, and its
  revert or misleading result affects only callers of `positionOf`.
- **Replaceable, clearable, independently lockable.** The transferable owner may set or replace
  the resolver with a contract address, clear it to zero, or permanently lock its current value at
  any time — including locking zero. Renderer and resolver locks are independent. Ownership
  transfer moves all still-unlocked authority; renunciation ends it. Neither pointer can change
  backing, ownership, redemption, composition or reserve accounting.

---

## Part 4 — Acceptance checks

| Check | Where |
|---|---|
| PRNG bit-identical to Round 03 over the design's seed range | `npm run verify` |
| Fixed-point geometry within 1e-9 of the original float pipeline | `npm run verify` |
| 500-sample collision sweep, all nine denominations | `npm run sweep` |
| Solidity SVG byte-identical to TypeScript fixtures | `forge test --mc Parity` |
| Reserve solvency under fuzzed mint/transfer/redeem sequences | `forge test --mc Invariant` |
| Value alias, burn settlement, Black zero-burn and ID lifecycle | `forge test --mc ValueDiscoveryTest` |
| Resolver delegation, locking and administrative isolation | `forge test --mc PositionResolverTest` |

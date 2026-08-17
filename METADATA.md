# Shapes — metadata reference

Every Shape's `tokenURI` is a base64 `data:application/json` document produced entirely on chain
by `ShapeRenderer.sol`. The TypeScript canonical (`preview/src/canonical/render.ts`,
`tokenMetadataJson`) is the byte-for-byte source of truth; `test/Parity.t.sol` asserts the two
agree exactly. No off-chain metadata service exists, so nothing here can rot or be withheld.

The document has `name`, `description`, `image` (an inline SVG `data:image/svg+xml` URI), and a
fixed `attributes` array. Every attribute `value` is a **string**. There are no numeric traits:
numeric traits render as range sliders on OpenSea, which the collection does not use. String
traits render as exact-match filters.

## Attributes

| # | trait_type | Example | Meaning |
|---|---|---|---|
| 0 | `ETH Value` | `"1 ETH"` | The denomination the token wraps. One of the nine ladder values. |
| 1 | `Grid` | `"3x3"` | Columns by rows of the module grid. Fixed per denomination. |
| 2 | `Fill` | `"Mixed"` | Realized fill of the card. See below. |
| 3 | `Ink` | `"Dense"` | The ink gene. See below. |
| 4 | `Modules` | `"● △ ◐ …"` | The module glyph sequence, one glyph per cell, from the same stream that draws the art. |
| 5 | `Module Count` | `"9"` | Number of marks on the card (`cols * rows`). |
| 6 | `Formation` | `"Composed"` | Provenance class. See below. |
| 7 | `Independent Origins` | `"1"` | Count of direct-mint events baked into the token (`originCount`). |
| 8 | `Origin Density` | `"11%"` | `originCount / units`, as a percent. 100% means every unit of backing traces to its own mint. |
| 9 | `Complete` | `"false"` | `true` when `Origin Density` is 100% and the token is above the minimum tier. The `blacken` gate at the apex. |
| 10 | `Black` | `"false"` | `true` when the token has been sacrificed via `blacken`. |
| 11 | `Seed` | `"0x…"` | The 32-byte visual seed. |

## Ink

The ink gene is a seven-state value assigned once at mint and thereafter changed only by
`compose`; `decompose` and `restore` copy it verbatim. It sets the probability that any given
mark on the card is drawn filled rather than open outline:

| Ink | Void | Faint | Sparse | Murk | Dense | Rich | Solid |
|---|---|---|---|---|---|---|---|
| solid chance | 0% | 15% | 35% | 50% | 65% | 85% | 100% |

Dust (0.01) mints roll the full seven-state lottery; every larger direct mint rolls only the
narrow `{Sparse, Murk, Dense}` band, so the four extremes enter the population only through dust.
The gene is a property of the token: persistent, inheritable, and the same across every mark on
the card. Full rules in SPEC.md D17.

## Fill vs Ink

`Ink` is the gene (the probability). `Fill` is how the marks on this specific card actually
painted:

- a mark counts as filled only when its solid draw is set **and** its kind has a solid form;
- the arc and the diagonal line are open strokes with no solid form (SPEC.md D15), so they never
  count as filled however the draw landed;
- all marks filled is `Solid`; none filled is `Outline`; any split is `Mixed`.

`Fill` is independent of `Ink`. A Solid-gened card that happens to carry an open stroke reads
`Mixed`, and a single-mark 100 reads the true state of its one mark (`Solid` or `Outline`, never
`Mixed`). Because most multi-mark cards contain at least one open stroke, `Solid` and `Outline`
are uncommon there and concentrate at the top of the ladder.

## Formation

Derived from `originCount` (independent mint events baked in) against `units` (the backing in
0.01 multiples). It is provenance only: `originCount` never affects backing or redemption. A
token of any Formation, Fragment included, is backed by the full ETH of its denomination and
redeems for exactly that.

| Formation | Condition | Meaning |
|---|---|---|
| `Direct` | `originCount == 1` | Minted straight at this denomination, never composed. |
| `Composed` | `2 <= originCount < units` | Built by merging pieces, not entirely from dust. |
| `Complete` | `originCount == units` (units > 1) | Every 0.01 of backing traces to its own dust mint. Only a Complete apex can be `blacken`ed. |
| `Fragment` | `originCount == 0` | A decompose remainder: full backing, no origin credit. Origins partition survivor-first across a split, so children past the origin supply get zero. |
| `Black` | sacrificed | The 100 ETH was burned via `blacken`; renders as a black card. |

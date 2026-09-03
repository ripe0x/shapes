# Shapes — metadata reference

Every Shape's `tokenURI` is a base64 `data:application/json` document produced entirely on chain
by `ShapeRenderer.sol`. The TypeScript canonical (`preview/src/canonical/render.ts`,
`tokenMetadataJson`) is the byte-for-byte source of truth for the SVG, the attributes, and the
default copy; `test/Parity.t.sol` asserts the two agree exactly at that default copy. No off-chain
metadata service exists, so nothing here can rot or be withheld.

The token `name` prefix and shared `description` are admin-set copy, stored on Shapes and passed
into the renderer. `setMetadataCopy` edits both atomically. The one name exception is the owner
token, the one live Shape that currently carries collection ownership (starts as #0, moves through
`compose`, `decompose` and `split`): its name is the ordinary `namePrefix` plus token id, suffixed
with `, Contract Owner` (e.g. `Shape 5, Contract Owner`), so the name tracks whichever token
currently holds the role. `contractURI`
uses the immutable ERC-721 name `Shapes` and the shared description, so collection and token
descriptions cannot diverge. Copy defaults to the TypeScript canonical and is validated on set so
it cannot break the JSON (`"`, `\`, C0 control bytes and over-length values revert). Everything
else is fixed on chain.

The document has `name`, `description`, `image` (an inline SVG `data:image/svg+xml` URI), and a
fixed `attributes` array. Every attribute `value` is a **string**. There are no numeric traits:
numeric traits render as range sliders on OpenSea, which the collection does not use. String
traits render as exact-match filters. The owner-token entry (see below) omits `trait_type`
entirely; marketplaces including OpenSea render a value-only attribute as a plain tag rather than
a labeled trait.

## Attributes

| # | trait_type | Example | Meaning |
|---|---|---|---|
| 0 | `ETH Value` | `"1 ETH"` | The denomination the token wraps. One of the nine ladder values. |
| 1 | `Grid` | `"3x3"` | Columns by rows of the module grid. Fixed per denomination. |
| 2 | `Fill` | `"Mixed"` | Realized fill of the card. See below. |
| 3 | `Ink` | `"Dense"` | The ink gene. See below. |
| 4 | `Modules` | `"● △ ◐ …"` | The module glyph sequence, one glyph per cell, from the same stream that draws the art. |
| 5 | `Module Count` | `"9"` | Number of marks on the card (`cols * rows`). |
| 6 | `Primitive` | `"Half Circle"` | Most common geometric module type in the artwork. |
| 7 | `Variety` | `"8"` | Number of distinct geometric module types used, from 1 through 10. |
| 8 | `Ink Tier` | `"Common"` | Rarity band derived from the inherited ink gene. |
| 9 | `Formation` | `"Composed"` | Provenance class. See below. |
| 10 | `Independent Origins` | `"1"` | Count of direct-mint events baked into the token (`originCount`). |
| 11 | `Origin Density` | `"11%"` | `originCount / units`, as a percent. 100% means every unit of backing traces to its own mint. |
| 12 | `Complete` | `"false"` | `true` when `Origin Density` is 100% and the token is above the minimum tier. The `sacrifice` gate at the apex. |
| 13 | `Black` | `"false"` | `true` when the token has been transformed via `sacrifice`. |
| 14 | `Compose Depth` | `"2"` | Number of stacked composes the current holder can reverse, newest first. |
| n/a | *(none)* | `"Contract Owner"` | Value-only attribute (no `trait_type`), present only on the owner token, the one live Shape that currently carries collection ownership. It grants no administrative authority. |
| n/a | `Split From` | `"10 ETH"` | Only on a split child (issue #21C): the immediate parent's denomination. See below. |
| n/a | `Split Origin` | `"100 ETH"` | Only on a split child: the root split ancestor's denomination. See below. |

## Ink

The ink gene is a seven-state value assigned once at mint and thereafter changed only by
`compose`; `decompose` restores the pre-compose value and `split` copies it verbatim. It sets the probability that any given
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
| `Complete` | `originCount == units` (units > 1) | Every 0.01 of backing traces to its own dust mint. Only a Complete apex can be sacrificed. |
| `Fragment` | `originCount == 0` | A decompose remainder: full backing, no origin credit. Origins partition survivor-first across a split, so children past the origin supply get zero. |
| `Black` | sacrificed | The 100 ETH was burned via `sacrifice`; renders as a black card. |

Split allocates a parent's origin count across its children greedily, filling each child's
capacity in order until the count runs out: the first child(ren) can read `Direct` or `Composed`
exactly as a non-split token of that origin count would, the rest read `Fragment`. Formation alone
does not distinguish a split child from an original mint or compose result with the same origin
count; `Split From` / `Split Origin` below are the traits that record split ancestry.

## Split From / Split Origin

Present only on a token minted by `split`/`splitTo`; omitted entirely from every other token's
`attributes`, including a split child's own later compose results (composing changes the token's
denomination and Formation, not its creation history).

- `Split From` is the immediate parent's denomination at the moment of that split, e.g. `"10 ETH"`.
- `Split Origin` is the root split ancestor's denomination, e.g. `"100 ETH"`: for a child of a
  direct-mint or compose-result parent, this equals `Split From`; for a grandchild (a split of a
  split), it is the denomination further up the chain, letting a deep descendant still read where
  its lineage started.

Both are creation provenance, fixed at split time. `Compose Depth` separately records what has
happened to the token since: a split child that later survives a compose keeps `Split From` /
`Split Origin` unchanged and its `Compose Depth` counts the merges on top.

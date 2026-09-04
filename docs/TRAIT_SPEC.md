# Shape traits — additions (v2)

New collectible/rarity attributes added to `metadataJSON`. All are **renderer-only** (the renderer
is admin-replaceable until `lockPresentation`) and **aesthetic** — they carry no economic weight;
redemption value stays denomination-only (SPEC.md D15). Every value below is **byte-parity-critical**:
the canonical TypeScript renderer must emit identical bytes, verified by `Parity.t.sol` fixtures.

## Batch 1 — visual rarity (implemented in `ShapeRenderer.sol`)

Derived from the `card` the renderer already builds (`compose(seed, amountWei, inkGene)`); no
interface change. Emitted in the attributes array immediately after **Module Count**, before the
provenance block (`_visualTraits`).

### `Primitive` — dominant kind
Most-frequent of the ten primitive kinds on the card. Ties resolve to the **lowest KIND index**
(deterministic). Value = kind display name from this exact table (KIND order is consensus-critical):

| index | name |
|---|---|
| 0 | `Circle` |
| 1 | `Square` |
| 2 | `Triangle` |
| 3 | `Half Circle` |
| 4 | `Quarter Circle` |
| 5 | `Diamond` |
| 6 | `Half Square` |
| 7 | `Right Triangle` |
| 8 | `Arc` |
| 9 | `Line` |

### `Variety` — distinct kinds present
Count of the ten kinds that appear at least once, as a decimal string `"1"`..`"10"`. `1` = a
single-kind card.

### `Ink Tier` — gene rarity band
Maps the 7-state ink gene to a tier. The four extremes are dust-mint-only, hence scarcer:

| gene(s) | tier |
|---|---|
| Void (0), Solid (6) | `Mythic` |
| Faint (1), Rich (5) | `Rare` |
| Sparse (2), Murk (3), Dense (4) | `Common` |

## Batch 2 — Compose Depth (implemented)

`Compose Depth` surfaces `Shapes.composeDepth(tokenId)` — how many stacked composes `decompose`
can still reverse. This is **contract state, not seed-derived**: it is the last argument to
`IShapeRenderer.metadataJSON` / `tokenURI`, plumbed through from `Shapes.tokenURI`'s
`_composeStack[tokenId].length`. Emitted after `Black`, before any conditional token #0 or split
traits:
`,{"trait_type":"Compose Depth","value":"<n>"}`, value a plain decimal string. 0 at mint;
incremented by each `compose`, decremented back by the matching `decompose`.

## Token #0 — Collection Owner (implemented)

The owner token (initially #0, moving with compose, decompose and split per `ownerToken()`) is
named `<prefix><id>, Contract Owner`. It alone appends the value-only attribute
`{"value":"Contract Owner"}` after `Compose Depth`; marketplaces render a value-only attribute as a
plain tag. The attribute is descriptive only: holding the owner token grants no administrative
authority, and all privileged calls remain gated by the separate `admin()` role.

## Parity + tests

- Mirror `_kindName`, `_dominantPrimitive`, `_varietyCount`, `_inkTier`, `_visualTraits` in the
  canonical TS renderer (`preview/src/canonical/`), byte-identical. `Compose Depth` is a plain
  `tokenMetadataJson` parameter, not seed-derived, so it is a fixture input rather than something
  the TS renderer computes.
- Regenerate `test/fixtures/fixtures.json` from the TS renderer; include fixtures with
  `composeDepth > 0` to cover the trait's non-zero rendering.
- `Parity.t.sol` (SVG + metadata byte-parity) must pass; add a metadata test asserting each new
  trait, including that `Compose Depth` tracks `compose`/`decompose` on a live token.
- Include token #0 in the parity corpus and assert its fixed name and collection-owner trait in
  direct Solidity and TypeScript metadata tests.

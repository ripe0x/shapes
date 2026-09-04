# Geometry and rendering

Artwork and metadata are generated onchain at call time. Shapes exposes the rendered outputs and the machine-readable geometry behind them, so another contract or an offchain renderer can work from the same data.

## Rendered outputs

| Function | Returns |
| --- | --- |
| `tokenURI(tokenId)` | `data:application/json;base64,…` |
| `metadataJSON(tokenId)` | The decoded JSON body of `tokenURI` |
| `svg(tokenId)` | The SVG document, a `0 0 250 350` viewBox, black and white only |
| `unicodeCard(tokenId)` | The module grid as glyphs, cells separated by spaces, rows by newlines. Display only |
| `contractURI()` | Collection metadata, `data:application/json;base64,…` |

The image inside the metadata is a `data:image/svg+xml;base64,…` URI. No IPFS, no external image, no fonts, no server. A Black Shape renders the same geometry inverted.

Rendering reads the token's seed, denomination, ink gene, Black flag, origin count, compose depth, split provenance, owner-token status and stored modules, and passes them to `renderer()`. Until `lockPresentation()` the admin can replace the renderer, which changes how every token looks and nothing else. `presentationLocked()` reports the freeze.

## Metadata attributes

Every token's JSON carries these `attributes`, in this order: `ETH Value`, `Grid`, `Fill`, `Ink`, `Modules`, `Module Count`, `Primitive`, `Variety`, `Ink Tier`, `Formation`, `Independent Origins`, `Origin Density`, `Complete`, `Black`, `Compose Depth`. A split child adds `Split From` and `Split Origin`. The owner token adds a value-only `"Contract Owner"` attribute with no `trait_type` and its name reads `Shape N, Contract Owner`. METADATA.md in the repository documents each field. Treat the strings as presentation; the numeric reads on [Reading state](/docs/reading-state) are the API.

## The grid

`geometryOf(tokenId)` returns `(cols, rows, moduleCount)`. The grid is fixed per denomination:

| Index | ETH | Grid | Modules |
| --- | --- | --- | --- |
| 0 | 0.01 | 5 × 5 | 25 |
| 1 | 0.05 | 4 × 5 | 20 |
| 2 | 0.1 | 4 × 4 | 16 |
| 3 | 0.5 | 3 × 4 | 12 |
| 4 | 1 | 3 × 3 | 9 |
| 5 | 5 | 2 × 3 | 6 |
| 6 | 10 | 2 × 2 | 4 |
| 7 | 50 | 1 × 2 | 2 |
| 8 | 100 | 1 × 1 | 1 |

## Modules

A module is one mark in one cell. Its identity is a **kind**, a **solid** flag and a **rotation**; its position, size and stroke weight derive from the grid and the card constants, so every module on a card shares one size and one weight.

| Kind | Primitive | Rotations |
| --- | --- | --- |
| 0 | Circle | 1 |
| 1 | Square | 1 |
| 2 | Triangle | 4 |
| 3 | Half circle | 4 |
| 4 | Quarter circle | 4 |
| 5 | Diamond | 1 |
| 6 | Half square | 4 |
| 7 | Right triangle | 4 |
| 8 | Arc | 4, outline only |
| 9 | Diagonal line | 2, outline only |

### ModuleCodec

`modulesOf`, `effectiveModulesOf`, `ShapeState.modules`, `ComposeInputView.modules`, `ShapeChildPreview.modules` and the `ModulesSampled` event all carry one byte per cell in row-major order:

```
bit 7      always 0
bits 6..5  rotation index, 0..3, meaning rotIndex * 90 degrees clockwise
bit 4      solid
bits 3..0  kind, 0..9
```

A byte is valid when bit 7 is clear, `kind < 10` and `rotIndex < rotations(kind)`.

### Two geometry sources

An original mint stores no modules: `modulesOf` is empty and the grid is derived from the seed at render time (grammar v1). Compose and split store sampled modules for the survivor or each child, drawn from the inputs' effective modules, and decompose restores whatever was stored before. `effectiveModulesOf(tokenId)` hides the difference and returns the bytes that actually render. SAMPLING_SPEC.md in the repository specifies the sampling.

### Per-module reads

```solidity
function moduleAt(uint256 tokenId, uint256 index) external view returns (
    uint8 kind, bool solid, uint16 rotation, uint256 cx, uint256 cy, uint256 size, uint256 weight);
```

`index` runs over `effectiveModulesOf` order. `rotation` is in degrees. `cx`, `cy`, `size` and `weight` are 18-decimal fixed point (`1e18` = 1.0) in SVG user units of the 250 × 350 viewBox.

## IShapeGeometry on the renderer

The renderer answers `IShapeGeometry`, a pure interface that computes the same values from raw inputs, so a contract can reason about a card that no token exists for:

```solidity
function grammarVersion() external pure returns (uint32);
function grammarHash() external pure returns (bytes32);
function cardGeometry(bytes32 seed, uint256 amountWei, uint8 inkGene) external pure returns (
    uint8 denominationIndex, uint256 cols, uint256 rows, uint256 cell, uint256 target,
    uint256 weight, uint256 solidProbability, uint256 moduleCount);
function cardGeometrySampled(bytes calldata modules, uint256 amountWei, uint8 inkGene) external pure returns (…same…);
function moduleAt(bytes32 seed, uint256 amountWei, uint8 inkGene, uint256 index) external pure returns (…as above…);
function moduleAtSampled(bytes calldata modules, uint256 amountWei, uint8 inkGene, uint256 index) external pure returns (…as above…);
```

Read the address from `Shapes.renderer()`. `IShapeRenderer.renderSVG(seed, amountWei, inverted, inkGene)` and `renderSVGSampled(modules, …)` draw a card from the same inputs. The collection contract at `Shapes.collection()` offers `cardFor(seed, denomIndex)` for a seeded preview with the ink gene derived the way a mint derives it.

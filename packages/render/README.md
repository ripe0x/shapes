# shapes-render

The canonical Shapes renderer in TypeScript, formerly `preview/src/canonical/`. `src/ShapeRenderer.sol`
is a line-by-line port of it, and `src/pack.ts` is a port of `ShapePackRenderer.sol`. Output is
byte-identical to the contracts. The only dependency is viem, for keccak, packed encoding and
address checksums.

## API

```ts
import { renderShape, inkGeneAtMint, renderPack, packTokenURI } from "shapes-render";

// From a ShapeMinted(tokenId, to, amountWei, seed, originCount) event:
const gene = inkGeneAtMint(seed, amountWei);
const svg = renderShape(BigInt(seed), amountWei, tokenId, gene);
```

- `renderShape(seed, amountWei, tokenId, inkGene)` returns the SVG `Shapes.svg(tokenId)` returns
  for a token drawn from its seed. Black Shapes pass `CANONICAL, true` as the last two arguments.
- `renderSampledShape(modules, denomIndex, tokenId, inkGene)` is the same for a token with
  materialized modules (`shapeState(id).modules` non-empty, after compose or split).
- `inkGeneAtMint(seed, amountWei)` derives the gene `Shapes.sol` stores at mint. It is the
  token's gene only until its first compose; read `inkGeneOf` after that.
- `renderPack(cards)` returns the Pack SVG; `packMetadataJson(input)` and `packTokenURI(input)`
  mirror `ShapePackRenderer.metadataJSON` and `tokenURI`. `contractURI` is not ported: its image
  is seeded from the block.

Every module is importable on its own, e.g. `shapes-render/sampling`. The ladder is mainnet unless
`process.env.SHAPES_LADDER === "testnet"` at build time.

## Checks

```bash
npm run test --workspace shapes-render
```

```bash
npm run check:mainnet --workspace shapes-render
```

`check:mainnet` is read-only. It renders every live Shape and compares with `Shapes.svg`
(`0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0`), checks `inkGeneAtMint` against the `InkGene`
event of every `ShapeMinted`, and compares `packTokenURI` with `tokenURI` for every live Pack
(`0xBa48517Cb5Fa86430582898FD07B7E9D80cD1815`). Live packs cover only some fan sizes, so it also
calls that Packs contract's renderer `image()` directly with every size from 0 to 12 cards and
compares with `renderPack`. RPC defaults to
`https://mainnet.gateway.tenderly.co`; `RPC_URL` overrides it.

The Foundry parity suite (`forge test --mc ParityTest`) checks `src/ShapeRenderer.sol` against
fixtures generated from this package by `preview/scripts/genFixtures.ts`.

## Which renderer copy matches mainnet

Checked 2026-11-07 against mainnet (186 Shapes minted, 105 live, 1 with sampled modules; 14
Packs minted, 9 live).

| Copy | SVG, 105 live tokens | Owner-token metadata | Sampling | Solidity |
| --- | --- | --- | --- | --- |
| this repo, `packages/render` | match | supported | D1′, as deployed | `ShapeRenderer.sol` compiles to the live renderer `0xe9ac8D91…9295` byte for byte, metadata hash included; `GeometrySampling` and `InkGenes` match their live libraries |
| `shapes-p1-site` `27439c5`, `preview/src/canonical` | match | **missing** | **D1** | **drifts** |
| `shapes-p1-experiments` `5113d87`, `preview/src/canonical` | match | **missing** | **D1** | **drifts** |

**This repo is the only copy that matches mainnet.** The two p1 copies are byte-identical to
each other (TypeScript and `ShapeRenderer.sol`), last committed 2026-08-27, before the mainnet
deploy commit `1b84c102` (2026-09-09). Shapes metadata JSON was not byte-compared for any copy.

- Metadata: no owner-token name or trait. Mainnet token 0 is named `Shape 0, Contract Owner` and
  carries `{"value":"Contract Owner"}`; p1 cannot produce either. No `Split From` / `Split Origin`
  traits.
- Sampling: compose draws modules with replacement (D1). Mainnet uses D1′, without replacement.
  Live SVGs still match because every sampled token renders from its stored modules; the
  difference appears when predicting a new compose or split.
- Solidity: p1 `ShapeRenderer.sol` still carries the retired seed-level solid-probability band,
  lacks split provenance, and its `GeometrySampling`, `InkGenes` and `Round03Rand` differ from
  this repo's, which is what is deployed.

The p1 SVG match covers only today's live tokens. It does not show the p1 renderers would agree
with mainnet on future composes or splits.

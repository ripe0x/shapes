# SHAPES-API: art, metadata and value from the indexer, and a Shapes SDK

Owner request, 2026-09-20: no app should call the chain to get a Shape's image or metadata.
The Shapes project owns the answer; consumers (the Shapes site, the Draw vault site, third
parties) use it.

## What exists

- `indexer/`: a Ponder indexer with a `token` table (`id, seed, denomIndex, backingWei,
  originCount, composeDepth, inkGene, modules, isBlack, live, splitFromDenom, splitOriginDenom,
  owner, mintDenomIndex`), `lineage_edge`, `activity`, `auction_lot`, `collection_owner`; a Hono
  API in `indexer/src/api/` with bearer auth; Fly apps `shapes-indexer` (Sepolia) and
  `shapes-indexer-mainnet`; `deployments/<chainId>.json` carries `indexerUrl`.
- `preview/src/canonical/`: the TypeScript port of the on-chain renderer (`render.ts`:
  `renderShape`, `svgFromComposition`, plus `sampling.ts`, `ink.ts`, `moduleCodec.ts`,
  `denominations.ts`, `params.ts`, `rand.ts`, `wad.ts`) with a parity suite that asserts
  byte-for-byte agreement with `Shapes.svg(tokenId)`.
- `web/`: the Shapes site proxies indexer reads through `/api/indexer`; `web/app/og/shape/[id]`
  renders the contract's SVG server-side.

## Required work

1. Package `packages/shapes-sdk` (npm workspace, TypeScript, ESM, no framework dependency):
   - Move `preview/src/canonical/` into the package as its `render` module and make `preview`
     import it from the package; the parity suite keeps running unchanged against the package.
   - `renderShapeSvg(state)` where `state` is the indexer's token row shape (seed, denomIndex,
     modules, inkGene, isBlack, ...); returns the exact SVG string the contract returns.
   - `ShapesApi` client: `shape(chainId, id)`, `shapes(chainId, {owner | ids})`, `artUrl(chainId,
     id, version)`; fetch-based, typed responses, no auth needed for the public routes.
   - Address book and ABI per chain from `deployments/<chainId>.json` and `indexer/abis`.
2. Indexer API routes (public GET, CORS open, rate limited per IP, no bearer token):
   - `GET /v1/:chainId/shape/:id.json`: the token row plus `version` (the token's last state
     change: the id or block of its latest `activity` row), `backingWei` as a string, `owner`,
     `live`, denomination label, and `artUrl`.
   - `GET /v1/:chainId/shape/:id.svg` and `GET /v1/:chainId/shape/:id/:version.svg`: the SVG
     rendered from the token row by `renderShapeSvg`. The versioned URL is immutable
     (`Cache-Control: public, max-age=31536000, immutable`, `ETag`); the versionless URL redirects
     (302) to the current version with a short cache. A token that changed state (compose,
     split) gets a new version, so stale art can never be served as current.
   - `GET /v1/:chainId/shapes?owner=0x..` and `?ids=1,2,3` (bounded page size) returning rows
     with `artUrl`.
   - `:chainId` must equal the indexer's configured chain; otherwise 404 with a body naming the
     chain it serves.
   - Rendering is pure computation from the row, no RPC. If the parity suite covers every
     state the row can carry, no chain read is needed anywhere in the API.
3. Tests: route tests with a seeded database (the indexer's existing test approach); a parity
   test that renders ten Sepolia tokens from indexed rows and compares them to `Shapes.svg`
   on the pinned fork; SDK client tests against a local Hono instance.
4. Docs: `indexer/README.md` gains the public route list; `packages/shapes-sdk/README.md`
   shows the three calls; `project/DECISIONS.md` gains an entry recording that art and
   metadata come from the indexer and the SDK, with the chain as the parity reference only.

## Allowed files

`packages/shapes-sdk/**` (new), `preview/src/canonical/**` (move) and the `preview` imports
that referenced it, `indexer/src/api/**`, `indexer/src/lib/**`, `indexer/README.md`,
`indexer/package.json`, root `package.json` (workspace list), `project/DECISIONS.md`,
`project/tasks/SHAPES-API.md` (status line).

## Prohibited

Any change under `src/` (contracts), `script/`, `test/`, `deployments/`; any Fly deploy or
`.env` change; any new runtime dependency beyond what the indexer and preview already carry;
any chain read in the API request path.

## Verification

```
npm install
npm --workspace packages/shapes-sdk test
cd indexer && npm test
cd preview && npm test        # parity suite still green against the moved renderer
```

## Acceptance

Every test green; a local indexer run (`cd indexer && npm run dev` against the Sepolia env in
`.env.example` values, or the test database) answers the three routes with the documented
headers; the SDK renders a token identical to the chain. Commit on branch `claude/shapes-api`,
files added explicitly, message `feat: Shapes API routes and the shapes-sdk package
(SHAPES-API)` with the Claude co-author line. Do not push.

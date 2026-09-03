# shapes-indexer

A [Ponder](https://ponder.sh) indexer for the standalone Shapes ERC721
(`src/Shapes.sol`). Turns the ten consumed onchain events into three Postgres tables —
`token`, `lineage_edge`, and the `collection_owner` singleton — queryable over GraphQL
or `@ponder/client` SQL-over-HTTP, so a frontend never has to scan chain logs directly. Log
scanning is fatal on mainnet and for any token with a deep composition /
decomposition history, since a single Shape can have thousands of ancestor
edges.

This is a self-contained subproject. It does not import or depend on
anything in `../src`, `../preview`, `../test`, or `../script`; it only reads
the deployed contract's events over RPC.

## Setup

```bash
cd indexer
npm install
cp .env.example .env.local   # then fill in the values below
```

`.env.local` needs:

| Var | Dev chain | Mainnet |
| --- | --- | --- |
| `PONDER_RPC_URL` | `http://127.0.0.1:8547` (from `preview/public/deployment.json`) | an archive-capable mainnet RPC |
| `PONDER_CHAIN_ID` | `31347` (from `preview/public/deployment.json`, currently) | `1` |
| `SHAPES_LADDER` | `mainnet` locally unless running the testnet profile | `mainnet` |
| `SHAPES_ADDRESS` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` (from `preview/public/deployment.json`, currently) | not deployed yet — placeholder in `.env.example` |
| `AUCTION_HOUSE_ADDRESS` | the dev chain record's `.auctionHouse` | the deployment record's `.auctionHouse` |
| `SHAPES_START_BLOCK` | `0` is fine for a fresh local anvil chain | the Shapes deployment block |

The dev chain's address/chainId/rpc drift as the local chain is redeployed —
re-check `preview/public/deployment.json` if indexing comes up empty.
`ponder.config.ts` throws immediately at startup if `SHAPES_ADDRESS` or
`AUCTION_HOUSE_ADDRESS` is unset, rather than silently indexing nothing. The
site reads token history and auction bid history from this indexer alone, so an
indexer missing either address leaves those sections empty.

## Run

```bash
npm run dev        # ponder dev: live-reloading, local pglite database
npm run start       # ponder start: production mode
npm run codegen     # regenerate ponder-env.d.ts without starting a server
npm run typecheck   # tsc --noEmit
```

`ponder dev` serves GraphQL at `http://localhost:42069/graphql` (interactive
GraphiQL in the browser) and the `@ponder/client` SQL endpoint at
`http://localhost:42069/sql/*`, backed by an embedded pglite database at
`.ponder/pglite`. Set `DATABASE_URL` to point at Postgres instead (see
`.env.example`).

Verified end to end against a running dev chain seeded by `npm run simulate`
(see the repo root): all nine event handlers below fired with zero indexing
errors. A representative run indexed 10k+ mints and their `InkGene`
assignments, 50 composes, 2 decomposes (11 `"split"` edges), 1 backing burn, and
20k+ transfers — every `token` row carried its assigned `inkGene` and every
`lineage_edge` its derived `childSeed`, queryable over GraphQL.

## Site data path and freshness

The shared site loader (`preview/src/site/data.ts`) treats this service as an optional,
advisory source. Add its public origin to runtime `deployment.json` only after the service is
live and read back:

```json
{ "indexerUrl": "https://your-shapes-indexer.example" }
```

It POSTs the gallery query below to `/graphql`, reads Ponder's built-in `_meta.status`
checkpoint, and compares the matching chain's indexed block to `eth_blockNumber`. The source is
accepted only when it is at most **2 blocks behind**. A missing URL, HTTP or GraphQL failure,
malformed/wrong-chain response, changing paginated checkpoint, an indexer ahead of the selected
chain, lag above 2 blocks, duplicate ids, or a live-id count different from `totalSupply` all use
the established raw-RPC loader. The indexer supplies only candidate live IDs. The site reads
owner, backing, seed, Black state, `tokenURI`, and compose depth from Shapes, so every displayed
or actionable field remains canonical chain state rather than an indexer assertion.

Ponder exposes `/health` (process live), `/ready` (backfill complete), and `/status` (latest
checkpoint). Configure infrastructure probes with `/ready`; the browser's block-level freshness
gate is stricter and protects users after a process is technically ready.

### RPC call measurement

The deterministic `preview/src/site/data.test.ts` fixture models **1,203 minted IDs**, with two
visible tokens and one Black token. It records the data-loader calls on each route:

| Gallery state | Raw chain | Fresh indexer |
| --- | ---: | ---: |
| Token-state contract reads | 1,218 (`ownerOf` × 1,203 + 5 fields × 3 live) | 18 (6 fields × 3 live) |
| Multicall requests | 4 | 1 |
| Header reads | 14 | 13 |
| Indexer HTTP requests | 0 | 1 GraphQL page |

That removes **1,200 of 1,218 token-state reads (98.52%)** without trusting indexed token state.
The indexer retains
the corresponding history/provenance path as one paginated `lineageEdges` query by `parentId` or
`childId`, rather than a token-lineage `eth_getLogs` scan. The current token detail screen stays
on raw history until its full dated-event presentation is mapped to indexed event rows; this
gallery rollout does not silently downgrade that display.

## Data model

### `token`

One row per token id ever minted. Never deleted — `live: false` marks a
token consumed by redemption, composition, or decomposition, so
history stays queryable.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigint` (PK) | token id |
| `seed` | `hex` | visual seed |
| `denomIndex` | `integer` | 0..8, index into the nine-denomination ladder (`src/lib/denominations.ts`) |
| `backingWei` | `bigint` | wei backing; `0` once `isBlack` |
| `originCount` | `integer` | independent direct-mint origins credited to this token |
| `composeDepth` | `integer` | active reversible compose records; incremented/decremented by compose/decompose |
| `inkGene` | `integer` | ink gene 0..6; set by `InkGene`, reassigned on every recomposition |
| `modules` | `hex?` | materialized geometry; null for seed-derived grammar v1 |
| `isBlack` | `boolean` | transformed via `burnBacking` |
| `live` | `boolean` | `false` once redeemed/composed-away/split-away |
| `owner` | `hex` | current owner address |
| `mintedAtBlock` | `bigint` | block this row's token id was created at |
| `mintTxHash` | `hex` | tx hash this row's token id was created in |

Indexes: `(denomIndex, live)` for gallery filtering, `owner`, `mintedAtBlock`.

### `lineage_edge`

One row per parent/child step in a token's provenance, written by `compose`,
and `decompose`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (PK) | `${txHash}-${logIndex}-${i}`, unique per edge within a single event |
| `childId` | `bigint` | the token consumed into `parentId` (continuation) or produced from it (split) |
| `parentId` | `bigint` | the surviving / continuing token |
| `kind` | `text` | `"continuation"` (compose burn), `"split"` (split output), or `"revival"` (decompose) |
| `childSeed` | `hex` | the child's seed at the time of the edge — lets a burned piece still be rendered from a lineage query alone |
| `block` | `bigint` | |
| `txHash` | `hex` | |

Indexes: `parentId` and `childId`, one for each query direction below.

### `collection_owner`

Single row tracking the collection owner token (issue #56): one live Shape can be the owner
token at a time, starting as #0 and moved by compose, decompose, and split, ended by redeem or
`burn()`. Keyed by a constant id since there is never more than one row.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (PK) | constant `"singleton"` |
| `ownerTokenId` | `bigint?` | current owner token id; `null` when no token holds ownership |
| `ownerAddress` | `hex?` | ERC-721 holder of `ownerTokenId`; `null` when `ownerTokenId` is `null` |
| `updatedAtBlock` | `bigint` | block of the last `OwnerTokenMoved` or correcting `Transfer` |

No indexes: single row, looked up by its constant id.

## The two frontend queries

**Gallery: live tokens, filterable by denomination, newest first, paginated.**

```graphql
query Gallery($denomIndex: Int, $limit: Int = 24, $after: String) {
  tokens(
    where: { live: true, denomIndex: $denomIndex }
    orderBy: "mintedAtBlock"
    orderDirection: "desc"
    limit: $limit
    after: $after
  ) {
    items {
      id
      denomIndex
      backingWei
      originCount
      isBlack
      owner
      mintedAtBlock
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

Omit `denomIndex` (or pass `null`) for the unfiltered gallery.

**Provenance: direct contributors of a token**, for progressive expansion of
a provenance tree (each contributor can itself be expanded by the same
query against its own id).

```graphql
query Contributors($tokenId: BigInt!) {
  lineageEdges(where: { parentId: $tokenId }) {
    items {
      childId
      kind
      childSeed
      block
      txHash
    }
    totalCount
  }
}
```

The inverse — "what did token X become" — is the same query with
`childId: $tokenId` instead, using the other index.

Both are also reachable over `@ponder/client` (`/sql/*`) as typed SQL
queries against the same two tables, if GraphQL's shape doesn't fit a given
call site.

## Event handling notes

The ten events and what each does to the three tables (`src/index.ts`):

- **`ShapeMinted(tokenId, to, amountWei, seed, originCount)`** — inserts a
  `token` row. `originCount` is always `1` on this event.
- **`InkGene(tokenId, gene)`** — sets the `token` row's `inkGene`. Emitted
  once per mint and once per recomposition, always right after the structural
  event (`ShapeMinted`/`Composed`/`Decomposed`) that creates or
  continues the row, so the row exists to update.
- **`ModulesSampled(tokenId, modules)`** — stores materialized geometry after
  compose, split, and decompose. Empty bytes become null, matching an original
  seed-derived Shape.
- **`Composed(survivorId, burnedIds[], denomIndex, originCount)`** — updates
  the survivor's `denomIndex`/`backingWei`/`originCount`; for each burned id,
  marks it `live: false` and inserts a `"continuation"` edge
  (`childId = burnedId`, `parentId = survivorId`).
- **`Decomposed(survivorId, restoredIds[], survivorDenomIndex, survivorOriginCount)`**
  — restores the survivor's denomination/origin count and decrements its compose
  depth; each already-indexed input becomes live again and gets a `"revival"`
  edge. Its later ERC721 mint `Transfer` supplies the exact recipient.
- **`Split(tokenId, parentSeed, newIds[], outDenoms[], originCounts[])`**
  — marks `tokenId` `live: false`; for each output, derives its seed as
  `keccak256(abi.encodePacked(parentSeed, i))` (matching `Shapes.sol`
  exactly — the event doesn't carry per-child seeds), inserts the new
  `token` row, and inserts a `"split"` edge (`parentId = tokenId`,
  `childId = newId`) — the edge direction is reversed from `Composed`
  because a split token becomes multiple children rather than several
  tokens becoming one.
- **`BlackShapeCreated(tokenId, burnedWei)`** — sets `isBlack: true`,
  `backingWei: 0`. Does not itself change `live`: a Black token remains transferable and
  may later be destroyed through `burn` for zero, but
  still exists and still has an owner.
- **`ShapeRedeemed(tokenId, to, amountWei, originCount)`** — marks `tokenId`
  `live: false`.
- **`OwnerTokenMoved(fromTokenId, toTokenId)`** — upserts the `collection_owner`
  singleton. `toTokenId == type(uint256).max` means no token holds ownership:
  `ownerTokenId`/`ownerAddress` become `null`. Otherwise `ownerTokenId` is set
  and `ownerAddress` is read off the target token's row if it already carries
  the right owner (compose survivor, decompose restore, an insert that already
  knew its final owner); where that row isn't there yet or is still stale, the
  `Transfer` handler below corrects it.
- **`Transfer(from, to, tokenId)`** — sets `owner: to` for every non-burn
  transfer, including mints. This is required for `splitTo`/`decomposeTo`:
  their aggregate events omit the recipient, while the following ERC721 mint
  transfer carries it exactly. Burn transfers are ignored because a dead row's
  owner is no longer meaningful. Also checks the `collection_owner` singleton:
  if `tokenId` is the current owner token, updates its `ownerAddress` to `to`.

## ABI

`abis/Shapes.ts` is a curated ABI for the indexer's event handlers and retained
read calls, not a mirror of the larger browser ABI in `preview/src/chain/abi.ts`.
New core views such as `exists` and `denomIndexOf` belong here only if the
indexer starts calling them. When a consumed event or read changes, rebuild the
contracts and copy that exact entry from the compiled Shapes
artifact so field names, types, and `indexed` flags match deployed bytecode.

## Production deployment: Fly + persistent PGlite

Shapes follows the proven To Be a Machine, Permanent Collection, and Artcoins deployment pattern:
one always-on Fly Machine running `ponder start`, with Ponder's embedded PGlite directory stored on
a 1 GB persistent Fly volume. There is no separate Postgres service. The index is entirely
reconstructable from Ethereum, and the site rejects unavailable or stale indexer responses in
favor of its raw-RPC path, so the single-machine availability tradeoff is bounded and explicit.

One Fly app per chain, each pinned to a `fly.<env>.toml` with a 12-second poll, one indexing
thread, a 1 GB shared-CPU Machine, and `/data/pglite` on its own volume:
`fly.sepolia.toml` (app `shapes-indexer`, `testnet` ladder) and `fly.mainnet.toml` (app
`shapes-indexer-mainnet`, `mainnet` ladder). Both leave the primary RPC public and archive-capable
with two more public RPCs as `PONDER_RPC_FALLBACKS`; neither toml is deployed directly.

### Environments

`deploy.sh` and `bootstrap.sh` are the one deploy path across chains: the toml holds every
chain-specific value except the Shapes contract address and start block, which come from
`deployments/<chainId>.json` at the repo root (written by `script/deploy.sh`) so the indexer is
never pointed at a stale or wrong contract by hand.

```bash
# once per environment, before its first deploy
indexer/bootstrap.sh sepolia   # or mainnet — prints the fly apps/volumes create commands
# <run the printed commands yourself>

# every time the contracts redeploy to that chain
indexer/deploy.sh sepolia      # or mainnet — reads deployments/<chainId>.json, deploys, records
```

`DRY_RUN=1 indexer/deploy.sh <env>` resolves the contract address/start block, validates the toml,
and prints the `fly deploy` command without calling Fly. A real run reads back `/health` and
`/graphql` after deploying and records `{DATABASE_SCHEMA: shapesAddress}` in
`indexer/deployments.json`, refusing a schema reused for a different address on a later run — bump
`DATABASE_SCHEMA` in the toml for a new deployment on the same chain rather than mixing two
contracts' history into one schema. Then read back `/health`, `/ready`, `/status`, and the gallery
GraphQL query before adding the app's URL as `indexerUrl` in deployment metadata (mainnet:
`INDEXER_URL` in `script/env/mainnet.env`, already set to `https://shapes-indexer-mainnet.fly.dev`
and written into `deployments/1.json` by `script/deploy.sh`). Do not scale either app beyond one
Machine while using PGlite; a future multi-Machine or sustained-load requirement is the trigger to
migrate to Postgres.

### Dependency security

Ponder 0.17.8 still pins vulnerable transitive versions, so `package.json` uses tested npm
overrides: `@hono/node-server` 1.19.15, `drizzle-orm` 0.45.2, `kysely` 0.28.17, Vite 6.4.3,
and esbuild 0.25.12. This clears the current npm advisories for encoded-path static serving,
SQL identifier/JSON-path handling, and Vite/esbuild dev-server traversal. The exact set passed
`npm audit --omit=dev`, Ponder codegen/typecheck, and a local Anvil `ponder start` smoke with
`/health`, `/ready`, `/status`, and the gallery GraphQL `_meta` response.

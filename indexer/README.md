# shapes-indexer

A [Ponder](https://ponder.sh) indexer for the standalone Shapes ERC721
(`src/Shapes.sol`). Turns the eight onchain events into two Postgres tables —
`token` and `lineage_edge` — queryable over GraphQL or `@ponder/client`
SQL-over-HTTP, so a frontend never has to scan chain logs directly. Log
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
| `SHAPES_ADDRESS` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` (from `preview/public/deployment.json`, currently) | not deployed yet — placeholder in `.env.example` |
| `SHAPES_START_BLOCK` | `0` is fine for a fresh local anvil chain | the Shapes deployment block |

The dev chain's address/chainId/rpc drift as the local chain is redeployed —
re-check `preview/public/deployment.json` if indexing comes up empty.
`ponder.config.ts` throws immediately at startup if `SHAPES_ADDRESS` is
unset, rather than silently indexing nothing.

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
(see the repo root): all eight event handlers below fired with zero indexing
errors. A representative run indexed 10k+ mints and their `InkGene`
assignments, 50 composes, 2 decomposes (11 `"split"` edges), 1 blacken, and
20k+ transfers — every `token` row carried its assigned `inkGene` and every
`lineage_edge` its derived `childSeed`, queryable over GraphQL.

## Data model

### `token`

One row per token id ever minted. Never deleted — `live: false` marks a
token consumed by redemption, composition, decomposition, or restore, so
history stays queryable.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigint` (PK) | token id |
| `seed` | `hex` | visual seed |
| `denomIndex` | `integer` | 0..8, index into the nine-denomination ladder (`src/lib/denominations.ts`) |
| `backingWei` | `bigint` | wei backing; `0` once `isBlack` |
| `originCount` | `integer` | independent direct-mint origins credited to this token |
| `inkGene` | `integer` | ink gene 0..6; set by `InkGene`, reassigned on every recomposition |
| `isBlack` | `boolean` | sacrificed via `blacken` |
| `live` | `boolean` | `false` once redeemed/composed-away/decomposed/restored-away |
| `owner` | `hex` | current owner address |
| `mintedAtBlock` | `bigint` | block this row's token id was created at |
| `mintTxHash` | `hex` | tx hash this row's token id was created in |

Indexes: `(denomIndex, live)` for gallery filtering, `owner`, `mintedAtBlock`.

### `lineage_edge`

One row per parent/child step in a token's provenance, written by `compose`,
`decompose`, and `restore`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` (PK) | `${txHash}-${logIndex}-${i}`, unique per edge within a single event |
| `childId` | `bigint` | the token consumed into `parentId` (continuation, restore) or produced from it (split) |
| `parentId` | `bigint` | the surviving / continuing token |
| `kind` | `text` | `"continuation"` (compose burn), `"split"` (decompose output), `"restore"` (restore input) |
| `childSeed` | `hex` | the child's seed at the time of the edge — lets a burned piece still be rendered from a lineage query alone |
| `block` | `bigint` | |
| `txHash` | `hex` | |

Indexes: `parentId` and `childId`, one for each query direction below.

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

The eight events and what each does to the two tables (`src/index.ts`):

- **`ShapeMinted(tokenId, to, amountWei, seed, originCount)`** — inserts a
  `token` row. `originCount` is always `1` on this event.
- **`InkGene(tokenId, gene)`** — sets the `token` row's `inkGene`. Emitted
  once per mint and once per recomposition, always right after the structural
  event (`ShapeMinted`/`Composed`/`Decomposed`/`Restored`) that creates or
  continues the row, so the row exists to update.
- **`Composed(survivorId, burnedIds[], denomIndex, originCount)`** — updates
  the survivor's `denomIndex`/`backingWei`/`originCount`; for each burned id,
  marks it `live: false` and inserts a `"continuation"` edge
  (`childId = burnedId`, `parentId = survivorId`).
- **`Decomposed(tokenId, parentSeed, newIds[], outDenoms[], originCounts[])`**
  — marks `tokenId` `live: false`; for each output, derives its seed as
  `keccak256(abi.encodePacked(parentSeed, i))` (matching `Shapes.sol`
  exactly — the event doesn't carry per-child seeds), inserts the new
  `token` row, and inserts a `"split"` edge (`parentId = tokenId`,
  `childId = newId`) — the edge direction is reversed from `Composed`
  because a split token becomes multiple children rather than several
  tokens becoming one.
- **`Restored(newTokenId, parentSeed, childIds[], denomIndex, originCount)`**
  — inserts the new `token` row (seed = `parentSeed`); for each child, marks
  it `live: false` and inserts a `"restore"` edge (`childId`,
  `parentId = newTokenId`).
- **`Blackened(tokenId, sacrificedWei)`** — sets `isBlack: true`,
  `backingWei: 0`. Does not change `live`: a blackened token is terminal but
  still exists and still has an owner.
- **`ShapeRedeemed(tokenId, to, amountWei, originCount)`** — marks `tokenId`
  `live: false`.
- **`Transfer(from, to, tokenId)`** — sets `owner: to`, but only for an
  ordinary transfer (`from` and `to` both non-zero). Mint and burn transfers
  are skipped: `ShapeMinted` already sets the owner for a direct mint, and a
  redeemed/consumed token's owner is no longer meaningful. `decompose` and
  `restore` mint to `msg.sender`, which neither event carries as an
  argument; the indexer takes `event.transaction.from` as that recipient,
  which holds for a direct EOA call.

## ABI

`abis/Shapes.ts` is the curated subset of the compiled ABI
(`out/Shapes.sol/Shapes.json`, built by `forge build` at the repo root) — the
eight events plus the functions and errors the frontend calls. It mirrors the
human-readable signatures in `preview/src/chain/abi.ts` with one addition, the
`InkGene` event, which the indexer decodes but the frontend does not (the
frontend reads the gene from the tokenURI "Ink" trait). It is extracted from
the compiled artifact rather than hand-transcribed, so field names, types, and
`indexed` flags are guaranteed to match the deployed bytecode. Regenerate it if
`Shapes.sol`'s events change: rebuild the contract (`forge build` at the repo
root), then re-filter `out/Shapes.sol/Shapes.json`'s `abi` array down to the
entries listed in `preview/src/chain/abi.ts`, plus `InkGene`.

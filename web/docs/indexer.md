# Indexer

The repository ships a Ponder indexer, in `indexer/`, that follows the mainnet deployment and serves token state, lineage and an activity feed over GraphQL. Run your own copy for any integration that needs the collection without an RPC call per token. The instance behind shapes.ripe.wtf is the site's own backend, reached only through the site, and is not a public API.

The GraphQL server accepts `POST` with `{"query": "…"}` and serves a GraphiQL page on `GET`. Every list query takes `where`, `orderBy`, `orderDirection`, `limit`, `after` and `before`; results come back as `{ items, pageInfo { hasNextPage endCursor } }`. `bigint` columns are strings.

## Tables

### `token`

One row per id ever issued; rows are never deleted. `live` is false after redemption, burn, split or compose, and true again if decompose revives the id.

| Field | Meaning |
| --- | --- |
| `id`, `seed`, `owner`, `live` | Identity and current holder |
| `denomIndex`, `backingWei`, `originCount`, `inkGene`, `isBlack` | Current protocol state |
| `composeDepth` | Records on the compose stack |
| `modules` | Stored `ModuleCodec` bytes, null when seed-derived |
| `splitFromDenom`, `splitOriginDenom` | Split provenance, null for a token not minted by split |
| `mintDenomIndex`, `mintedAtBlock`, `mintedAt`, `mintTxHash` | Creation facts, fixed |

```graphql
{ tokens(where: { live: true, denomIndex: 4 }, orderBy: "id", orderDirection: "desc", limit: 50) {
    items { id seed owner originCount inkGene composeDepth modules }
    pageInfo { hasNextPage endCursor } } }
```

### `lineage_edge`

One row per parent-child step. `parentId` is the surviving or continuing token, `childId` the token consumed into it or produced from it.

| `kind` | Meaning |
| --- | --- |
| `continuation` | Compose: `childId` was burned into `parentId` |
| `split` | Split: `childId` was minted from `parentId` |
| `revival` | Decompose: `childId` was restored from `parentId` |

Each edge carries `childSeed`, `parentDenomIndex`, `childMintDenomIndex`, `block`, `logIndex`, `timestamp` and `txHash`, so a burned child can be rendered from the edge alone.

```graphql
{ lineageEdges(where: { parentId: "12" }, orderBy: "block", orderDirection: "asc") {
    items { kind childId childSeed childMintDenomIndex txHash } } }
```

### `activity`

One row per protocol event, plus the auction house events that move a Shape. `orderKey` is `blockNumber << 32 | logIndex`, so one sort on it reproduces chain order.

| Field | Meaning |
| --- | --- |
| `kind` | `mint`, `compose`, `decompose`, `split`, `redeem`, `burnBacking`, `ownerTokenMoved`, `transfer`, `auctionCreated`, `bid`, `auctionSettled`, `lotClaimed` |
| `tokenIds` | Every Shape the event touched, in a per-kind order: the survivor then inputs for compose and decompose, the burned input then children for split, every minted id for a mint |
| `actor` | Recipient of a mint, redeemer of a redeem, sender of a transfer, bidder or seller or winner on an auction event, transaction sender otherwise |
| `counterparty` | Transfer recipient, else null |
| `amountWei` | Backing minted, redeemed or burned, else null |
| `auctionId`, `units` | Auction facts, `units` in 0.01 ETH |
| `blockNumber`, `logIndex`, `orderKey`, `timestamp`, `txHash` | Position on chain |

A mint transaction is one row keyed `<txHash>-mint` listing every id it minted; every other row is keyed `<txHash>-<logIndex>`.

```graphql
{ activitys(orderBy: "orderKey", orderDirection: "desc", limit: 50) {
    items { kind tokenIds actor amountWei blockNumber txHash timestamp }
    pageInfo { hasNextPage endCursor } } }
```

### `collection_owner`

A single row: `ownerTokenId` and `ownerAddress`, both null once the owner token is gone.

### `auction_lot` and `escrowed_card`

The Shape each auction escrows as its lot, and every card moved into the house's custody keyed by transaction, so a bid row can list the cards it escrowed.

## Freshness

`_meta { status }` reports the indexed block. A token page or feed that needs the current block should read the chain for that one value and the indexer for everything else.

## Running your own

```bash
cd indexer
cp .env.example .env.local     # RPC URL for chain 1
npm install
npm run dev                    # http://localhost:42069/graphql
```

`ponder.config.ts` reads the deployment record for the contract addresses and start block. Handlers live in `src/`; the schema in `ponder.schema.ts` is the source of truth for the fields above.

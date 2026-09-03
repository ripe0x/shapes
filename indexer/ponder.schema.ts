import { index, onchainTable } from "ponder";

// One row per live-or-dead token id ever minted. A token stops being `live` on redemption,
// split, or composition into a survivor; decompose may revive a consumed id. Rows are never
// deleted, so history stays queryable.
export const token = onchainTable(
  "token",
  (t) => ({
    id: t.bigint().primaryKey(),
    seed: t.hex().notNull(),
    denomIndex: t.integer().notNull(),
    backingWei: t.bigint().notNull(),
    originCount: t.integer().notNull(),
    // Number of compose records currently stacked on this token. A split child begins at zero;
    // compose increments its survivor and decompose decrements it. Consumed inputs retain their
    // own depth while dead so a later revival restores the exact state without an RPC read.
    composeDepth: t.integer().notNull().default(0),
    // Ink gene (0..6). Assigned at mint and reassigned on every recomposition, always by a
    // separate InkGene event emitted right after the structural event; the default holds only
    // for the instant between the two within one transaction.
    inkGene: t.integer().notNull().default(0),
    // Materialized module geometry from ModulesSampled: set on compose (survivor), split
    // (each child) and decompose (survivor restore, each re-minted input). Null means
    // seed-derived geometry (grammar v1); an original mint never emits ModulesSampled, so its
    // row keeps this null.
    modules: t.hex(),
    isBlack: t.boolean().notNull().default(false),
    live: t.boolean().notNull().default(true),
    // Split creation provenance, mirroring the contract's `splitOriginRef`/`SplitRecord`:
    // `splitFromDenom` is the immediate parent's denomination index at the split,
    // `splitOriginDenom` the root split ancestor's. Both null for a token not minted by a split.
    // Written once at the split and never cleared, so a later compose or revival keeps them, the
    // same way `splitOriginRef` survives `delete _store.shapes[tokenId]`.
    splitFromDenom: t.integer(),
    splitOriginDenom: t.integer(),
    owner: t.hex().notNull(),
    // Denomination index at mint, and the mint block's timestamp. Both are fixed at creation
    // while `denomIndex` and `backingWei` track the token's current state, so a history view can
    // name the denomination a token was born at without a chain read.
    mintDenomIndex: t.integer().notNull(),
    mintedAtBlock: t.bigint().notNull(),
    mintedAt: t.bigint().notNull(),
    mintTxHash: t.hex().notNull(),
  }),
  (table) => ({
    // Gallery queries: live tokens filtered by denomination, newest first.
    denomLiveIdx: index("token_denom_live_idx").on(table.denomIndex, table.live),
    ownerIdx: index("token_owner_idx").on(table.owner),
    mintedAtBlockIdx: index("token_minted_at_block_idx").on(table.mintedAtBlock),
  }),
);

// Single row tracking the collection owner token (issue #56): exactly one live Shape can be the
// owner token at a time, moved by compose, decompose, split, and ended by redeem/burn. Keyed by
// a constant id since there is never more than one row. `ownerTokenId`/`ownerAddress` are both
// null when no token holds ownership (after the owner token is redeemed or burned).
export const collectionOwner = onchainTable("collection_owner", (t) => ({
  id: t.text().primaryKey(),
  ownerTokenId: t.bigint(),
  ownerAddress: t.hex(),
  updatedAtBlock: t.bigint().notNull(),
}));

// One row per parent-child step in a token's provenance, emitted by compose, decompose, and
// `parentId` is the surviving/continuing token; `childId` is the token consumed into it
// (continuation) or produced from it (split). `childSeed` is the child's seed at the
// time of the edge, so a burned child can still be rendered from a lineage query alone.
export const lineageEdge = onchainTable(
  "lineage_edge",
  (t) => ({
    // tx hash + log index + per-edge position within the event: unique across every edge a
    // single event can emit (compose/decompose each loop over an id array).
    id: t.text().primaryKey(),
    childId: t.bigint().notNull(),
    parentId: t.bigint().notNull(),
    kind: t.text().notNull(), // "continuation" | "split" | "revival"
    childSeed: t.hex().notNull(),
    // The parent's denomination index after the event: the compose survivor's summed
    // denomination, the decompose survivor's restored one, the split parent's pre-split one.
    parentDenomIndex: t.integer().notNull(),
    block: t.bigint().notNull(),
    // Log index of the event the edge came from, and the block's timestamp. Edges sharing both a
    // transaction hash and a log index came from one compose, split, or decompose.
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    // "direct contributors of token X": edges where parentId = X.
    parentIdx: index("lineage_edge_parent_idx").on(table.parentId),
    // "what did token X become": edges where childId = X.
    childIdx: index("lineage_edge_child_idx").on(table.childId),
  }),
);

// One row per BidPlaced log. `units` is the bidder's running escrowed total after the bid, the
// value the event carries, not the increment.
export const bid = onchainTable(
  "bid",
  (t) => ({
    // tx hash + log index: unique per BidPlaced log.
    id: t.text().primaryKey(),
    auctionId: t.bigint().notNull(),
    bidder: t.hex().notNull(),
    units: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    auctionIdx: index("bid_auction_idx").on(table.auctionId),
  }),
);

// One row per Shape moved into the auction house's custody, keyed by transaction so a bid can
// list the cards its own transaction escrowed. `denomIndex` is the card's denomination at the
// time it entered, which stays readable after the card is later composed, split, or redeemed.
export const escrowedCard = onchainTable(
  "escrowed_card",
  (t) => ({
    // tx hash + token id: a transaction escrows each card at most once.
    id: t.text().primaryKey(),
    txHash: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    denomIndex: t.integer().notNull(),
  }),
  (table) => ({
    txIdx: index("escrowed_card_tx_idx").on(table.txHash),
  }),
);

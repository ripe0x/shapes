import { index, onchainTable } from "ponder";

// One row per live-or-dead token id ever minted. A token stops being `live` on redemption,
// composition into a survivor, decomposition, or restore-consumption; it is never deleted, so
// history stays queryable.
export const token = onchainTable(
  "token",
  (t) => ({
    id: t.bigint().primaryKey(),
    seed: t.hex().notNull(),
    denomIndex: t.integer().notNull(),
    backingWei: t.bigint().notNull(),
    originCount: t.integer().notNull(),
    // Ink gene (0..6). Assigned at mint and reassigned on every recomposition, always by a
    // separate InkGene event emitted right after the structural event; the default holds only
    // for the instant between the two within one transaction.
    inkGene: t.integer().notNull().default(0),
    isBlack: t.boolean().notNull().default(false),
    live: t.boolean().notNull().default(true),
    owner: t.hex().notNull(),
    mintedAtBlock: t.bigint().notNull(),
    mintTxHash: t.hex().notNull(),
  }),
  (table) => ({
    // Gallery queries: live tokens filtered by denomination, newest first.
    denomLiveIdx: index("token_denom_live_idx").on(table.denomIndex, table.live),
    ownerIdx: index("token_owner_idx").on(table.owner),
    mintedAtBlockIdx: index("token_minted_at_block_idx").on(table.mintedAtBlock),
  }),
);

// One row per parent-child step in a token's provenance, emitted by compose, decompose, and
// restore. `parentId` is the surviving/continuing token; `childId` is the token consumed into it
// (continuation, restore) or produced from it (split). `childSeed` is the child's seed at the
// time of the edge, so a burned child can still be rendered from a lineage query alone.
export const lineageEdge = onchainTable(
  "lineage_edge",
  (t) => ({
    // tx hash + log index + per-edge position within the event: unique across every edge a
    // single event can emit (compose/decompose/restore each loop over an id array).
    id: t.text().primaryKey(),
    childId: t.bigint().notNull(),
    parentId: t.bigint().notNull(),
    kind: t.text().notNull(), // "continuation" | "split" | "restore"
    childSeed: t.hex().notNull(),
    block: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    // "direct contributors of token X": edges where parentId = X.
    parentIdx: index("lineage_edge_parent_idx").on(table.parentId),
    // "what did token X become": edges where childId = X.
    childIdx: index("lineage_edge_child_idx").on(table.childId),
  }),
);

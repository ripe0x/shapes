// The real `ShapeDataSource`, backed by the Ponder-managed database. Kept apart from
// shapeData.ts's interface so routes.ts and its tests never import "ponder:api" directly; that
// module only resolves inside Ponder's own runtime (dev/build/start), not under plain `node --test`.

import { and, arrayContains, desc, eq, inArray } from "drizzle-orm";
import { db } from "ponder:api";
import schema from "ponder:schema";
import type { ShapeDataSource, ShapeRow } from "./shapeData";

function toShapeRow(row: typeof schema.token.$inferSelect): ShapeRow {
  return {
    id: row.id,
    seed: row.seed,
    denomIndex: row.denomIndex,
    backingWei: row.backingWei,
    originCount: row.originCount,
    composeDepth: row.composeDepth,
    inkGene: row.inkGene,
    modules: row.modules ?? null,
    isBlack: row.isBlack,
    live: row.live,
    owner: row.owner,
  };
}

export const ponderShapeData: ShapeDataSource = {
  async getToken(id) {
    const rows = await db.select().from(schema.token).where(eq(schema.token.id, id)).limit(1);
    return rows[0] ? toShapeRow(rows[0]) : null;
  },

  async getTokens(ids) {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(schema.token)
      .where(inArray(schema.token.id, ids as bigint[]));
    return rows.map(toShapeRow);
  },

  async getTokensByOwner(owner, limit) {
    const rows = await db
      .select()
      .from(schema.token)
      .where(and(eq(schema.token.owner, owner), eq(schema.token.live, true)))
      .orderBy(desc(schema.token.mintedAtBlock))
      .limit(limit);
    return rows.map(toShapeRow);
  },

  async latestVersion(id) {
    const rows = await db
      .select({ orderKey: schema.activity.orderKey })
      .from(schema.activity)
      .where(arrayContains(schema.activity.tokenIds, [id]))
      .orderBy(desc(schema.activity.orderKey))
      .limit(1);
    return rows[0]?.orderKey ?? null;
  },

  async latestIndexedBlock() {
    const rows = await db
      .select({ blockNumber: schema.activity.blockNumber })
      .from(schema.activity)
      .orderBy(desc(schema.activity.orderKey))
      .limit(1);
    return rows[0]?.blockNumber ?? null;
  },
};

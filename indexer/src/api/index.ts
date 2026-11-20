import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { and, asc, client, eq, gte, graphql, lte, sql } from "ponder";
import { requireToken } from "./auth";
import { checkpointBlock } from "../lib/balancerLog";

// Auto-generated GraphQL over the token/lineageEdge tables (query shape documented in
// README.md), and the raw SQL-over-HTTP endpoint used by @ponder/client for typed queries from
// the frontend without hand-rolled REST routes. Both sit behind the INDEXER_TOKEN bearer gate
// when that variable is set; see auth.ts.
const app = new Hono();

app.use("/graphql", requireToken, graphql({ db, schema }));
app.use("/sql/*", requireToken, client({ db, schema }));

// Shapes Pool Balancer routes, read by the pool dashboard straight from the browser. Public chain
// data only, so no bearer gate (a static site cannot hold the token) and any origin may read.
app.use("/balancer/*", cors({ origin: "*", allowMethods: ["GET"] }));

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Block the indexer has fully processed. Read before the rows, so every event at or below it is
// already written; rows past it are dropped and the caller fetches from throughBlock + 1.
async function throughBlock(): Promise<number> {
  const rows = (await db.execute(sql`select latest_checkpoint from _ponder_checkpoint`)) as unknown as
    | { rows: { latest_checkpoint: string }[] }
    | { latest_checkpoint: string }[];
  const list = Array.isArray(rows) ? rows : rows.rows;
  if (list.length !== 1) throw new Error(`expected one chain checkpoint, got ${list.length}`);
  return checkpointBlock(list[0]!.latest_checkpoint);
}

// Balancers whose current creator is `creator` (created by it, or transferred to it last).
// Without `creator`, every Balancer.
app.get("/balancer/pools", async (c) => {
  const creator = c.req.query("creator");
  if (creator !== undefined && !ADDRESS.test(creator)) return c.json({ error: "invalid creator" }, 400);
  const through = await throughBlock();
  const rows = await db
    .select()
    .from(schema.balancer)
    .where(
      and(
        creator ? eq(schema.balancer.creator, creator.toLowerCase() as `0x${string}`) : undefined,
        lte(schema.balancer.createdAtBlock, BigInt(through)),
      ),
    )
    .orderBy(asc(schema.balancer.createdAtBlock));
  return c.json({
    throughBlock: through,
    pools: rows.map((r) => ({
      balancer: r.id,
      pool: r.pool,
      creator: r.creator,
      createdAtBlock: Number(r.createdAtBlock),
      creatorUpdatedAtBlock: Number(r.creatorUpdatedAtBlock),
    })),
  });
});

// Every indexed event one Balancer (or the factory) emitted, in chain order, from `fromBlock`.
app.get("/balancer/logs", async (c) => {
  const address = c.req.query("address");
  const fromBlock = c.req.query("fromBlock") ?? "0";
  if (!address || !ADDRESS.test(address)) return c.json({ error: "invalid address" }, 400);
  if (!/^\d{1,15}$/.test(fromBlock)) return c.json({ error: "invalid fromBlock" }, 400);
  const through = await throughBlock();
  // ponytail: unpaginated; a pool's lifetime ledger is thousands of rows. Page by fromBlock if one outgrows a response.
  const rows = await db
    .select()
    .from(schema.balancerLog)
    .where(
      and(
        eq(schema.balancerLog.address, address.toLowerCase() as `0x${string}`),
        gte(schema.balancerLog.blockNumber, BigInt(fromBlock)),
        lte(schema.balancerLog.blockNumber, BigInt(through)),
      ),
    )
    .orderBy(asc(schema.balancerLog.blockNumber), asc(schema.balancerLog.logIndex));
  return c.json({
    throughBlock: through,
    logs: rows.map((r) => ({
      address: r.address,
      eventName: r.eventName,
      blockNumber: Number(r.blockNumber),
      logIndex: r.logIndex,
      txHash: r.txHash,
      args: r.args,
    })),
  });
});

export default app;

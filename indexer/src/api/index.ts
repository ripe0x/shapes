import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";
import { requireToken } from "./auth";

// Auto-generated GraphQL over the token/lineageEdge tables (query shape documented in
// README.md), and the raw SQL-over-HTTP endpoint used by @ponder/client for typed queries from
// the frontend without hand-rolled REST routes. Both sit behind the INDEXER_TOKEN bearer gate
// when that variable is set; see auth.ts.
const app = new Hono();

app.use("/graphql", requireToken, graphql({ db, schema }));
app.use("/sql/*", requireToken, client({ db, schema }));

export default app;

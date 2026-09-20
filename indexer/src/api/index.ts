import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";
import { requireToken } from "./auth";
import { createShapeRoutes } from "./routes";
import { ponderShapeData } from "./ponderShapeData";
import { CONFIGURED_CHAIN_ID } from "../lib/chain";

// Auto-generated GraphQL over the token/lineageEdge tables (query shape documented in
// README.md), and the raw SQL-over-HTTP endpoint used by @ponder/client for typed queries from
// the frontend without hand-rolled REST routes. Both sit behind the INDEXER_TOKEN bearer gate
// when that variable is set; see auth.ts.
const app = new Hono();

app.use("/graphql", requireToken, graphql({ db, schema }));
app.use("/sql/*", requireToken, client({ db, schema }));

// The public v1 art/metadata/value routes (README.md "Public v1 routes"): open, CORS-enabled,
// rate limited per IP, no bearer token. Rendering reads only the indexed row, never the chain.
app.route("/", createShapeRoutes(ponderShapeData, CONFIGURED_CHAIN_ID));

export default app;

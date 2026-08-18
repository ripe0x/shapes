import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

// Auto-generated GraphQL over the token/lineageEdge tables (query shape documented in
// README.md), and the raw SQL-over-HTTP endpoint used by @ponder/client for typed queries from
// the frontend without hand-rolled REST routes.
const app = new Hono();

app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

export default app;

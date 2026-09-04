import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import { requireToken } from "./auth.ts";

const app = new Hono();
app.use("/graphql", requireToken);
app.all("/graphql", (c) => c.json({ data: { ok: true } }));

const originalToken = process.env.INDEXER_TOKEN;
after(() => {
  if (originalToken === undefined) delete process.env.INDEXER_TOKEN;
  else process.env.INDEXER_TOKEN = originalToken;
});

test("no token configured: the endpoint stays open", async () => {
  delete process.env.INDEXER_TOKEN;
  const response = await app.request("/graphql");
  assert.equal(response.status, 200);
});

test("token configured: a request with no Authorization header is rejected", async () => {
  process.env.INDEXER_TOKEN = "s3cret-token";
  const response = await app.request("/graphql");
  assert.equal(response.status, 401);
});

test("token configured: a wrong bearer is rejected", async () => {
  process.env.INDEXER_TOKEN = "s3cret-token";
  const response = await app.request("/graphql", {
    headers: { authorization: "Bearer wrong-token-x" },
  });
  assert.equal(response.status, 401);
});

test("token configured: the correct bearer passes", async () => {
  process.env.INDEXER_TOKEN = "s3cret-token";
  const response = await app.request("/graphql", {
    headers: { authorization: "Bearer s3cret-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { ok: true } });
});

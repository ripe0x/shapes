import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { ShapesApi, ShapesApiError } from "./client.ts";

// A local Hono instance implementing the documented v1 contract (indexer/README.md "Public v1
// routes"), exercised in-process via `app.request` through an injected `fetch`. This tests the
// client's request shaping and response parsing against a real HTTP surface without a socket;
// indexer/src/api/routes.test.ts covers the server side of the same contract.
const SHAPE_1 = {
  chainId: 11155111,
  id: "1",
  seed: `0x${"aa".repeat(32)}`,
  denomIndex: 4,
  denomination: "1 ETH",
  backingWei: "1000000000000000000",
  originCount: 1,
  composeDepth: 0,
  inkGene: 3,
  modules: null,
  isBlack: false,
  live: true,
  owner: "0x1111111111111111111111111111111111111111",
  version: "100",
  artUrl: "https://api.shapes.ripe.wtf/v1/11155111/shape/1/100.svg",
};

function fixtureApp(): Hono {
  const app = new Hono();
  app.get("/v1/:chainId/shape/:idExt", (c) => {
    if (c.req.param("idExt") === "1.json") return c.json(SHAPE_1);
    return c.json({ errors: [{ message: "not found" }] }, 404);
  });
  app.get("/v1/:chainId/shapes", (c) => {
    const ids = c.req.query("ids");
    const owner = c.req.query("owner");
    if (ids === "1" || owner === SHAPE_1.owner) {
      return c.json({ chainId: 11155111, shapes: [SHAPE_1] });
    }
    return c.json({ chainId: 11155111, shapes: [] });
  });
  return app;
}

function clientAgainst(app: Hono): ShapesApi {
  return new ShapesApi({
    baseUrl: "http://local.test",
    fetch: (input, init) => Promise.resolve(app.request(input as string, init)),
  });
}

test("shape() parses a found token", async () => {
  const client = clientAgainst(fixtureApp());
  const shape = await client.shape(11155111, 1);
  assert.deepEqual(shape, SHAPE_1);
});

test("shape() throws ShapesApiError with the status on a 404", async () => {
  const client = clientAgainst(fixtureApp());
  await assert.rejects(() => client.shape(11155111, 999), (err: unknown) => {
    assert.ok(err instanceof ShapesApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

test("shapes() by ids sends a comma-joined list and returns the rows", async () => {
  const client = clientAgainst(fixtureApp());
  const shapes = await client.shapes(11155111, { ids: [1] });
  assert.deepEqual(shapes, [SHAPE_1]);
});

test("shapes() by owner sends the owner query param", async () => {
  const client = clientAgainst(fixtureApp());
  const shapes = await client.shapes(11155111, { owner: SHAPE_1.owner as `0x${string}` });
  assert.deepEqual(shapes, [SHAPE_1]);
});

test("artUrl builds the versioned svg url with no network call", () => {
  const client = new ShapesApi({ baseUrl: "https://api.shapes.ripe.wtf" });
  assert.equal(client.artUrl(11155111, 1, 100), "https://api.shapes.ripe.wtf/v1/11155111/shape/1/100.svg");
});

test("the default base url is the public edge hostname", async () => {
  let requestedUrl = "";
  const client = new ShapesApi({
    fetch: (input) => {
      requestedUrl = String(input);
      return Promise.resolve(Response.json(SHAPE_1));
    },
  });
  await client.shape(11155111, 1);
  assert.equal(requestedUrl, "https://api.shapes.ripe.wtf/v1/11155111/shape/1.json");
});

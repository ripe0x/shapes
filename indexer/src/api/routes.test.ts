import assert from "node:assert/strict";
import { test } from "node:test";
import { createShapeRoutes } from "./routes.ts";
import type { ShapeDataSource, ShapeRow } from "./shapeData.ts";

const CHAIN_ID = 11155111;

const ALICE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const BOB = "0x2222222222222222222222222222222222222222" as `0x${string}`;

// Representative rows: a plain seed-derived mint, a composed token carrying materialized module
// bytes, and a Black Shape. Seeds are arbitrary 32-byte values; the renderer accepts any seed and
// produces a deterministic composition from it, which is all these route tests need — byte parity
// against the deployed contract is exercised separately (parity.test.ts).
const ROWS: Record<string, ShapeRow> = {
  "1": {
    id: 1n,
    seed: `0x${"aa".repeat(32)}`,
    denomIndex: 4, // 1 ETH -> 3x3 grid
    backingWei: 1_000_000_000_000_000_000n,
    originCount: 1,
    composeDepth: 0,
    inkGene: 3,
    modules: null,
    isBlack: false,
    live: true,
    owner: ALICE,
  },
  "2": {
    id: 2n,
    seed: `0x${"bb".repeat(32)}`,
    denomIndex: 6, // 10 ETH -> 2x2 grid, 4 modules
    backingWei: 10_000_000_000_000_000_000n,
    originCount: 3,
    composeDepth: 1,
    inkGene: 5,
    // 4 module bytes: kind index 0 (circle), not solid, rotation 0 -> byte 0x00, repeated.
    modules: "0x00000000",
    isBlack: false,
    live: true,
    owner: BOB,
  },
  "3": {
    id: 3n,
    seed: `0x${"cc".repeat(32)}`,
    denomIndex: 8, // 100 ETH -> 1x1 grid
    backingWei: 0n,
    originCount: 1,
    composeDepth: 0,
    inkGene: 6,
    modules: null,
    isBlack: true,
    live: true,
    owner: ALICE,
  },
};

const VERSIONS: Record<string, bigint> = { "1": 100n, "2": 205n, "3": 9n };

function fakeDataSource(): ShapeDataSource {
  return {
    async getToken(id) {
      return ROWS[id.toString()] ?? null;
    },
    async getTokens(ids) {
      return ids.map((id) => ROWS[id.toString()]).filter((r): r is ShapeRow => r !== undefined);
    },
    async getTokensByOwner(owner, limit) {
      return Object.values(ROWS)
        .filter((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.live)
        .slice(0, limit);
    },
    async latestVersion(id) {
      return VERSIONS[id.toString()] ?? null;
    },
    async latestIndexedBlock() {
      return 4_500_321n;
    },
  };
}

function app() {
  return createShapeRoutes(fakeDataSource(), CHAIN_ID);
}

test("shape.json returns the row, a denomination label, version and artUrl", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/1.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, "1");
  assert.equal(body.chainId, CHAIN_ID);
  assert.equal(body.denomIndex, 4);
  assert.equal(body.denomination, "1 ETH");
  assert.equal(body.backingWei, "1000000000000000000");
  assert.equal(body.owner, ALICE);
  assert.equal(body.live, true);
  assert.equal(body.isBlack, false);
  assert.equal(body.version, "100");
  assert.match(body.artUrl, new RegExp(`/v1/${CHAIN_ID}/shape/1/100\\.svg$`));
});

test("shape.json 404s for an unknown token", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/999.json`);
  assert.equal(res.status, 404);
});

test("shape.svg redirects to the current versioned url with a short cache", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/2.svg`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/v1/${CHAIN_ID}/shape/2/205.svg`);
  assert.equal(res.headers.get("cache-control"), "public, max-age=5");
  assert.equal(res.headers.get("netlify-cdn-cache-control"), "public, max-age=30, stale-while-revalidate=300");
});

test("the versioned svg renders and carries immutable caching, for a materialized token", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/2/205.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("netlify-cdn-cache-control"), "public, max-age=31536000, immutable");
  const svg = await res.text();
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>$/);
});

test("the versioned svg renders a seed-derived (unmaterialized) token", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/1/100.svg`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^<svg/);
});

test("a Black Shape renders inverted (white field) without error", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/3/9.svg`);
  assert.equal(res.status, 200);
  const svg = await res.text();
  assert.match(svg, /fill="#fff"/);
});

test("a stale version segment redirects to the current version rather than rendering", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/2/1.svg`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/v1/${CHAIN_ID}/shape/2/205.svg`);
});

test("shapes?ids= returns rows in the order the data source gives them", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shapes?ids=1,2`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.shapes.map((s: { id: string }) => s.id),
    ["1", "2"],
  );
});

test("shapes?owner= filters by owner", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shapes?owner=${ALICE}`);
  const body = await res.json();
  assert.deepEqual(
    body.shapes.map((s: { id: string }) => s.id).sort(),
    ["1", "3"],
  );
});

test("shapes with neither owner nor ids is a 400", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shapes`);
  assert.equal(res.status, 400);
});

test("health reports the chain id and the latest indexed block, uncached", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("netlify-cdn-cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.chainId, CHAIN_ID);
  assert.equal(body.latestIndexedBlock, "4500321");
});

test("artUrl uses SHAPES_API_PUBLIC_URL when set, in place of the request origin", async (t) => {
  process.env.SHAPES_API_PUBLIC_URL = "https://api.shapes.ripe.wtf";
  t.after(() => {
    delete process.env.SHAPES_API_PUBLIC_URL;
  });
  const res = await app().request(`/v1/${CHAIN_ID}/shape/1.json`);
  const body = await res.json();
  assert.equal(body.artUrl, `https://api.shapes.ripe.wtf/v1/${CHAIN_ID}/shape/1/100.svg`);
});

test("a mismatched chainId is a 404 naming the chain this indexer serves", async () => {
  const res = await app().request(`/v1/1/shape/1.json`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.errors[0].message, new RegExp(`serves chain ${CHAIN_ID}`));
});

test("CORS is open on the v1 routes", async () => {
  const res = await app().request(`/v1/${CHAIN_ID}/shape/1.json`, {
    headers: { origin: "https://example.com" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("rate limiting refuses a client past the per-IP budget", async () => {
  const routes = app();
  let last: Response | undefined;
  for (let i = 0; i < 130; i++) {
    last = await routes.request(`/v1/${CHAIN_ID}/shape/1.json`, {
      headers: { "fly-client-ip": "9.9.9.9" },
    });
  }
  assert.equal(last?.status, 429);
});

/**
 * The public v1 shape routes: art, metadata and value derived entirely from indexed rows, with
 * no chain read anywhere in the request path. `createShapeRoutes` takes its data access and
 * configured chain id as arguments so it is testable against a seeded fake `ShapeDataSource`
 * (routes.test.ts) exactly as it runs against the real indexer database (see index.ts, which
 * wires `ponderShapeData` and `CONFIGURED_CHAIN_ID` in).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { renderShapeSvg, denominationLabel } from "../../../packages/shapes-sdk/src/render/index.ts";
import type { ShapeDataSource, ShapeRow } from "./shapeData.ts";
import { createRateLimiter } from "../lib/rateLimit.ts";

/** 120 requests/minute/IP: generous for a public read API behind Fly's 30-concurrent-request
 *  soft limit per app (fly.*.toml), tight enough to blunt a scraping loop. */
const RATE_LIMIT_PER_IP = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Page size bound for `/shapes`. Neither `owner` nor `ids` is meant to page a whole collection. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

const SVG_CONTENT_TYPE = "image/svg+xml; charset=utf-8";

// Two cache tiers, each set on both headers: `Cache-Control` for any client that reads straight
// from a Fly app, `Netlify-CDN-Cache-Control` for the edge proxy in front of it
// (https://api.shapes.ripe.wtf, see README.md "Public hostname"). Netlify honors its own header
// over a plain Cache-Control at the edge, so both must carry the same intent for the edge cache
// to actually hold what the browser-facing header promises.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=5";
const EDGE_SHORT_CACHE = "public, max-age=30, stale-while-revalidate=300";
const NO_CACHE = "no-store";

function cacheHeaders(cache: string, edgeCache: string): Record<string, string> {
  return { "cache-control": cache, "netlify-cdn-cache-control": edgeCache };
}

function errorBody(message: string): { errors: { message: string }[] } {
  return { errors: [{ message }] };
}

/** The base URL `artUrl` is built against: the configured public hostname when set (what a
 *  client should actually use, since a direct Fly origin is not meant for public traffic once
 *  the edge is live), otherwise the request's own origin (a bare Fly app, or local dev). */
function publicOrigin(requestUrl: string): string {
  const configured = process.env.SHAPES_API_PUBLIC_URL;
  return configured ? configured.replace(/\/$/, "") : new URL(requestUrl).origin;
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // Fly's proxy sets this to the real client address; x-forwarded-for is the fallback for any
  // other front door (including a bare `ponder dev`, where every request shares one bucket).
  return c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function parseTokenId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

async function shapeJson(
  row: ShapeRow,
  chainId: number,
  data: ShapeDataSource,
  origin: string,
): Promise<Record<string, unknown>> {
  const version = (await data.latestVersion(row.id)) ?? 0n;
  return {
    chainId,
    id: row.id.toString(),
    seed: row.seed,
    denomIndex: row.denomIndex,
    denomination: denominationLabel(row.denomIndex),
    backingWei: row.backingWei.toString(),
    originCount: row.originCount,
    composeDepth: row.composeDepth,
    inkGene: row.inkGene,
    modules: row.modules,
    isBlack: row.isBlack,
    live: row.live,
    owner: row.owner,
    version: version.toString(),
    artUrl: `${origin}/v1/${chainId}/shape/${row.id}/${version}.svg`,
  };
}

function svgResponse(row: ShapeRow, version: bigint): Response {
  const svg = renderShapeSvg({
    tokenId: row.id,
    seed: row.seed,
    denomIndex: row.denomIndex,
    inkGene: row.inkGene,
    modules: row.modules,
    isBlack: row.isBlack,
  });
  return new Response(svg, {
    headers: {
      "content-type": SVG_CONTENT_TYPE,
      etag: `"${row.id}-${version}"`,
      ...cacheHeaders(IMMUTABLE_CACHE, IMMUTABLE_CACHE),
    },
  });
}

export function createShapeRoutes(data: ShapeDataSource, chainId: number): Hono {
  const app = new Hono();
  const limiter = createRateLimiter(RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_MS);

  app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET"] }));
  app.use("/v1/*", async (c, next) => {
    if (!limiter.allow(clientIp(c))) {
      return c.json(errorBody("Too many requests"), 429, { "retry-after": "60" });
    }
    return next();
  });

  // Every route below is namespaced by :chainId so a caller's URL always names the chain it
  // expects; a mismatch against this indexer's own configured chain is a 404 naming the chain it
  // actually serves, never a silent wrong-chain answer.
  app.use("/v1/:chainId/*", async (c, next) => {
    const requested = Number(c.req.param("chainId"));
    if (requested !== chainId) {
      return c.json(errorBody(`This indexer serves chain ${chainId}, not ${c.req.param("chainId")}`), 404);
    }
    return next();
  });

  // The Netlify edge (README.md "Public hostname") path-routes `/v1/<chainId>/*` to the matching
  // indexer app but forwards a bare `/health` to whichever backend it is configured with, so a
  // per-chain health check needs a chain-scoped path. Ponder's own server also already reserves
  // the bare `/health`/`/ready`/`/status` paths ahead of this app (see README.md "Access"), so a
  // route registered at plain `/health` here would never be reached.
  app.get("/v1/:chainId/health", async (c) => {
    const block = await data.latestIndexedBlock();
    return c.json(
      { chainId, latestIndexedBlock: block === null ? null : block.toString() },
      200,
      cacheHeaders(NO_CACHE, NO_CACHE),
    );
  });

  // Hono's `:name{regex}` constraint must span the whole path segment (no trailing literal text
  // after the closing brace), so an extension suffix like ".json" cannot sit inside the same
  // constrained segment as the id. `.json` and `.svg` also cannot be two separate routes here:
  // both are the single unconstrained segment "/v1/:chainId/shape/:x", and Hono picks one route
  // per path shape before the handler runs, so a second same-shape route is never reached. One
  // route captures the full "<digits>.<ext>" segment and dispatches on the parsed extension.
  app.get("/v1/:chainId/shape/:idExt", async (c) => {
    const m = /^(\d+)\.(json|svg)$/.exec(c.req.param("idExt"));
    if (!m) return c.json(errorBody("Not found"), 404);
    const [, idStr, ext] = m;
    const id = BigInt(idStr);
    const row = await data.getToken(id);
    if (!row) return c.json(errorBody(`Shape ${id} not found`), 404);

    if (ext === "json") {
      const origin = publicOrigin(c.req.url);
      return c.json(await shapeJson(row, chainId, data, origin), 200, cacheHeaders(SHORT_CACHE, EDGE_SHORT_CACHE));
    }
    const version = (await data.latestVersion(id)) ?? 0n;
    c.header("cache-control", SHORT_CACHE);
    c.header("netlify-cdn-cache-control", EDGE_SHORT_CACHE);
    return c.redirect(`/v1/${chainId}/shape/${id}/${version}.svg`, 302);
  });

  app.get("/v1/:chainId/shape/:id/:versionSvg", async (c) => {
    const id = parseTokenId(c.req.param("id"));
    if (id === null) return c.json(errorBody("Not found"), 404);
    const m = /^(\d+)\.svg$/.exec(c.req.param("versionSvg"));
    if (!m) return c.json(errorBody("Not found"), 404);

    const row = await data.getToken(id);
    if (!row) return c.json(errorBody(`Shape ${id} not found`), 404);

    const current = (await data.latestVersion(id)) ?? 0n;
    const requested = BigInt(m[1]);
    // A version segment older or newer than the token's current state is a stale link: redirect
    // to the current version rather than render mismatched content under an immutable URL, so
    // stale art can never be served as current.
    if (requested !== current) {
      c.header("cache-control", SHORT_CACHE);
      c.header("netlify-cdn-cache-control", EDGE_SHORT_CACHE);
      return c.redirect(`/v1/${chainId}/shape/${id}/${current}.svg`, 302);
    }
    return svgResponse(row, current);
  });

  app.get("/v1/:chainId/shapes", async (c) => {
    const ownerParam = c.req.query("owner");
    const idsParam = c.req.query("ids");
    const limitParam = c.req.query("limit");
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limitParam) || DEFAULT_PAGE_SIZE));

    let rows: ShapeRow[];
    if (idsParam !== undefined) {
      const ids: bigint[] = [];
      for (const part of idsParam.split(",").map((s) => s.trim()).filter(Boolean)) {
        const id = parseTokenId(part);
        if (id === null) return c.json(errorBody(`Invalid token id in ids: ${part}`), 400);
        ids.push(id);
        if (ids.length > MAX_PAGE_SIZE) return c.json(errorBody(`ids exceeds ${MAX_PAGE_SIZE}`), 400);
      }
      rows = await data.getTokens(ids);
    } else if (ownerParam !== undefined) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(ownerParam)) {
        return c.json(errorBody("owner must be a 0x-prefixed 20-byte address"), 400);
      }
      rows = await data.getTokensByOwner(ownerParam.toLowerCase() as `0x${string}`, limit);
    } else {
      return c.json(errorBody("Provide owner or ids"), 400);
    }

    const origin = publicOrigin(c.req.url);
    const shapes = await Promise.all(rows.map((row) => shapeJson(row, chainId, data, origin)));
    return c.json({ chainId, shapes }, 200, cacheHeaders(SHORT_CACHE, EDGE_SHORT_CACHE));
  });

  return app;
}

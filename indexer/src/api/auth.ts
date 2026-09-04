import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Bearer gate for the data endpoints. An unset INDEXER_TOKEN passes every request, which is what
 * local dev and the lifecycle script run against. On a deployed app the token is a Fly secret
 * (`fly secrets set INDEXER_TOKEN=...`), held server-side by the site's /api/indexer proxy.
 *
 * Ponder serves /health, /ready and /status from its own app, outside this middleware, so Fly's
 * health check stays open.
 */
export const requireToken: MiddlewareHandler = async (c, next) => {
  const expected = process.env.INDEXER_TOKEN;
  if (!expected) return next();

  const presented = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Compared constant-time on equal lengths; an unequal length short-circuits before the compare
  // because timingSafeEqual throws on mismatched buffers.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ errors: [{ message: "Unauthorized" }] }, 401);
  }
  return next();
};

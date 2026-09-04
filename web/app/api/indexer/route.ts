import { indexerUpstream } from "../../lib/deployment";

// Same-origin GraphQL proxy for the site's indexer reads. The upstream origin and its bearer
// token stay server-side, so the browser never learns where the Ponder server is or how to
// query it directly. Node runtime: it reads process.env and a deployment record off disk.
export const runtime = "nodejs";

/** Longest query forwarded. The site's largest query (the provenance level walk) is well under
 *  2 KB; anything past this is not one of the site's own reads. */
const MAX_QUERY_LENGTH = 8 * 1024;

/** Upstream budget, above the 8s the site's own client allows so the client aborts first. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** GET responses are cached at the CDN edge: the site polls the activity feed, and every viewer
 *  polls the same handful of queries. */
const GET_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

/** Netlify's cache key ignores the query string unless the response says otherwise, so without
 *  this every GET to the proxy shares one cached body and a gallery query is answered with the
 *  activity feed. `query` alone varies on the whole query string. The Next runtime appends this
 *  directive to the `netlify-vary` header it sets on every response. */
const NETLIFY_VARY = "query";

function error(message: string, status: number, cacheControl: string): Response {
  return Response.json({ errors: [{ message }] }, { status, headers: { "cache-control": cacheControl } });
}

async function forward(
  query: unknown,
  variables: unknown,
  cacheControl: string,
): Promise<Response> {
  const upstream = indexerUpstream();
  if (!upstream) return error("Shapes indexer is not configured", 503, "no-store");
  if (typeof query !== "string" || query.length === 0) {
    return error("Shapes indexer proxy expects a GraphQL query string", 400, "no-store");
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return error("Shapes indexer proxy query is too large", 413, "no-store");
  }
  // The Ponder schema is read-only, so a write or stream operation is never one of the site's
  // reads and is refused rather than forwarded.
  if (/\b(mutation|subscription)\b/.test(query)) {
    return error("Shapes indexer proxy forwards queries only", 400, "no-store");
  }
  if (variables !== undefined && (typeof variables !== "object" || variables === null || Array.isArray(variables))) {
    return error("Shapes indexer proxy expects variables as an object", 400, "no-store");
  }

  let response: Response;
  try {
    response = await fetch(upstream.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(upstream.token ? { authorization: `Bearer ${upstream.token}` } : {}),
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return error("Shapes indexer is unreachable", 502, "no-store");
  }

  // An upstream that answers with anything but JSON (an HTML error page, a proxy notice) is
  // reported as a bad gateway rather than relabelled as JSON for the browser.
  const body = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    return error(`Shapes indexer returned HTTP ${response.status}`, 502, "no-store");
  }
  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
      "netlify-vary": NETLIFY_VARY,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const raw = params.get("variables");
  let variables: unknown;
  if (raw !== null) {
    try {
      variables = JSON.parse(raw);
    } catch {
      return error("Shapes indexer proxy could not parse variables", 400, "no-store");
    }
  }
  return forward(params.get("query"), variables, GET_CACHE);
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return error("Shapes indexer proxy expects a JSON body", 400, "no-store");
  }
  if (typeof payload !== "object" || payload === null) {
    return error("Shapes indexer proxy expects a JSON body", 400, "no-store");
  }
  const { query, variables } = payload as { query?: unknown; variables?: unknown };
  return forward(query, variables, "no-store");
}

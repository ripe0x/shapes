/**
 * The site's Ponder GraphQL client: one bounded, timed-out POST per query, shared by the gallery
 * load, token history, and auction bid history so all three carry the same limits.
 */

export const INDEXER_TIMEOUT_MS = 8_000;
export const MAX_INDEXER_RESPONSE_BYTES = 256 * 1024;

/** The indexer is advisory: a source this far behind the connected chain is rejected. */
export const MAX_INDEXER_LAG_BLOCKS = 2n;

/** Ponder's per-chain sync checkpoint, returned by `_meta { status }` on every query. */
export interface IndexerMeta {
  status?: Record<string, {id: number; block: {number: number}}>;
}

export interface IndexerEnvelope<T> {
  data?: T & {_meta?: IndexerMeta};
  errors?: {message?: string}[];
}

/** GraphQL requests this page has issued, for the dev request counter. */
let requestCount = 0;

export function indexerRequestCount(): number {
  return requestCount;
}

async function readJsonBounded<T>(response: Response): Promise<IndexerEnvelope<T>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INDEXER_RESPONSE_BYTES) {
    throw new Error("Shapes indexer response is too large");
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_INDEXER_RESPONSE_BYTES) {
      throw new Error("Shapes indexer response is too large");
    }
    return JSON.parse(text) as IndexerEnvelope<T>;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_INDEXER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Shapes indexer response is too large");
    }
    text += decoder.decode(value, {stream: true});
  }
  text += decoder.decode();
  return JSON.parse(text) as IndexerEnvelope<T>;
}

/** POSTs one query and returns the envelope. Throws on a transport error, an HTTP error, a GraphQL
 *  error, an oversized body, or a response that outlives `timeoutMs`. */
export async function indexerQuery<T>(
  url: string,
  fetcher: typeof fetch,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number = INDEXER_TIMEOUT_MS,
): Promise<IndexerEnvelope<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Shapes indexer timeout must be positive");
  }
  const endpoint = `${url.replace(/\/$/, "")}/graphql`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  requestCount++;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({query, variables}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Shapes indexer returned HTTP ${response.status}`);
    const payload = await readJsonBounded<T>(response);
    if (payload.errors?.length) {
      throw new Error(payload.errors[0]?.message ?? "Shapes indexer returned an invalid response");
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The indexer's checkpoint for `chainId`, from a query's own `_meta`. Throws when the indexer
 * reports no checkpoint for the connected chain, so a response from an indexer following a
 * different chain is never read as this chain's state.
 */
export function checkpointOf(meta: IndexerMeta | undefined, chainId: number): bigint {
  const statuses = Object.values(meta?.status ?? {});
  const status = statuses.find((candidate) => candidate.id === chainId);
  if (!status || !Number.isSafeInteger(status.block.number) || status.block.number < 0) {
    throw new Error("Shapes indexer does not report a checkpoint for the connected chain");
  }
  return BigInt(status.block.number);
}

/** Throws when the indexer's checkpoint is ahead of the chain head or more than `maximumLag`
 *  blocks behind it. */
export function requireFreshCheckpoint(
  indexedBlock: bigint,
  head: bigint,
  maximumLag: bigint = MAX_INDEXER_LAG_BLOCKS,
): void {
  if (maximumLag < 0n || indexedBlock > head || head - indexedBlock > maximumLag) {
    throw new Error(
      `Shapes indexer is stale: indexed ${indexedBlock}, chain head ${head}, maximum lag ${maximumLag}`,
    );
  }
}

/**
 * One `console.debug` per site load with the JSON-RPC and indexer request totals for the page so
 * far, so a change that reintroduces a per-token chain read is visible without a network panel.
 * Dev builds only: both bundlers replace `process.env.NODE_ENV` with a literal, so the guard is
 * statically true in a production build and the body folds away.
 */
export function logRequestCounts(source: string, rpcRequests: number): void {
  if (process.env.NODE_ENV === "production") return;
  // eslint-disable-next-line no-console
  console.debug(
    `[shapes] site load from ${source}: ${rpcRequests} JSON-RPC requests, ` +
      `${requestCount} indexer queries (page totals)`,
  );
}

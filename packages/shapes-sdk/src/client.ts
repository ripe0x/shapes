/**
 * Typed fetch client for the Shapes indexer's public v1 routes (see indexer/README.md "Public v1
 * routes"). No auth: the v1 routes are open, CORS-enabled and rate limited per IP, unlike the
 * bearer-gated /graphql and /sql/* the indexer also serves.
 */

/** The public edge hostname (indexer/README.md "Public hostname"): a Netlify proxy that
 *  path-routes `/v1/1/*` to the mainnet indexer and `/v1/11155111/*` to Sepolia, and caches
 *  responses at the edge. Override `baseUrl` to talk to one indexer app directly instead
 *  (local dev, or bypassing the edge cache). */
export const DEFAULT_BASE_URL = "https://api.shapes.ripe.wtf";

/** The exact shape of `GET /v1/:chainId/shape/:id.json` and each entry of
 *  `GET /v1/:chainId/shapes`. */
export interface ShapeApiRow {
  chainId: number;
  id: string;
  seed: `0x${string}`;
  denomIndex: number;
  denomination: string;
  backingWei: string;
  originCount: number;
  composeDepth: number;
  inkGene: number;
  modules: `0x${string}` | null;
  isBlack: boolean;
  live: boolean;
  owner: `0x${string}`;
  version: string;
  artUrl: string;
}

export interface ShapesQueryByOwner {
  owner: `0x${string}`;
}

export interface ShapesQueryByIds {
  ids: readonly (bigint | number | string)[];
}

export interface ShapesApiOptions {
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Injectable for tests and non-global-fetch runtimes; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export class ShapesApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ShapesApiError";
    this.status = status;
  }
}

export class ShapesApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShapesApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** `GET /v1/:chainId/shape/:id.json`. Throws {@link ShapesApiError} on a non-2xx response,
   *  including a 404 for an unknown token. */
  async shape(chainId: number, id: bigint | number | string): Promise<ShapeApiRow> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/${chainId}/shape/${id}.json`);
    if (!res.ok) {
      throw new ShapesApiError(`shape(${chainId}, ${id}) failed: HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as ShapeApiRow;
  }

  /** `GET /v1/:chainId/shapes?owner=` or `?ids=`. `limit` bounds an owner query's page size. */
  async shapes(
    chainId: number,
    query: ShapesQueryByOwner | ShapesQueryByIds,
    options?: { limit?: number },
  ): Promise<ShapeApiRow[]> {
    const params = new URLSearchParams();
    if ("owner" in query) {
      params.set("owner", query.owner);
    } else {
      params.set("ids", query.ids.join(","));
    }
    if (options?.limit !== undefined) params.set("limit", String(options.limit));

    const res = await this.fetchImpl(`${this.baseUrl}/v1/${chainId}/shapes?${params.toString()}`);
    if (!res.ok) {
      throw new ShapesApiError(`shapes(${chainId}) failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { shapes: ShapeApiRow[] };
    return body.shapes;
  }

  /** The immutable versioned SVG URL for a token, with no network call. Matches the `artUrl`
   *  field a `.json` response carries for the same `(chainId, id, version)`. */
  artUrl(chainId: number, id: bigint | number | string, version: bigint | number | string): string {
    return `${this.baseUrl}/v1/${chainId}/shape/${id}/${version}.svg`;
  }
}

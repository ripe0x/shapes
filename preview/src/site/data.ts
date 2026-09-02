import {BaseError, ContractFunctionRevertedError, type PublicClient} from "viem";
import {
  shapesAbi,
  DENOMINATIONS,
  denomIndexOf,
  type Deployment,
} from "../chain/abi";
import {geneIndexOfName} from "../previewGene";

export interface TokenMeta {
  name: string;
  description: string;
  attributes: {trait_type: string; value: string}[];
}

export interface SiteToken {
  id: bigint;
  backing: bigint;
  di: number; // denomination index
  seed: bigint;
  owner: `0x${string}`;
  image: string; // svg data URI from tokenURI
  meta: TokenMeta; // the rest of the tokenURI JSON, parsed
  inkGene: number; // stored ink gene, from the tokenURI "Ink" trait
  originCount: number; // direct-mint events credited to the token, from the "Independent Origins" trait
  composeDepth: number; // stacked composes decompose(tokenId) can still reverse
}

/** Ink gene index from a parsed tokenURI's "Ink" trait. */
function geneOfMeta(meta: TokenMeta): number {
  const ink = meta.attributes.find((a) => a.trait_type === "Ink");
  return geneIndexOfName(ink?.value ?? "Murk");
}

/** Origin count from a parsed tokenURI's "Independent Origins" trait. */
function originsOfMeta(meta: TokenMeta): number {
  const v = meta.attributes.find((a) => a.trait_type === "Independent Origins")?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface SiteData {
  tokens: SiteToken[]; // live, including Black Shapes, newest first
  reserve: bigint; // redeemableBacking()
  supply: bigint; // totalSupply()
  fees: bigint[]; // flat mintFee(), repeated per denomination for the selector UI
  artist: `0x${string}` | null;
  artistAttested: boolean;
  /** Null when deployment metadata targets a pre-attribution Shapes contract. */
  artistReleaseHash: `0x${string}` | null;
  /** The live Shape currently holding collection ownership (see `ownerToken()`), or null once it
   *  has been redeemed or burned and no Shape has inherited it. Never derived from a fixed id. */
  ownerToken: bigint | null;
}

/** The indexer is advisory: a source this far behind the connected chain is rejected. */
export const MAX_INDEXER_LAG_BLOCKS = 2n;
export const INDEXER_TIMEOUT_MS = 8_000;
export const MAX_INDEXER_RESPONSE_BYTES = 256 * 1024;

export interface SiteLoadMetrics {
  source: "chain" | "indexer";
  /** JSON/GraphQL requests, not RPC calls. */
  indexerRequests: number;
}

export interface LoadSiteOptions {
  /** Overrides deployment metadata, useful for previews and deterministic integration tests. */
  indexerUrl?: string;
  fetch?: typeof fetch;
  maxIndexerLagBlocks?: bigint;
  /** Primarily for deterministic tests; production uses INDEXER_TIMEOUT_MS. */
  indexerTimeoutMs?: number;
  onMetrics?: (metrics: SiteLoadMetrics) => void;
}

interface IndexedTokenId {
  id: string;
}

interface IndexerPage {
  items: IndexedTokenId[];
  pageInfo: {hasNextPage: boolean; endCursor: string | null};
}

/** Reads the flat fee from the current ABI. The fallback keeps the site usable against the
 *  superseded Sepolia deployment until the fresh flat-fee release is live. */
async function loadMintFees(publicClient: PublicClient, dep: Deployment): Promise<bigint[]> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;
  try {
    const fee = await publicClient.readContract({...shapes, functionName: "mintFee"});
    return DENOMINATIONS.map(() => fee);
  } catch {
    return Promise.all(
      DENOMINATIONS.map((denomination) =>
        publicClient.readContract({
          ...shapes,
          functionName: "mintFeeFor",
          args: [denomination.wei],
        }),
      ),
    );
  }
}

/** Reads the current owner-token id once per site load (alongside `artist`/`reserve`/`supply`,
 *  not on a per-render basis). Null only when the contract reverts `NoOwnerToken`, meaning the
 *  collection has been redeemed or burned. Any other failure (RPC, a deployment predating this
 *  selector) rethrows so the caller's existing load-error handling applies. */
async function loadOwnerToken(
  publicClient: PublicClient,
  shapes: {address: `0x${string}`; abi: typeof shapesAbi},
): Promise<bigint | null> {
  try {
    return await publicClient.readContract({...shapes, functionName: "ownerToken"});
  } catch (e) {
    if (e instanceof BaseError) {
      const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "NoOwnerToken") {
        return null;
      }
    }
    throw e;
  }
}

interface IndexerResponse {
  data?: {
    _meta?: {status?: Record<string, {id: number; block: {number: number}}>};
    tokens?: IndexerPage;
  };
  errors?: {message?: string}[];
}

const INDEXER_PAGE_SIZE = 500;
const INDEXER_QUERY = `query SiteTokens($limit: Int!, $after: String) {
  _meta { status }
  tokens(
    where: { live: true }
    orderBy: "mintedAtBlock"
    orderDirection: "desc"
    limit: $limit
    after: $after
  ) {
    items { id }
    pageInfo { hasNextPage endCursor }
  }
}`;

function parseUri(uri: string): {image: string; meta: TokenMeta} {
  // atob alone maps each byte to a code unit and garbles multi-byte UTF-8 (the module glyphs);
  // decode the byte string properly.
  const bytes = Uint8Array.from(atob(uri.replace("data:application/json;base64,", "")), (c) =>
    c.charCodeAt(0),
  );
  const json = JSON.parse(new TextDecoder().decode(bytes));
  return {
    image: json.image as string,
    meta: {
      name: (json.name as string) ?? "",
      description: (json.description as string) ?? "",
      attributes: ((json.attributes ?? []) as {trait_type: string; value: unknown}[]).map(
        (a) => ({trait_type: a.trait_type, value: String(a.value)}),
      ),
    },
  };
}

// Calls per Multicall3 aggregate (or per concurrent fallback burst). 500 ownerOf calls fit one
// eth_call comfortably; the per-token stage carries tokenURI payloads, so it uses fewer calls
// per chunk (see TOKEN_CHUNK).
const ID_CHUNK = 500;
// Live tokens per per-token chunk. Each token is FIELDS.length calls, and tokenURI returns a
// full SVG data URI, so the returndata per chunk is the binding constraint, not the call count.
const TOKEN_CHUNK = 50;

interface ReadCall {
  address: `0x${string}`;
  abi: typeof shapesAbi;
  functionName: string;
  args: readonly unknown[];
}

type ReadResult = {status: "success"; result: unknown} | {status: "failure"; error: Error};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** True when the client's chain declares a Multicall3 address and code is deployed there. */
async function hasMulticall3(publicClient: PublicClient): Promise<boolean> {
  const address = publicClient.chain?.contracts?.multicall3?.address;
  if (!address) return false;
  const code = await publicClient.getCode({address});
  return code !== undefined && code !== "0x";
}

/**
 * Runs every call and returns per-call results in order. Chunks go through Multicall3 (one
 * eth_call per chunk) when the chain has it, or as concurrent single reads otherwise; all
 * chunks are in flight at once. A reverted call becomes a "failure" result, not a throw.
 */
async function batchRead(
  publicClient: PublicClient,
  calls: ReadCall[],
  viaMulticall: boolean,
  chunkSize: number,
): Promise<ReadResult[]> {
  const parts = await Promise.all(
    chunk(calls, chunkSize).map((part): Promise<ReadResult[]> => {
      if (viaMulticall) {
        // Keep Viem's recursive ABI inference out of this deliberately dynamic batch. The
        // runtime result is normalized to ReadResult immediately below either way.
        const multicall = publicClient.multicall as unknown as (args: {
          contracts: ReadCall[];
          allowFailure: true;
        }) => Promise<ReadResult[]>;
        return multicall({contracts: part, allowFailure: true});
      }
      return Promise.all(
        part.map((call) =>
          publicClient.readContract(call as Parameters<PublicClient["readContract"]>[0]).then(
            (result): ReadResult => ({status: "success", result}),
            (error: Error): ReadResult => ({status: "failure", error}),
          ),
        ),
      );
    }),
  );
  return parts.flat();
}

// Per-token reads, in call order within each token's chunk slice.
const FIELDS = ["backingOf", "seedOf", "isBlack", "tokenURI", "composeDepth"] as const;

async function readJsonBounded(response: Response): Promise<IndexerResponse> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INDEXER_RESPONSE_BYTES) {
    throw new Error("Shapes indexer response is too large");
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_INDEXER_RESPONSE_BYTES) {
      throw new Error("Shapes indexer response is too large");
    }
    return JSON.parse(text) as IndexerResponse;
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
  return JSON.parse(text) as IndexerResponse;
}

async function fetchIndexerPage(
  endpoint: string,
  fetcher: typeof fetch,
  after: string | null,
  timeoutMs: number,
): Promise<IndexerResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Shapes indexer timeout must be positive");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({query: INDEXER_QUERY, variables: {limit: INDEXER_PAGE_SIZE, after}}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Shapes indexer returned HTTP ${response.status}`);
    return await readJsonBounded(response);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIndexedTokens(
  url: string,
  fetcher: typeof fetch,
  chainId: number,
  expectedSupply: bigint,
  timeoutMs: number,
): Promise<{tokens: IndexedTokenId[]; indexedBlock: bigint; requests: number}> {
  const endpoint = `${url.replace(/\/$/, "")}/graphql`;
  const tokens: IndexedTokenId[] = [];
  let after: string | null = null;
  let indexedBlock: bigint | undefined;
  let requests = 0;
  const seenCursors = new Set<string>();
  const maximumPages = expectedSupply === 0n
    ? 1n
    : (expectedSupply + BigInt(INDEXER_PAGE_SIZE - 1)) / BigInt(INDEXER_PAGE_SIZE);

  do {
    requests++;
    if (BigInt(requests) > maximumPages) {
      throw new Error("Shapes indexer returned too many pages");
    }

    const payload = await fetchIndexerPage(endpoint, fetcher, after, timeoutMs);
    if (payload.errors?.length || !payload.data?.tokens || !payload.data._meta?.status) {
      throw new Error(payload.errors?.[0]?.message ?? "Shapes indexer returned an invalid response");
    }

    const statuses = Object.values(payload.data._meta.status);
    const status = statuses.find((candidate) => candidate.id === chainId);
    if (!status || !Number.isSafeInteger(status.block.number) || status.block.number < 0) {
      throw new Error("Shapes indexer does not report a checkpoint for the connected chain");
    }
    const pageBlock = BigInt(status.block.number);
    if (indexedBlock !== undefined && indexedBlock !== pageBlock) {
      throw new Error("Shapes indexer advanced during a paginated gallery read");
    }
    indexedBlock = pageBlock;

    const {items, pageInfo} = payload.data.tokens;
    if (items.length > INDEXER_PAGE_SIZE) {
      throw new Error("Shapes indexer returned an oversized page");
    }
    if (pageInfo.hasNextPage && items.length !== INDEXER_PAGE_SIZE) {
      throw new Error("Shapes indexer returned a short intermediate page");
    }
    if (BigInt(tokens.length + items.length) > expectedSupply) {
      throw new Error("Shapes indexer returned more tokens than totalSupply");
    }
    tokens.push(...items);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    if (pageInfo.hasNextPage && after === null) {
      throw new Error("Shapes indexer returned a page without a cursor");
    }
    if (after !== null && seenCursors.has(after)) {
      throw new Error("Shapes indexer repeated a pagination cursor");
    }
    if (after !== null) seenCursors.add(after);
  } while (after !== null);

  if (indexedBlock === undefined) throw new Error("Shapes indexer returned no checkpoint");
  if (BigInt(tokens.length) !== expectedSupply) {
    throw new Error("Shapes indexer live-token count does not match totalSupply");
  }
  return {tokens, indexedBlock, requests};
}

async function loadSiteHeader(publicClient: PublicClient, dep: Deployment): Promise<Omit<SiteData, "tokens">> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;
  const [reserve, supply, artist, artistReleaseHash, fees, ownerToken] = await Promise.all([
    publicClient.readContract({...shapes, functionName: "redeemableBacking"}),
    publicClient.readContract({...shapes, functionName: "totalSupply"}),
    publicClient
      .readContract({...shapes, functionName: "artist"})
      .then((value) => value as `0x${string}`)
      .catch(() => dep.artist ?? null),
    publicClient
      .readContract({...shapes, functionName: "artistReleaseHash"})
      .then((value) => value as `0x${string}`)
      .catch(() => null),
    loadMintFees(publicClient, dep),
    loadOwnerToken(publicClient, shapes),
  ]);
  const artistAttested =
    artistReleaseHash !== null && artistReleaseHash !== `0x${"00".repeat(32)}`;
  return {
    reserve,
    supply,
    fees,
    artist,
    artistAttested,
    artistReleaseHash,
    ownerToken,
  };
}

/**
 * The indexer supplies only candidate live IDs. Every displayed or actionable field stays a
 * current chain read, so an indexing bug cannot invent ownership, backing, art, or token state.
 */
async function tokensFromIndexer(
  publicClient: PublicClient,
  dep: Deployment,
  ids: bigint[],
): Promise<SiteToken[]> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;
  const viaMulticall = await hasMulticall3(publicClient);
  const rows = await batchRead(
    publicClient,
    ids.flatMap((id) => [
      {...shapes, functionName: "ownerOf", args: [id]},
      ...FIELDS.map((functionName) => ({...shapes, functionName, args: [id]})),
    ]),
    viaMulticall,
    TOKEN_CHUNK,
  );

  const tokens: SiteToken[] = [];
  for (let i = 0; i < ids.length; i++) {
    const row = rows.slice(i * 6, i * 6 + 6);
    const failure = row.find((result) => result.status === "failure");
    if (failure?.status === "failure") throw failure.error;
    const [owner, backing, seed, black, uri, composeDepth] = row.map(
      (result) => (result as {result: unknown}).result,
    );
    const {image, meta} = parseUri(uri as string);
    tokens.push({
      id: ids[i]!,
      backing: backing as bigint,
      di: black ? -1 : denomIndexOf(backing as bigint),
      // Viem decodes bytes32 as a hex string. Normalize it at the chain-data boundary so every
      // renderer receives the bigint promised by SiteToken, regardless of which ID source won.
      seed: BigInt(seed as `0x${string}`),
      owner: owner as `0x${string}`,
      image,
      meta,
      inkGene: geneOfMeta(meta),
      originCount: originsOfMeta(meta),
      composeDepth: Number(composeDepth),
    });
  }
  return tokens.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
}

/**
 * Full chain state the site renders from. Scans token ids 0..totalMinted-1 with batched reads:
 * ownerOf across all ids to find live tokens, then the per-token fields for live ids only.
 * Fine on a dev chain even at SeedDemo scale (10k+ minted ids); a mainnet deployment needs an
 * indexer (or at minimum a deploy-block floor on the log scan in chain/history.ts) before this
 * ships publicly.
 *
 * Black Shapes remain in the gallery. They have zero backing and denomination index -1, but their
 * on-chain tokenURI is still the canonical artwork and should not disappear from public history.
 */
async function loadSiteFromChain(publicClient: PublicClient, dep: Deployment): Promise<SiteData> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;

  const [minted, reserve, supply, artist, artistReleaseHash, viaMulticall, fees, ownerToken] = await Promise.all([
    publicClient.readContract({...shapes, functionName: "totalMinted"}),
    publicClient.readContract({...shapes, functionName: "redeemableBacking"}),
    publicClient.readContract({...shapes, functionName: "totalSupply"}),
    publicClient
      .readContract({...shapes, functionName: "artist"})
      .then((value) => value as `0x${string}`)
      .catch(() => dep.artist ?? null),
    publicClient
      .readContract({...shapes, functionName: "artistReleaseHash"})
      .then((value) => value as `0x${string}`)
      .catch(() => null),
    hasMulticall3(publicClient),
    loadMintFees(publicClient, dep),
    loadOwnerToken(publicClient, shapes),
  ]);

  const artistAttested =
    artistReleaseHash !== null && artistReleaseHash !== `0x${"00".repeat(32)}`;

  const ids = Array.from({length: Number(minted)}, (_, i) => BigInt(i));
  const owners = await batchRead(
    publicClient,
    ids.map((id) => ({...shapes, functionName: "ownerOf", args: [id]})),
    viaMulticall,
    ID_CHUNK,
  );

  // ownerOf reverts for burned ids; those drop out of the live set.
  const live: {id: bigint; owner: `0x${string}`}[] = [];
  ids.forEach((id, i) => {
    const r = owners[i];
    if (r.status === "success") live.push({id, owner: r.result as `0x${string}`});
  });

  const reads = await batchRead(
    publicClient,
    live.flatMap(({id}) => FIELDS.map((functionName) => ({...shapes, functionName, args: [id]}))),
    viaMulticall,
    TOKEN_CHUNK * FIELDS.length,
  );

  const tokens: SiteToken[] = [];
  for (let i = 0; i < live.length; i++) {
    const {id, owner} = live[i];
    const row = reads.slice(i * FIELDS.length, (i + 1) * FIELDS.length);
    const failed = row.find((r) => r.status === "failure");
    if (failed && failed.status === "failure") throw failed.error;
    const [backing, seed, black, uri, composeDepth] = row.map(
      (r) => (r as {result: unknown}).result,
    );
    const {image, meta} = parseUri(uri as string);
    tokens.push({
      id,
      backing: backing as bigint,
      di: black ? -1 : denomIndexOf(backing as bigint),
      seed: BigInt(seed as bigint),
      owner,
      image,
      meta,
      inkGene: geneOfMeta(meta),
      originCount: originsOfMeta(meta),
      composeDepth: Number(composeDepth),
    });
  }

  tokens.sort((a, b) => (a.id > b.id ? -1 : 1));
  return {
    tokens,
    reserve,
    supply,
    fees,
    artist,
    artistAttested,
    artistReleaseHash,
    ownerToken,
  };
}

/**
 * Loads the gallery through an optional Ponder boundary. Any unavailable, malformed, wrong-chain,
 * or stale indexer response falls through to the established raw-RPC path, so this optimisation
 * never becomes the source of truth for user-visible state.
 */
export async function loadSite(
  publicClient: PublicClient,
  dep: Deployment,
  options: LoadSiteOptions = {},
): Promise<SiteData> {
  const url = options.indexerUrl ?? dep.indexerUrl;
  const fetcher = options.fetch ?? globalThis.fetch;

  if (url && fetcher) {
    try {
      const [head, header] = await Promise.all([
        publicClient.getBlockNumber(),
        loadSiteHeader(publicClient, dep),
      ]);
      const indexed = await fetchIndexedTokens(
        url,
        fetcher,
        dep.chainId,
        header.supply,
        options.indexerTimeoutMs ?? INDEXER_TIMEOUT_MS,
      );
      const maximumLag = options.maxIndexerLagBlocks ?? MAX_INDEXER_LAG_BLOCKS;
      if (maximumLag < 0n || indexed.indexedBlock > head || head - indexed.indexedBlock > maximumLag) {
        throw new Error(
          `Shapes indexer is stale: indexed ${indexed.indexedBlock}, chain head ${head}, maximum lag ${maximumLag}`,
        );
      }

      const ids = indexed.tokens.map((row) => BigInt(row.id));
      if (new Set(ids.map(String)).size !== ids.length) {
        throw new Error("Shapes indexer returned duplicate token ids");
      }
      const tokens = await tokensFromIndexer(publicClient, dep, ids);
      options.onMetrics?.({source: "indexer", indexerRequests: indexed.requests});
      return {tokens, ...header};
    } catch {
      // The raw path is deliberately inside this boundary. This includes a renderer RPC failure
      // after a fresh indexer result: mixed snapshots are less safe than one all-chain snapshot.
    }
  }

  const site = await loadSiteFromChain(publicClient, dep);
  options.onMetrics?.({source: "chain", indexerRequests: 0});
  return site;
}

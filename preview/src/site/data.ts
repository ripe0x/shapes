import {BaseError, ContractFunctionRevertedError, hexToBytes, type PublicClient} from "viem";
import {
  shapesAbi,
  DENOMINATIONS,
  denomIndexOf,
  mintFeeOf,
  mintStartOf,
  type Deployment,
} from "../chain/abi";
import {
  CANONICAL,
  DESCRIPTION,
  OWNER_TOKEN_DESCRIPTION,
  composeShape,
  metadataJsonFromComposition,
  svgFromComposition,
  type Composition,
} from "../canonical/render";
import {composeSampledShape} from "../canonical/sampling";
import {geneIndexOfName} from "../previewGene";
import {
  INDEXER_TIMEOUT_MS,
  MAX_INDEXER_LAG_BLOCKS,
  checkpointOf,
  indexerQuery,
  requireFreshCheckpoint,
  type IndexerEnvelope,
  type IndexerMeta,
} from "./indexerClient";

export {INDEXER_TIMEOUT_MS, MAX_INDEXER_LAG_BLOCKS} from "./indexerClient";

export interface TokenMeta {
  name: string;
  description: string;
  /** `trait_type` is absent on a value-only attribute (e.g. the owner token's "Contract Owner"),
   *  which marketplaces render as a plain tag rather than a labeled trait. */
  attributes: {trait_type?: string; value: string}[];
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
  /** `totalMinted()` as of this load. The chain-fallback path uses it as the boundary for an
   *  incremental rescan: ids below it were already scanned, so only `[scannedMinted, totalMinted)`
   *  needs a fresh `ownerOf`. 0 from an indexer-sourced load, forcing a full rescan the first time
   *  a later refresh falls back to the chain (the indexer never walks this id range itself). */
  scannedMinted: bigint;
  /** `dep.chainId` as of this load. The chain-fallback path treats a mismatch against the current
   *  deployment as proof `previous` came from a different chain and discards it; see the reset
   *  check in `loadSiteFromChain`. */
  chainId: number;
  /** `dep.shapes` as of this load, checked the same way as `chainId`. */
  shapes: `0x${string}`;
  /** Hash of block `dep.fromBlock` (or block 0 when `fromBlock` is unset, e.g. a local dev chain)
   *  as of this load. A dev chain restarted from block 0 typically keeps its chainId and, via a
   *  deterministic deployer, often the same `shapes` address too, so `chainId`/`shapes` alone
   *  don't catch it; this block's hash changes on any such restart because it belongs to a fresh
   *  genesis. `"0x0"` from an indexer-sourced load (that path never reads a block), forcing a full
   *  rescan the first time a later refresh falls back to the chain, mirroring `scannedMinted`. */
  genesisHash: `0x${string}`;
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
  /** Unix seconds from the contract's immutable `mintStart()`; 0 means open at deploy. Read once
   *  per site load, not per render; see `mintOpensIn` for the open/countdown computation. */
  mintStart: bigint;
}

/** Fee for denomination `sel`: `SiteData.fees` once `loadSite` completes (chain is authoritative),
 *  seeded from the deployment record's flat fee before that so the mint button need not wait on
 *  the full site load. Null only when neither source has a value yet. */
export function seedFee(
  dep: Pick<Deployment, "mintFeeWei"> | undefined,
  data: Pick<SiteData, "fees"> | null,
  sel: number,
): bigint | null {
  if (data) return data.fees[sel] ?? null;
  return dep ? mintFeeOf(dep) : null;
}

/** Mint-gate start time: `SiteData.mintStart` once loaded, seeded from the deployment record's
 *  readback before that. Matches `seedFee`'s precedence so the gate and the fee flip to chain
 *  truth together. */
export function seedMintStart(
  dep: Pick<Deployment, "mintStart"> | undefined,
  data: Pick<SiteData, "mintStart"> | null,
): bigint {
  if (data) return data.mintStart;
  return dep ? mintStartOf(dep) : 0n;
}


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
  /** Prior snapshot to scan incrementally against on the chain fallback (ignored by the indexer
   *  path). Omit for a full scan, e.g. the first load. */
  previous?: SiteData | null;
  /** Ids the caller knows changed (e.g. just acted on) even if `ownerOf` still reports the same
   *  owner. Both paths read these from the chain: the indexer path so the wallet's own transaction
   *  shows while the indexer is a block behind, the chain fallback so their fields are reread
   *  instead of reusing the cached ones. */
  dirtyIds?: readonly bigint[];
  /** Pause between chunks on the chain scan. Defaults to `CHUNK_DELAY_MS`; tests set 0. */
  chunkDelayMs?: number;
}

/** One `token` row as the indexer's GraphQL serializes it: bigint columns as decimal strings, hex
 *  columns as `0x` strings, integer and boolean columns as themselves. */
interface IndexedToken {
  id: string;
  seed: `0x${string}`;
  denomIndex: number;
  backingWei: string;
  originCount: number;
  composeDepth: number;
  inkGene: number;
  modules: `0x${string}` | null;
  isBlack: boolean;
  owner: `0x${string}`;
  splitFromDenom: number | null;
  splitOriginDenom: number | null;
}

interface IndexerPage {
  items: IndexedToken[];
  pageInfo: {hasNextPage: boolean; endCursor: string | null};
}

/** The flat per-Shape mint fee, repeated per denomination so callers index it like the ladder. */
async function loadMintFees(publicClient: PublicClient, dep: Deployment): Promise<bigint[]> {
  const fee = await publicClient.readContract({
    address: dep.shapes,
    abi: shapesAbi,
    functionName: "mintFee",
  });
  return DENOMINATIONS.map(() => fee);
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

interface IndexerTokensData {
  _meta?: IndexerMeta;
  tokens?: IndexerPage;
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
    items {
      id
      seed
      denomIndex
      backingWei
      originCount
      composeDepth
      inkGene
      modules
      isBlack
      owner
      splitFromDenom
      splitOriginDenom
    }
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
      attributes: ((json.attributes ?? []) as {trait_type?: string; value: unknown}[]).map(
        (a) => ({trait_type: a.trait_type, value: String(a.value)}),
      ),
    },
  };
}

/**
 * A `SiteToken` built from one indexer row, with no chain read. The artwork and metadata are
 * produced by the canonical renderer this repository ports the contract from, taking the same
 * branch `Shapes.tokenURI` takes: materialized module bytes render under grammar v2 and carry the
 * split provenance traits, an empty `modules` renders from the seed and carries none.
 *
 * Throws on a row the renderer rejects (a denomination index off the ladder, an invalid module
 * byte, a gene out of range). `loadSite` treats that as an unusable indexer response and falls
 * back to the chain.
 */
export function siteTokenFromIndexedRow(row: IndexedToken, ownerTokenId: bigint | null): SiteToken {
  const id = BigInt(row.id);
  const seed = BigInt(row.seed);
  const originCount = BigInt(row.originCount);
  const composeDepth = BigInt(row.composeDepth);
  const modules = row.modules && row.modules !== "0x" ? hexToBytes(row.modules) : null;
  const isOwnerToken = ownerTokenId !== null && ownerTokenId === id;
  const description = isOwnerToken ? OWNER_TOKEN_DESCRIPTION : DESCRIPTION;
  // `splitFromDenom`/`splitOriginDenom` reach the renderer only on the sampled branch, matching
  // `Shapes.tokenURI`: a split child always carries materialized bytes.
  const splitFrom =
    modules && row.splitFromDenom !== null && row.splitOriginDenom !== null
      ? {parentDenomIndex: row.splitFromDenom, originDenomIndex: row.splitOriginDenom}
      : undefined;

  const composition: Composition = modules
    ? composeSampledShape(modules, row.denomIndex, row.inkGene)
    : composeShape(seed, DENOMINATIONS[row.denomIndex]!.wei, row.inkGene);
  const svg = svgFromComposition(composition, id, CANONICAL, row.isBlack);
  const json = JSON.parse(
    metadataJsonFromComposition(
      composition,
      svg,
      id,
      originCount,
      row.isBlack,
      row.inkGene,
      composeDepth,
      "Shape ",
      description,
      splitFrom,
      isOwnerToken,
    ),
  ) as {image: string; name: string; description: string; attributes: {trait_type?: string; value: string}[]};

  return {
    id,
    backing: BigInt(row.backingWei),
    di: row.isBlack ? -1 : row.denomIndex,
    seed,
    owner: row.owner,
    image: json.image,
    meta: {name: json.name, description: json.description, attributes: json.attributes},
    inkGene: row.inkGene,
    originCount: row.originCount,
    composeDepth: row.composeDepth,
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

/** Pause between chunks on the chain-scan fallback. Public gateways answer a burst with HTTP 429,
 *  and the whole point of the fallback is that it still completes when the indexer is gone. */
export const CHUNK_DELAY_MS = 60;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs every call and returns per-call results in order. Chunks go through Multicall3 (one
 * eth_call per chunk) when the chain has it, or as single reads otherwise. One chunk is in flight
 * at a time, with `delayMs` between chunks, so a full scan is a paced sequence of requests rather
 * than a burst. A reverted call becomes a "failure" result, not a throw.
 */
async function batchRead(
  publicClient: PublicClient,
  calls: ReadCall[],
  viaMulticall: boolean,
  chunkSize: number,
  delayMs: number,
): Promise<ReadResult[]> {
  const parts = chunk(calls, chunkSize);
  const out: ReadResult[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && delayMs > 0) await delay(delayMs);
    const part = parts[i]!;
    if (viaMulticall) {
      // Keep Viem's recursive ABI inference out of this deliberately dynamic batch. The
      // runtime result is normalized to ReadResult immediately below either way.
      const multicall = publicClient.multicall as unknown as (args: {
        contracts: ReadCall[];
        allowFailure: true;
      }) => Promise<ReadResult[]>;
      out.push(...(await multicall({contracts: part, allowFailure: true})));
      continue;
    }
    for (const call of part) {
      out.push(
        await publicClient.readContract(call as Parameters<PublicClient["readContract"]>[0]).then(
          (result): ReadResult => ({status: "success", result}),
          (error: Error): ReadResult => ({status: "failure", error}),
        ),
      );
    }
  }
  return out;
}

// Per-token reads, in call order within each token's chunk slice.
const FIELDS = ["backingOf", "seedOf", "isBlackShape", "tokenURI", "composeDepth"] as const;

async function fetchIndexedTokens(
  url: string,
  fetcher: typeof fetch,
  chainId: number,
  expectedSupply: bigint,
  timeoutMs: number,
): Promise<{tokens: IndexedToken[]; indexedBlock: bigint; requests: number}> {
  const tokens: IndexedToken[] = [];
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

    const payload: IndexerEnvelope<IndexerTokensData> = await indexerQuery<IndexerTokensData>(
      url,
      fetcher,
      INDEXER_QUERY,
      {limit: INDEXER_PAGE_SIZE, after},
      timeoutMs,
    );
    if (!payload.data?.tokens) {
      throw new Error("Shapes indexer returned an invalid response");
    }

    const pageBlock = checkpointOf(payload.data._meta, chainId);
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
  const [reserve, supply, artist, artistReleaseHash, fees, ownerToken, mintStart] = await Promise.all([
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
    publicClient.readContract({...shapes, functionName: "mintStart"}),
  ]);
  const artistAttested =
    artistReleaseHash !== null && artistReleaseHash !== `0x${"00".repeat(32)}`;
  return {
    // The indexer supplies live ids directly; it never walks the id range, so there is no
    // scanned boundary to record. See the SiteData.scannedMinted doc comment.
    scannedMinted: 0n,
    chainId: dep.chainId,
    shapes: dep.shapes,
    // No block read on this path; see the SiteData.genesisHash doc comment.
    genesisHash: "0x0",
    reserve,
    supply,
    fees,
    artist,
    artistAttested,
    artistReleaseHash,
    ownerToken,
    mintStart,
  };
}

/**
 * Current chain state for a named set of ids: one `ownerOf` plus the per-token fields per id,
 * batched through Multicall3 when the chain has it. An id whose `ownerOf` reverts is burned and is
 * left out of the result. Used for the ids a caller names in `dirtyIds`, which is the set the
 * connected wallet just acted on.
 */
async function readTokensFromChain(
  publicClient: PublicClient,
  dep: Deployment,
  ids: bigint[],
  delayMs: number,
): Promise<SiteToken[]> {
  if (ids.length === 0) return [];
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
    delayMs,
  );

  const width = FIELDS.length + 1;
  const tokens: SiteToken[] = [];
  for (let i = 0; i < ids.length; i++) {
    const row = rows.slice(i * width, i * width + width);
    if (row.some((result) => result.status === "failure")) continue; // burned since
    const [owner, backing, seed, black, uri, composeDepth] = row.map(
      (result) => (result as {result: unknown}).result,
    );
    const {image, meta} = parseUri(uri as string);
    tokens.push({
      id: ids[i]!,
      backing: backing as bigint,
      di: black ? -1 : denomIndexOf(backing as bigint),
      // Viem decodes bytes32 as a hex string. Normalize it at the chain-data boundary so every
      // renderer receives the bigint promised by SiteToken, regardless of which source won.
      seed: BigInt(seed as `0x${string}`),
      owner: owner as `0x${string}`,
      image,
      meta,
      inkGene: geneOfMeta(meta),
      originCount: originsOfMeta(meta),
      composeDepth: Number(composeDepth),
    });
  }
  return tokens;
}

/**
 * Chain state the site renders from when no indexer answers. One request per chunk, paced, so it
 * completes against a rate-limiting public gateway; at 20k minted ids that is minutes rather than
 * seconds, which is the cost of the indexer being down.
 *
 * With no `previous` snapshot (first load), scans every id 0..totalMinted-1: ownerOf across all
 * ids to find live tokens, then the per-token fields for live ids only. With a `previous`
 * snapshot, scans incrementally instead: ownerOf only for ids new since `previous.scannedMinted`
 * plus every id `previous` had live (an owner may have transferred it, or it may have burned),
 * and per-token fields only for ids that are newly live, whose owner changed, or that `dirtyIds`
 * names explicitly (a same-owner state change `ownerOf` alone can't reveal, e.g. compose onto
 * one's own token). Every other previously-live id reuses its cached fields untouched.
 *
 * `previous` is discarded in favor of a full scan when it looks like it came from a different
 * chain (or a reset one wearing the same address) rather than a later state of the same one; see
 * the reset check below and the `SiteData.chainId`/`shapes`/`genesisHash` doc comments.
 *
 * Black Shapes remain in the gallery. They have zero backing and denomination index -1, but their
 * on-chain tokenURI is still the canonical artwork and should not disappear from public history.
 */
async function loadSiteFromChain(
  publicClient: PublicClient,
  dep: Deployment,
  previous: SiteData | null,
  dirtyIds: readonly bigint[],
  delayMs: number,
): Promise<SiteData> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;
  const genesisBlockNumber = dep.fromBlock !== undefined ? BigInt(dep.fromBlock) : 0n;

  const [minted, reserve, supply, artist, artistReleaseHash, viaMulticall, fees, ownerToken, mintStart, genesisBlock] =
    await Promise.all([
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
      publicClient.readContract({...shapes, functionName: "mintStart"}),
      publicClient.getBlock({blockNumber: genesisBlockNumber}),
    ]);
  const genesisHash = genesisBlock.hash as `0x${string}`;

  const artistAttested =
    artistReleaseHash !== null && artistReleaseHash !== `0x${"00".repeat(32)}`;

  // A reset chain (e.g. a dev chain restarted from block 0) can keep the same chainId and, via a
  // deterministic deployer, the same `shapes` address, while `totalMinted` and every token's
  // state are unrelated to what `previous` recorded. Any of these mismatches means `previous`
  // does not describe this chain, so it's discarded in favor of a full scan; see the SiteData
  // field doc comments for what each one catches.
  const resetDetected =
    previous !== null &&
    (minted < previous.scannedMinted ||
      previous.chainId !== dep.chainId ||
      previous.shapes !== dep.shapes ||
      previous.genesisHash !== genesisHash);
  const effectivePrevious = resetDetected ? null : previous;

  const previouslyLive = new Map(effectivePrevious?.tokens.map((t) => [t.id, t] as const) ?? []);
  const scannedMinted = effectivePrevious?.scannedMinted ?? 0n;
  const dirty = new Set(dirtyIds);

  // New ids since the last scan, plus every id previously live: unchanged ids in between never
  // need another ownerOf, since nothing could have made them live or burned them.
  const newIds = Array.from(
    {length: Math.max(0, Number(minted) - Number(scannedMinted))},
    (_, i) => scannedMinted + BigInt(i),
  );
  const checkIds = [...newIds, ...previouslyLive.keys()];

  const owners = await batchRead(
    publicClient,
    checkIds.map((id) => ({...shapes, functionName: "ownerOf", args: [id]})),
    viaMulticall,
    ID_CHUNK,
    delayMs,
  );

  // ownerOf reverts for burned ids; those drop out of the live set.
  const live: {id: bigint; owner: `0x${string}`; isNew: boolean}[] = [];
  checkIds.forEach((id, i) => {
    const r = owners[i];
    if (r.status === "success") {
      live.push({id, owner: r.result as `0x${string}`, isNew: !previouslyLive.has(id)});
    }
  });

  const needsFields = live.filter(({id, owner, isNew}) => {
    if (isNew || dirty.has(id)) return true;
    return previouslyLive.get(id)!.owner !== owner;
  });

  const reads = await batchRead(
    publicClient,
    needsFields.flatMap(({id}) => FIELDS.map((functionName) => ({...shapes, functionName, args: [id]}))),
    viaMulticall,
    TOKEN_CHUNK * FIELDS.length,
    delayMs,
  );

  const freshById = new Map<bigint, SiteToken>();
  for (let i = 0; i < needsFields.length; i++) {
    const {id, owner} = needsFields[i]!;
    const row = reads.slice(i * FIELDS.length, (i + 1) * FIELDS.length);
    const failed = row.find((r) => r.status === "failure");
    if (failed && failed.status === "failure") throw failed.error;
    const [backing, seed, black, uri, composeDepth] = row.map(
      (r) => (r as {result: unknown}).result,
    );
    const {image, meta} = parseUri(uri as string);
    freshById.set(id, {
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

  // A previously-live id with an unchanged owner and no reread keeps its cached fields; only the
  // owner is refreshed unconditionally since it just came back from this load's ownerOf batch.
  const tokens: SiteToken[] = live.map(({id, owner}) => {
    const fresh = freshById.get(id);
    if (fresh) return fresh;
    return {...previouslyLive.get(id)!, owner};
  });

  tokens.sort((a, b) => (a.id > b.id ? -1 : 1));
  return {
    tokens,
    scannedMinted: minted,
    chainId: dep.chainId,
    shapes: dep.shapes,
    genesisHash,
    reserve,
    supply,
    fees,
    artist,
    artistAttested,
    artistReleaseHash,
    ownerToken,
    mintStart,
  };
}

/**
 * Loads the gallery through an optional Ponder boundary. Any unavailable, malformed, wrong-chain,
 * or stale indexer response falls through to the established raw-RPC path, so this optimisation
 * never becomes the source of truth for user-visible state.
 *
 * On the indexer path every per-token field comes from the indexer row, and the artwork and
 * metadata are produced locally by the canonical renderer. The chain is read for the header totals
 * and for the ids in `dirtyIds`: the checkpoint guard rejects an indexer more than
 * `maxIndexerLagBlocks` behind the head, but within that window a row for a token the connected
 * wallet just acted on can still be one block behind, and that is the token the user is watching.
 */
export async function loadSite(
  publicClient: PublicClient,
  dep: Deployment,
  options: LoadSiteOptions = {},
): Promise<SiteData> {
  const url = options.indexerUrl ?? dep.indexerUrl;
  const fetcher = options.fetch ?? globalThis.fetch;
  const delayMs = options.chunkDelayMs ?? CHUNK_DELAY_MS;

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
      requireFreshCheckpoint(indexed.indexedBlock, head, options.maxIndexerLagBlocks ?? MAX_INDEXER_LAG_BLOCKS);

      const ids = indexed.tokens.map((row) => BigInt(row.id));
      if (new Set(ids.map(String)).size !== ids.length) {
        throw new Error("Shapes indexer returned duplicate token ids");
      }
      const byId = new Map(
        indexed.tokens.map((row) => {
          const token = siteTokenFromIndexedRow(row, header.ownerToken);
          return [token.id, token] as const;
        }),
      );

      // The ids the wallet just acted on, read fresh so the user's own transaction shows even
      // while the indexer is a block behind. An id the chain no longer owns has burned and leaves
      // the live set; an id the indexer has not seen yet joins it.
      const dirtyIds = [...new Set(options.dirtyIds ?? [])];
      if (dirtyIds.length > 0) {
        const fresh = await readTokensFromChain(publicClient, dep, dirtyIds, delayMs);
        for (const id of dirtyIds) byId.delete(id);
        for (const token of fresh) byId.set(token.id, token);
      }

      const tokens = [...byId.values()].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
      options.onMetrics?.({source: "indexer", indexerRequests: indexed.requests});
      return {tokens, ...header};
    } catch {
      // The raw path is deliberately inside this boundary. This includes a renderer RPC failure
      // after a fresh indexer result: mixed snapshots are less safe than one all-chain snapshot.
    }
  }

  const site = await loadSiteFromChain(
    publicClient,
    dep,
    options.previous ?? null,
    options.dirtyIds ?? [],
    delayMs,
  );
  options.onMetrics?.({source: "chain", indexerRequests: 0});
  return site;
}

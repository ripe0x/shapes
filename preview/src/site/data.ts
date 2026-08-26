import type {PublicClient} from "viem";
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
  composeDepth: number; // stacked composes decompose(tokenId) can still reverse
}

/** Ink gene index from a parsed tokenURI's "Ink" trait. */
function geneOfMeta(meta: TokenMeta): number {
  const ink = meta.attributes.find((a) => a.trait_type === "Ink");
  return geneIndexOfName(ink?.value ?? "Murk");
}

export interface SiteData {
  tokens: SiteToken[]; // live, non-Black, newest first
  reserve: bigint; // redeemableBacking()
  supply: bigint; // totalSupply()
  fees: bigint[]; // mintFeeFor() per denomination index
  artist: `0x${string}`;
  artistAttested: boolean;
  artistReleaseHash: `0x${string}`;
}

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

/**
 * Full chain state the site renders from. Scans token ids 0..totalMinted-1 with batched reads:
 * ownerOf across all ids to find live tokens, then the per-token fields for live ids only.
 * Fine on a dev chain even at SeedDemo scale (10k+ minted ids); a mainnet deployment needs an
 * indexer (or at minimum a deploy-block floor on the log scan in chain/history.ts) before this
 * ships publicly.
 *
 * Black tokens are skipped: the sacrifice mechanics are out of scope for this site.
 */
export async function loadSite(publicClient: PublicClient, dep: Deployment): Promise<SiteData> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;

  const [minted, reserve, supply, artist, artistReleaseHash, viaMulticall, ...fees] = await Promise.all([
    publicClient.readContract({...shapes, functionName: "totalMinted"}),
    publicClient.readContract({...shapes, functionName: "redeemableBacking"}),
    publicClient.readContract({...shapes, functionName: "totalSupply"}),
    publicClient.readContract({...shapes, functionName: "artist"}),
    publicClient.readContract({...shapes, functionName: "artistReleaseHash"}),
    hasMulticall3(publicClient),
    ...DENOMINATIONS.map((d) =>
      publicClient.readContract({...shapes, functionName: "mintFeeFor", args: [d.wei]}),
    ),
  ]);

  const artistAttested = artistReleaseHash !== `0x${"00".repeat(32)}`;

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
    if (black) continue;
    const {image, meta} = parseUri(uri as string);
    tokens.push({
      id,
      backing: backing as bigint,
      di: denomIndexOf(backing as bigint),
      seed: BigInt(seed as bigint),
      owner,
      image,
      meta,
      inkGene: geneOfMeta(meta),
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
  };
}

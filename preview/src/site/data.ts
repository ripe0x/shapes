import type {PublicClient} from "viem";
import {shapesAbi, DENOMINATIONS, denomIndexOf, type Deployment} from "../chain/abi";
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

/**
 * Full chain state the site renders from. Scans token ids 0..totalMinted-1, which is fine on a
 * dev chain; a mainnet deployment needs an indexer (or at minimum a deploy-block floor on the
 * log scan in chain/history.ts) before this ships publicly.
 *
 * Black tokens are skipped: the sacrifice mechanics are out of scope for this site.
 */
export async function loadSite(publicClient: PublicClient, dep: Deployment): Promise<SiteData> {
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;

  const [minted, reserve, supply, ...fees] = await Promise.all([
    publicClient.readContract({...shapes, functionName: "totalMinted"}),
    publicClient.readContract({...shapes, functionName: "redeemableBacking"}),
    publicClient.readContract({...shapes, functionName: "totalSupply"}),
    ...DENOMINATIONS.map((d) =>
      publicClient.readContract({...shapes, functionName: "mintFeeFor", args: [d.wei]}),
    ),
  ]);

  const tokens: SiteToken[] = [];
  for (let id = 0n; id < minted; id++) {
    let owner: `0x${string}`;
    try {
      owner = await publicClient.readContract({...shapes, functionName: "ownerOf", args: [id]});
    } catch {
      continue; // burned
    }
    const [backing, seed, black, uri, composeDepth] = await Promise.all([
      publicClient.readContract({...shapes, functionName: "backingOf", args: [id]}),
      publicClient.readContract({...shapes, functionName: "seedOf", args: [id]}),
      publicClient.readContract({...shapes, functionName: "isBlack", args: [id]}),
      publicClient.readContract({...shapes, functionName: "tokenURI", args: [id]}),
      publicClient.readContract({...shapes, functionName: "composeDepth", args: [id]}),
    ]);
    if (black) continue;
    const {image, meta} = parseUri(uri);
    tokens.push({
      id,
      backing,
      di: denomIndexOf(backing),
      seed: BigInt(seed),
      owner,
      image,
      meta,
      inkGene: geneOfMeta(meta),
      composeDepth: Number(composeDepth),
    });
  }

  tokens.sort((a, b) => (a.id > b.id ? -1 : 1));
  return {tokens, reserve, supply, fees};
}

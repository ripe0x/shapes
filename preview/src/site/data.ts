import type {PublicClient} from "viem";
import {shapesAbi, DENOMINATIONS, denomIndexOf, type Deployment} from "../chain/abi";

export interface SiteToken {
  id: bigint;
  backing: bigint;
  di: number; // denomination index
  seed: bigint;
  owner: `0x${string}`;
  image: string; // svg data URI from tokenURI
}

export interface SiteData {
  tokens: SiteToken[]; // live, non-Black, newest first
  reserve: bigint; // redeemableBacking()
  supply: bigint; // totalSupply()
  fees: bigint[]; // mintFeeFor() per denomination index
}

function imageOf(uri: string): string {
  const json = JSON.parse(atob(uri.replace("data:application/json;base64,", "")));
  return json.image as string;
}

/**
 * Full chain state the site renders from. Scans token ids 1..totalMinted, which is fine on a
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
  for (let id = 1n; id <= minted; id++) {
    let owner: `0x${string}`;
    try {
      owner = await publicClient.readContract({...shapes, functionName: "ownerOf", args: [id]});
    } catch {
      continue; // burned
    }
    const [backing, seed, black, uri] = await Promise.all([
      publicClient.readContract({...shapes, functionName: "backingOf", args: [id]}),
      publicClient.readContract({...shapes, functionName: "seedOf", args: [id]}),
      publicClient.readContract({...shapes, functionName: "isBlack", args: [id]}),
      publicClient.readContract({...shapes, functionName: "tokenURI", args: [id]}),
    ]);
    if (black) continue;
    tokens.push({id, backing, di: denomIndexOf(backing), seed: BigInt(seed), owner, image: imageOf(uri)});
  }

  tokens.sort((a, b) => (a.id > b.id ? -1 : 1));
  return {tokens, reserve, supply, fees};
}

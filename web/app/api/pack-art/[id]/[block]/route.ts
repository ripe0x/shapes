import {BaseError, ContractFunctionRevertedError} from "viem";
import {safeImageFromTokenURI} from "@shared/site/ogArtwork";
import {packsAbi, packsClientFor, packsDeploymentFor} from "@shared/site/packs";
import {indexerUpstream, serverDeployment} from "../../../../lib/deployment";
import {landingOnly} from "../../../../lib/siteMode";

export const runtime = "nodejs";

const SVG_PREFIX = "data:image/svg+xml;base64,";
const MAX_ID = 2n ** 256n - 1n;

async function exitBlockFor(id: bigint): Promise<bigint | null> {
  const upstream = indexerUpstream();
  if (!upstream) return null;
  const response = await fetch(upstream.url, {
    method: "POST",
    headers: {"content-type": "application/json", ...(upstream.token ? {authorization: `Bearer ${upstream.token}`} : {})},
    body: JSON.stringify({query: `query PackExit($id: BigInt!) {
      activitys(where: {packId: $id, kind_in: ["packUnsealed", "packOpened", "packRedeemed", "packMergedAway"]},
        orderBy: "orderKey", orderDirection: "desc", limit: 1) { items { blockNumber } }
    }`, variables: {id: id.toString()}}),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Pack history unavailable");
  const payload = await response.json() as {data?: {activitys?: {items?: {blockNumber: string}[]}}; errors?: unknown[]};
  if (payload.errors?.length) throw new Error("Pack history unavailable");
  const block = payload.data?.activitys?.items?.[0]?.blockNumber;
  return block && /^\d+$/.test(block) && BigInt(block) > 0n ? BigInt(block) - 1n : null;
}

export async function GET(_request: Request, {params}: {params: Promise<{id: string; block: string}>}) {
  if (landingOnly()) return new Response("Not found", {status: 404});
  const {id: rawId, block: rawBlock} = await params;
  if (!/^\d{1,78}$/.test(rawId) || (rawBlock !== "latest" && rawBlock !== "exit" && !/^\d{1,20}$/.test(rawBlock))) {
    return new Response("Invalid Pack image request", {status: 400});
  }
  const id = BigInt(rawId);
  if (id === 0n || id > MAX_ID) return new Response("Invalid Pack id", {status: 400});

  const dep = serverDeployment();
  const pack = packsDeploymentFor(dep.chainId);
  if (!pack || pack.shapes.toLowerCase() !== dep.shapes.toLowerCase()) {
    return new Response("Pack deployment unavailable", {status: 404});
  }

  try {
    const block = rawBlock === "exit" ? await exitBlockFor(id) : rawBlock === "latest" ? null : BigInt(rawBlock);
    if (rawBlock === "exit" && block === null) return new Response("Pack exit artwork unavailable", {status: 404});
    const uri = await packsClientFor(dep.chainId).readContract({
      address: pack.packs,
      abi: packsAbi,
      functionName: "tokenURI",
      args: [id],
      ...(block === null ? {} : {blockNumber: block}),
    });
    const image = safeImageFromTokenURI(uri);
    if (!image) return new Response("Pack artwork unavailable", {status: 404});
    return new Response(new Uint8Array(Buffer.from(image.slice(SVG_PREFIX.length), "base64")), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": rawBlock === "latest"
          ? "public, s-maxage=30, stale-while-revalidate=60"
          : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    return new Response(reverted ? "Pack artwork unavailable" : "Pack artwork temporarily unavailable", {
      status: reverted ? 404 : 502,
      headers: {"cache-control": "no-store"},
    });
  }
}

import {ImageResponse} from "next/og";
import {packsAbi, packsClientFor, packsDeploymentFor} from "@shared/site/packs";
import {safeImageFromTokenURI} from "@shared/site/ogArtwork";
import {serverDeployment} from "../../../lib/deployment";
import {landingOnly} from "../../../lib/siteMode";

export const runtime = "nodejs";
export const revalidate = 3600;
const SIZE = {width: 1200, height: 630};

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  if (landingOnly()) return new Response("Not found", {status: 404});
  const {id} = await params;
  let art: string | null = null;
  if (/^\d{1,78}$/.test(id)) {
    const dep = serverDeployment();
    const pack = packsDeploymentFor(dep.chainId);
    if (pack && pack.shapes.toLowerCase() === dep.shapes.toLowerCase()) {
      try {
        const uri = await packsClientFor(dep.chainId).readContract({address: pack.packs, abi: packsAbi,
          functionName: "tokenURI", args: [BigInt(id)]});
        art = safeImageFromTokenURI(uri);
      } catch { /* Burned Pack or unavailable RPC: retain the labelled card. */ }
    }
  }
  return new ImageResponse(<div style={{width: SIZE.width, height: SIZE.height, display: "flex", alignItems: "center",
    justifyContent: "center", background: "#f5f4f0"}}>
    <div style={{width: 500, height: 500, display: "flex", alignItems: "center", justifyContent: "center",
      background: "#fff", boxShadow: "0 24px 64px rgba(0,0,0,.14)"}}>
      {art ? <img src={art} width={500} height={500} alt="" />
        : <span style={{fontSize: 48, color: "#333"}}>Pack #{id}</span>}
    </div>
  </div>, SIZE);
}

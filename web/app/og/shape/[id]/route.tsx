import { ImageResponse } from "next/og";
import { shapesAbi } from "@shared/chain/abi";
import { createShapesPublicClient } from "@shared/chain/rpc";
import { safeImageFromTokenURI } from "@shared/site/ogArtwork";
import { serverDeployment } from "../../../lib/deployment";

// The token share image: the on-chain artwork as a card centred on white, with a subtle drop
// shadow and rounded corners. The card art is the exact SVG the contract returns from tokenURI,
// so the share image can never diverge from the token — no re-render, no seed math here.
export const runtime = "nodejs";
// Regenerate at most once a day per token. The artwork only changes when the token is composed,
// decomposed or blackened; a daily window keeps RPC load off the hot path (one call per cache miss).
export const revalidate = 86400;

const OG = { width: 1200, height: 630 };
// Portrait card, the 250:350 ratio the artwork is drawn at. Height leaves a ~7% top/bottom margin.
const CARD_H = 540;
const CARD_W = Math.round((CARD_H * 250) / 350);

async function fetchArtwork(id: bigint): Promise<string | null> {
  const dep = serverDeployment();
  const client = createShapesPublicClient(dep, {
    chainName: "Shapes",
    primaryRpcUrl: process.env.SHAPES_RPC_URL,
  });
  const uri = await client.readContract({
    address: dep.shapes,
    abi: shapesAbi,
    functionName: "tokenURI",
    args: [id],
  });
  return safeImageFromTokenURI(uri);
}

function card(children: React.ReactNode) {
  return (
    <div
      style={{
        width: OG.width,
        height: OG.height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
      }}
    >
      <div
        style={{
          width: CARD_W,
          height: CARD_H,
          display: "flex",
          borderRadius: 22,
          overflow: "hidden",
          background: "#000000",
          boxShadow: "0 24px 64px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.10)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let art: string | null = null;
  if (/^\d+$/.test(id)) {
    try {
      art = await fetchArtwork(BigInt(id));
    } catch {
      art = null;
    }
  }

  // No artwork (unknown or burned token, or RPC down): a blank card, still a valid share image.
  const body = art ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={art} width={CARD_W} height={CARD_H} alt="" style={{ width: CARD_W, height: CARD_H }} />
  ) : (
    <div style={{ width: CARD_W, height: CARD_H }} />
  );

  return new ImageResponse(card(body), OG);
}

import { ImageResponse } from "next/og";
import { CANONICAL } from "@shared/canonical/params";
import { composeShape, svgFromComposition } from "@shared/canonical/render";
import { composeSampledShape } from "@shared/canonical/sampling";
import { DENOMINATIONS } from "@shared/canonical/denominations";
import { geneAtMint } from "@shared/canonical/ink";
import { liveNodes, textSeed, type PlayNode, type PlaySession } from "@shared/play/session";
import { decodeSession } from "@shared/play/urlCodec";

// The Playground share image: decodes the same `?s=` state the page itself reads, renders the
// current (or most recently composed) card with the canonical renderer, and rasterizes it. No
// chain access, no fetch -- everything the card needs is already in the URL.
export const runtime = "nodejs";

const OG = { width: 1200, height: 630 };
// Portrait card, the 250:350 ratio the artwork is drawn at. Height leaves a ~7% top/bottom margin.
const CARD_H = 540;
const CARD_W = Math.round((CARD_H * 250) / 350);
const BG = "#0d0d0c";

// Cards over this length in `?s=` are never decoded, only rendered as the default card.
const MAX_S_LENGTH = 6000;

// A bare /play link (no session state) still unfurls with artwork: a fixed demo card, seeded
// from a constant string rather than a random or per-request value so the image is stable.
const DEFAULT_SEED = textSeed("shapes");
const DEFAULT_DENOM_INDEX = 0;

/** Mirrors `PlayApp.tsx`'s `nodeComposition`: sampled from stored bytes if composed, otherwise
 *  drawn fresh from the seed. */
function nodeSvg(node: PlayNode): string {
  const composition = node.modules
    ? composeSampledShape(node.modules, node.denomIndex, node.inkGene, CANONICAL)
    : composeShape(node.seed, DENOMINATIONS[node.denomIndex], node.inkGene, CANONICAL);
  return svgFromComposition(composition, 0n, CANONICAL, false);
}

function defaultSvg(): string {
  const gene = geneAtMint(DEFAULT_SEED, DEFAULT_DENOM_INDEX);
  const composition = composeShape(DEFAULT_SEED, DENOMINATIONS[DEFAULT_DENOM_INDEX], gene, CANONICAL);
  return svgFromComposition(composition, 0n, CANONICAL, false);
}

/** The most recent composed node, else the most recent live (kept, uncomposed) node, else null
 *  for an empty session. */
function pickDisplayNode(session: PlaySession): PlayNode | null {
  for (let i = session.nodes.length - 1; i >= 0; i--) {
    if (session.nodes[i].trace) return session.nodes[i];
  }
  const live = liveNodes(session);
  return live.length > 0 ? live[live.length - 1] : null;
}

function card(svg: string) {
  const dataUri = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  return (
    <div
      style={{
        width: OG.width,
        height: OG.height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BG,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={dataUri} width={CARD_W} height={CARD_H} alt="" style={{ width: CARD_W, height: CARD_H }} />
    </div>
  );
}

function svgForRequest(url: URL): string {
  const s = url.searchParams.get("s");
  if (!s || s.length > MAX_S_LENGTH) return defaultSvg();
  const node = pickDisplayNode(decodeSession(s));
  return node ? nodeSvg(node) : defaultSvg();
}

export async function GET(req: Request) {
  // Any failure anywhere in this path (malformed URL, a decode edge case, a render error) still
  // returns a valid share image rather than a 500.
  try {
    return new ImageResponse(card(svgForRequest(new URL(req.url))), OG);
  } catch {
    return new ImageResponse(card(defaultSvg()), OG);
  }
}

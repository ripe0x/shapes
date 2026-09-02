import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import bundledFallback from "../../public/deployment.json";

// Server-side deployment target for the OG image route. Env vars win so a production deploy can
// point at a public RPC and the mainnet contract without editing the bundled dev deployment.
export interface ServerDeployment {
  rpc: string;
  chainId: number;
  shapes: `0x${string}`;
}

interface DeploymentFile {
  rpc: string;
  chainId: number;
  shapes: string;
}

/** `web/public/deployment.local.json` (gitignored, written by `script/lived-in.sh`) if present.
 *  Read at call time rather than imported: it is dev-only and does not exist in a production
 *  bundle, so a static import would fail the build. */
function localDeployment(): DeploymentFile | null {
  try {
    const path = join(process.cwd(), "public", "deployment.local.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentFile;
  } catch {
    return null;
  }
}

export function serverDeployment(): ServerDeployment {
  const fallback = localDeployment() ?? bundledFallback;
  return {
    rpc: process.env.SHAPES_RPC_URL || fallback.rpc,
    chainId: process.env.SHAPES_CHAIN_ID ? Number(process.env.SHAPES_CHAIN_ID) : fallback.chainId,
    shapes: (process.env.SHAPES_ADDRESS || fallback.shapes) as `0x${string}`,
  };
}

import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Deployment} from "@shared/chain/abi";
import deploymentRecord from "../../public/deployment.json";

// Server-side deployment target for the OG image route. Env vars win so a production deploy can
// point at a public RPC and the mainnet contract without editing the bundled dev deployment.
export interface ServerDeployment {
  rpc: string;
  chainId: number;
  shapes: `0x${string}`;
  /** Unix seconds before which minting is closed; missing or empty means open. */
  mintStart?: string;
}

interface DeploymentFile {
  rpc: string;
  chainId: number;
  shapes: string;
  mintStart?: string;
}

/** Parses a deployment record off disk. Read at call time rather than imported: the file is a dev
 *  and test target that does not exist in a production bundle, so a static import would fail the
 *  build. */
function readDeploymentFile(path: string): DeploymentFile | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentFile;
  } catch {
    return null;
  }
}

/** The record the whole site targets when `SHAPES_DEPLOYMENT_FILE` names one, ahead of the bundled
 *  `public/deployment.json` and of `public/deployment.local.json`. The browser receives it as a
 *  prop from the root layout (see `ShapesProviders`), so one variable points the server routes and
 *  the client at the same chain. `web/e2e/run.sh` sets it to a copy of `deployments/<chainId>.json`
 *  it owns, which keeps a run off both tracked files and `public/deployment.local.json`, the target
 *  `script/lived-in.sh` writes for a developer. */
export function overrideDeployment(): Deployment | null {
  const path = process.env.SHAPES_DEPLOYMENT_FILE;
  return path ? (readDeploymentFile(path) as Deployment | null) : null;
}

/** `SHAPES_DEPLOYMENT_FILE`, else `web/public/deployment.local.json` (gitignored, written by
 *  `script/lived-in.sh`) if present. */
function localDeployment(): DeploymentFile | null {
  return readDeploymentFile(
    process.env.SHAPES_DEPLOYMENT_FILE || join(process.cwd(), "public", "deployment.local.json"),
  );
}

export function serverDeployment(): ServerDeployment {
  const fallback = localDeployment() ?? deploymentRecord;
  return {
    rpc: process.env.SHAPES_RPC_URL || fallback.rpc,
    chainId: process.env.SHAPES_CHAIN_ID ? Number(process.env.SHAPES_CHAIN_ID) : fallback.chainId,
    shapes: (process.env.SHAPES_ADDRESS || fallback.shapes) as `0x${string}`,
    mintStart: process.env.SHAPES_MINT_START || fallback.mintStart,
  };
}

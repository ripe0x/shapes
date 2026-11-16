import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Deployment} from "@shared/chain/abi";
import {deploymentRecordName} from "@shared/site/deploymentRecord";
import deploymentRecord from "../../public/deployment.json";
import deploymentRecordSepolia from "../../public/deployment.sepolia.json";

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
  /** Ponder origin, present on a local or Sepolia record. The mainnet record leaves it out; a
   *  production deploy names the upstream through SHAPES_INDEXER_URL instead. */
  indexerUrl?: string;
}

/** Bundled records this build could serve, both statically imported so either one is part of the
 *  production bundle regardless of which the running site picks. */
const BUNDLED_RECORDS: Record<string, DeploymentFile> = {
  deployment: deploymentRecord,
  "deployment.sepolia": deploymentRecordSepolia,
};

/** The bundled record this build serves, named by NEXT_PUBLIC_SHAPES_DEPLOYMENT (the same
 *  variable `ShapesProviders.tsx` reads to fetch the matching `/<name>.json` on the client), so
 *  the server and the browser select the same file. Defaults to `deployment.json`, the record a
 *  build serves when the variable is unset. */
function bundledDeployment(): DeploymentFile {
  const name = deploymentRecordName(process.env.NEXT_PUBLIC_SHAPES_DEPLOYMENT);
  return BUNDLED_RECORDS[name] ?? deploymentRecord;
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

/** `SHAPES_DEPLOYMENT_FILE`, else `web/public/deployment.local.json` (gitignored, written by
 *  `script/lived-in.sh`) if present. */
function localDeployment(): DeploymentFile | null {
  return readDeploymentFile(
    process.env.SHAPES_DEPLOYMENT_FILE || join(process.cwd(), "public", "deployment.local.json"),
  );
}

/** Give the client the same selected record as server routes without another browser fetch. */
export function clientDeployment(): Deployment {
  return (localDeployment() ?? bundledDeployment()) as Deployment;
}

/** The Ponder GraphQL endpoint `/api/indexer` forwards to, and the bearer token it presents.
 *  `SHAPES_INDEXER_URL` is what a deployed site sets; without it the deployment record's own
 *  `indexerUrl` is used, so a local anvil run reaches its local indexer with no env var. Returns
 *  null when neither names an upstream, which the route answers as 503. */
export function indexerUpstream(): {url: string; token?: string} | null {
  const record = localDeployment() ?? bundledDeployment();
  const fromRecord = record.indexerUrl ? `${record.indexerUrl.replace(/\/$/, "")}/graphql` : "";
  const url = process.env.SHAPES_INDEXER_URL || fromRecord;
  return url ? {url, token: process.env.SHAPES_INDEXER_TOKEN || undefined} : null;
}

export function serverDeployment(): ServerDeployment {
  const fallback = localDeployment() ?? bundledDeployment();
  return {
    rpc: process.env.SHAPES_RPC_URL || fallback.rpc,
    chainId: process.env.SHAPES_CHAIN_ID ? Number(process.env.SHAPES_CHAIN_ID) : fallback.chainId,
    shapes: (process.env.SHAPES_ADDRESS || fallback.shapes) as `0x${string}`,
    mintStart: process.env.SHAPES_MINT_START || fallback.mintStart,
  };
}

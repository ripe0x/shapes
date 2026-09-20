/**
 * Address book and ABIs per chain, read from the repo's own deployment records and vendored
 * ABIs rather than duplicated here. `deployments/<chainId>.json` and `indexer/abis/*` are the
 * source of truth (written by `script/deploy.sh` and copied from the compiled contract artifact
 * respectively); this module only re-exports and looks them up by chain id.
 */

import { shapesAbi } from "../../../indexer/abis/Shapes.ts";
import { shapeAuctionHouseAbi } from "../../../indexer/abis/ShapeAuctionHouse.ts";
import mainnetDeployment from "../../../deployments/1.json" with { type: "json" };
import sepoliaDeployment from "../../../deployments/11155111.json" with { type: "json" };

export { shapesAbi, shapeAuctionHouseAbi };

export interface DeploymentRecord {
  rpc: string;
  indexerUrl?: string;
  chainId: number;
  shapes: `0x${string}`;
  renderer: `0x${string}`;
  collection: `0x${string}`;
  auctionHouse: `0x${string}`;
  mintFeeWei: string;
  mintStart: string;
  fromBlock: number;
  auctionHouseFromBlock?: number;
}

const DEPLOYMENTS: Readonly<Record<number, DeploymentRecord>> = {
  1: mainnetDeployment as DeploymentRecord,
  11155111: sepoliaDeployment as DeploymentRecord,
};

/** The deployment record for a chain id. Throws for a chain this repo has no record for. */
export function deploymentFor(chainId: number): DeploymentRecord {
  const record = DEPLOYMENTS[chainId];
  if (!record) {
    throw new Error(`shapes-sdk: no deployment record for chain ${chainId}`);
  }
  return record;
}

/** Every chain id this repo carries a deployment record for. */
export function supportedChainIds(): readonly number[] {
  return Object.keys(DEPLOYMENTS).map(Number);
}

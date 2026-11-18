import type { Deployment } from "@shared/chain/abi";
import { shapesAbi } from "@shared/chain/abi";
import { createShapesPublicClient } from "@shared/chain/rpc";
import { LADDER_NAME, UNIT } from "shapes-render/denominations";

export async function verifyDeployment(deployment: Deployment): Promise<void> {
  const client = createShapesPublicClient(deployment, {
    primaryRpcUrl: process.env.NEXT_PUBLIC_SHAPES_RPC_URL,
  });
  let unit: bigint;
  try {
    unit = await client.readContract({ address: deployment.shapes, abi: shapesAbi, functionName: "unit" });
  } catch {
    throw new Error("The Shapes contract is not connected here yet.");
  }
  if (unit !== UNIT) {
    throw new Error(`This build uses the ${LADDER_NAME} denomination ladder but the contract at ${deployment.shapes} uses a different one. Rebuild with the matching SHAPES_LADDER.`);
  }
}

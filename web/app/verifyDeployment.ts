import { createClient, type Hex } from "viem";
import type { Deployment } from "@shared/chain/abi";
import type { MintReadCalls } from "./mintReadAbi";
import { shapesTransport } from "@shared/chain/rpcTransport";
import { DENOMINATIONS, LADDER_NAME, UNIT } from "shapes-render/denominations";
import type { MintBootstrap } from "@shared/site/MintDraft";

/** Only the contract reads needed for a usable mint form. Wallet setup and public-client
 * actions such as ENS resolution are not prerequisites for reading a quote. */
export async function verifyDeployment(deployment: Deployment, calls: MintReadCalls): Promise<MintBootstrap> {
  const client = createClient({
    transport: shapesTransport(deployment.chainId, deployment.rpc, process.env.NEXT_PUBLIC_SHAPES_RPC_URL),
  });
  const readUint = async (data: Hex): Promise<bigint> => {
    const result = await client.request({ method: "eth_call", params: [{ to: deployment.shapes, data }, "latest"] });
    if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error("Invalid uint256 result");
    return BigInt(result);
  };
  const fees = readUint(calls.fee)
    .then((fee) => DENOMINATIONS.map(() => fee))
    .catch(() => Promise.all(calls.legacyFees.map(readUint)));
  let values: [bigint, bigint[], bigint];
  try {
    values = await Promise.all([
      readUint(calls.unit),
      fees,
      readUint(calls.start),
    ]);
  } catch {
    throw new Error("The Shapes contract is not connected here yet.");
  }
  const [unit, verifiedFees, mintStart] = values;
  if (unit !== UNIT) {
    throw new Error(`This build uses the ${LADDER_NAME} denomination ladder but the contract at ${deployment.shapes} uses a different one. Rebuild with the matching SHAPES_LADDER.`);
  }
  return { fees: verifiedFees, mintStart };
}

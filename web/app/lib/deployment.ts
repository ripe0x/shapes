import fallback from "../../public/deployment.json";

// Server-side deployment target for the OG image route. Env vars win so a production deploy can
// point at a public RPC and the mainnet contract without editing the bundled dev deployment.
export interface ServerDeployment {
  rpc: string;
  chainId: number;
  shapes: `0x${string}`;
}

export function serverDeployment(): ServerDeployment {
  return {
    rpc: process.env.SHAPES_RPC_URL || fallback.rpc,
    chainId: process.env.SHAPES_CHAIN_ID ? Number(process.env.SHAPES_CHAIN_ID) : fallback.chainId,
    shapes: (process.env.SHAPES_ADDRESS || fallback.shapes) as `0x${string}`,
  };
}

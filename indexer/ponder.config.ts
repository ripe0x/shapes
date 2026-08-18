import { createConfig } from "ponder";

import { shapesAbi } from "./abis/Shapes";

// All chain-specific values are env-configurable so the same config runs against the dev chain
// (see preview/public/deployment.json for current values) and, once deployed, mainnet. No
// default RPC URL is provided for the address/start block: an indexer silently pointed at the
// wrong contract or wrong history is worse than one that refuses to start.
const CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 31347);
const RPC_URL = process.env.PONDER_RPC_URL ?? "http://127.0.0.1:8547";
const SHAPES_ADDRESS = process.env.SHAPES_ADDRESS as `0x${string}` | undefined;
const START_BLOCK = process.env.SHAPES_START_BLOCK ? Number(process.env.SHAPES_START_BLOCK) : undefined;

if (!SHAPES_ADDRESS) {
  throw new Error(
    "SHAPES_ADDRESS is not set. Copy .env.example to .env.local and set SHAPES_ADDRESS to the " +
      "deployed Shapes contract address, and SHAPES_START_BLOCK to its deployment block. For the " +
      "dev chain, the address is in preview/public/deployment.json; mainnet is not deployed yet.",
  );
}

export default createConfig({
  chains: {
    chain: {
      id: CHAIN_ID,
      rpc: RPC_URL,
    },
  },
  contracts: {
    Shapes: {
      abi: shapesAbi,
      chain: "chain",
      address: SHAPES_ADDRESS,
      startBlock: START_BLOCK,
    },
  },
});

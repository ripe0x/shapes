import { createConfig } from "ponder";

import { shapesAbi } from "./abis/Shapes";
import { shapeAuctionHouseAbi } from "./abis/ShapeAuctionHouse";

// All chain-specific values are env-configurable so the same config runs against the dev chain
// (see preview/public/deployment.json for current values) and, once deployed, mainnet. No
// default RPC URL is provided for the address/start block: an indexer silently pointed at the
// wrong contract or wrong history is worse than one that refuses to start.
const CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 31347);
const RPC_URL = process.env.PONDER_RPC_URL ?? "http://127.0.0.1:8547";
const RPC_FALLBACKS = (process.env.PONDER_RPC_FALLBACKS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const POLLING_INTERVAL = Number(process.env.PONDER_POLL_INTERVAL_MS ?? 1_000);
const SHAPES_ADDRESS = process.env.SHAPES_ADDRESS as `0x${string}` | undefined;
const START_BLOCK = process.env.SHAPES_START_BLOCK ? Number(process.env.SHAPES_START_BLOCK) : undefined;
const AUCTION_HOUSE_ADDRESS = process.env.AUCTION_HOUSE_ADDRESS as `0x${string}` | undefined;
const AUCTION_HOUSE_START_BLOCK = process.env.AUCTION_HOUSE_START_BLOCK
  ? Number(process.env.AUCTION_HOUSE_START_BLOCK)
  : START_BLOCK;
const database = process.env.DATABASE_URL
  ? ({ kind: "postgres", connectionString: process.env.DATABASE_URL } as const)
  : ({
      kind: "pglite",
      directory: process.env.PONDER_DATABASE_DIR ?? ".ponder/pglite",
    } as const);

if (!SHAPES_ADDRESS) {
  throw new Error(
    "SHAPES_ADDRESS is not set. Copy .env.example to .env.local and set SHAPES_ADDRESS to the " +
      "deployed Shapes contract address, and SHAPES_START_BLOCK to its deployment block. For the " +
      "dev chain, the address is in preview/public/deployment.json; mainnet is not deployed yet.",
  );
}

if (!AUCTION_HOUSE_ADDRESS) {
  throw new Error(
    "AUCTION_HOUSE_ADDRESS is not set. The activity feed records the auction house's created, " +
      "bid, settled and lot-claimed events, so the indexer needs the address every deployment " +
      "record carries as `auctionHouse`. Set AUCTION_HOUSE_START_BLOCK too when the house was " +
      "deployed later than Shapes; it defaults to SHAPES_START_BLOCK.",
  );
}

export default createConfig({
  database,
  chains: {
    chain: {
      id: CHAIN_ID,
      rpc: [RPC_URL, ...RPC_FALLBACKS],
      pollingInterval: POLLING_INTERVAL,
    },
  },
  contracts: {
    Shapes: {
      abi: shapesAbi,
      chain: "chain",
      address: SHAPES_ADDRESS,
      startBlock: START_BLOCK,
    },
    ShapeAuctionHouse: {
      abi: shapeAuctionHouseAbi,
      chain: "chain",
      address: AUCTION_HOUSE_ADDRESS,
      startBlock: AUCTION_HOUSE_START_BLOCK,
    },
  },
});

import { ponder } from "ponder:registry";

import { balancer, balancerLog } from "../ponder.schema";
import { jsonArgs } from "./lib/balancerLog";

type Log = {
  args: Record<string, unknown>;
  log: { address: `0x${string}`; logIndex: number };
  block: { number: bigint };
  transaction: { hash: `0x${string}` };
};

function logRow(eventName: string, event: Log) {
  return {
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    address: event.log.address.toLowerCase() as `0x${string}`,
    eventName,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
    args: jsonArgs(event.args),
  };
}

ponder.on("BalancerFactory:BalancerCreated", async ({ event, context }) => {
  await context.db.insert(balancerLog).values(logRow("BalancerCreated", event));
  await context.db.insert(balancer).values({
    id: event.args.balancer.toLowerCase() as `0x${string}`,
    pool: event.args.pool.toLowerCase() as `0x${string}`,
    creator: event.args.creator.toLowerCase() as `0x${string}`,
    createdAtBlock: event.block.number,
    creatorUpdatedAtBlock: event.block.number,
  });
});

ponder.on("BalancerFactory:DefaultPolicyChanged", async ({ event, context }) => {
  await context.db.insert(balancerLog).values(logRow("DefaultPolicyChanged", event));
});

// Only clones of this factory reach these handlers (factory filter in ponder.config.ts), and a
// transfer is accepted after creation, so the balancer row always exists here.
ponder.on("PoolBalancer:CreatorTransferred", async ({ event, context }) => {
  await context.db.insert(balancerLog).values(logRow("CreatorTransferred", event));
  await context.db.update(balancer, { id: event.log.address.toLowerCase() as `0x${string}` }).set({
    creator: event.args.newCreator.toLowerCase() as `0x${string}`,
    creatorUpdatedAtBlock: event.block.number,
  });
});

for (const name of [
  "ItemDrawn",
  "Deposited",
  "SurplusClaimed",
  "ProceedsCollected",
  "KeeperPaid",
  "ShapesMinted",
  "CuratedListed",
  "CuratedRepriced",
] as const) {
  ponder.on(`PoolBalancer:${name}`, async ({ event, context }) => {
    await context.db.insert(balancerLog).values(logRow(name, event));
  });
}

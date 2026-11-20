import assert from "node:assert/strict";
import {test} from "node:test";
import {createPublicClient, http, type Address} from "viem";
import {mainnet} from "viem/chains";
import {balancerFactoryAbi, poolBalancerAbi} from "../../abis/PoolBalancer.ts";
import {jsonArgs} from "../lib/balancerLog.ts";

// Compares a running indexer's /balancer routes against eth_getLogs on mainnet, up to the block
// the indexer reports. Run with an indexer synced past the factory's deployment:
//   BALANCER_E2E_INDEXER=http://localhost:42069 node --test src/api/balancer.e2e.test.ts
const INDEXER = process.env.BALANCER_E2E_INDEXER;
const RPC = process.env.BALANCER_E2E_RPC ?? "https://mainnet.gateway.tenderly.co";
const FACTORY = (process.env.BALANCER_FACTORY_ADDRESS ?? "0xA57de1a6Ad66aB053057Ff7829F65eFe1cD57ece") as Address;
const FROM = BigInt(process.env.BALANCER_FACTORY_START_BLOCK ?? 26453686);

type ApiLog = {address: string; eventName: string; blockNumber: number; logIndex: number; txHash: string; args: unknown};
const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${INDEXER}${path}`);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return (await res.json()) as T;
};

test("pools and logs match eth_getLogs", {skip: !INDEXER && "BALANCER_E2E_INDEXER unset"}, async () => {
  const pub = createPublicClient({chain: mainnet, transport: http(RPC, {retryCount: 5, retryDelay: 2_000})});
  const all = await get<{throughBlock: number; pools: {balancer: string; pool: string; creator: string; createdAtBlock: number}[]}>(
    "/balancer/pools",
  );
  const toBlock = BigInt(all.throughBlock);
  assert.ok(toBlock >= FROM, "indexer has not reached the factory deployment");

  const factoryLogs = await pub.getLogs({address: FACTORY, events: balancerFactoryAbi, fromBlock: FROM, toBlock});
  const created = factoryLogs.filter((l) => l.eventName === "BalancerCreated");
  const balancers = created.map((l) => (l.args as {balancer: Address}).balancer);
  const poolLogs = balancers.length ? await pub.getLogs({address: balancers, events: poolBalancerAbi, fromBlock: FROM, toBlock}) : [];

  // Latest CreatorTransferred wins; logs come back in chain order.
  const creator = new Map(created.map((l) => {
    const a = l.args as {creator: Address; balancer: Address};
    return [a.balancer.toLowerCase(), a.creator.toLowerCase()];
  }));
  for (const l of poolLogs) if (l.eventName === "CreatorTransferred") creator.set(l.address.toLowerCase(), (l.args as {newCreator: Address}).newCreator.toLowerCase());

  assert.deepEqual(
    all.pools.map((p) => [p.balancer, p.pool, p.creator, p.createdAtBlock]),
    created.map((l) => {
      const a = l.args as {balancer: Address; pool: Address};
      return [a.balancer.toLowerCase(), a.pool.toLowerCase(), creator.get(a.balancer.toLowerCase()), Number(l.blockNumber)];
    }),
  );

  // Every current creator gets exactly its pools back.
  for (const who of new Set(creator.values())) {
    const mine = await get<{pools: {balancer: string}[]}>(`/balancer/pools?creator=${who}`);
    assert.deepEqual(
      mine.pools.map((p) => p.balancer).sort(),
      [...creator].filter(([, c]) => c === who).map(([b]) => b).sort(),
    );
  }

  type ChainLog = {address: Address; eventName: string; blockNumber: bigint; logIndex: number; transactionHash: `0x${string}`; args: unknown};
  const expected = (logs: ChainLog[]) =>
    logs.map((l) => ({
      address: l.address.toLowerCase(),
      eventName: l.eventName,
      blockNumber: Number(l.blockNumber),
      logIndex: l.logIndex,
      txHash: l.transactionHash,
      args: jsonArgs(l.args as Record<string, unknown>),
    }));
  let compared = 0;
  for (const b of [FACTORY, ...balancers]) {
    const api = await get<{throughBlock: number; logs: ApiLog[]}>(`/balancer/logs?address=${b}`);
    // The indexer may advance between requests; compare through the earlier bound.
    const mine = expected(([...factoryLogs, ...poolLogs] as ChainLog[]).filter((l) => l.address.toLowerCase() === b.toLowerCase()));
    assert.deepEqual(api.logs.filter((l) => l.blockNumber <= Number(toBlock)), mine, `logs of ${b}`);
    compared += mine.length;

    // fromBlock returns the suffix, so a caller can resume from a block it already holds.
    if (mine.length > 1) {
      const from = mine[Math.floor(mine.length / 2)]!.blockNumber;
      const tail = await get<{logs: ApiLog[]}>(`/balancer/logs?address=${b}&fromBlock=${from}`);
      assert.deepEqual(tail.logs.filter((l) => l.blockNumber <= Number(toBlock)), mine.filter((l) => l.blockNumber >= from));
    }
  }
  console.log(`compared ${created.length} pools, ${compared} logs through block ${toBlock}`);
});

test("bad input is refused", {skip: !INDEXER && "BALANCER_E2E_INDEXER unset"}, async () => {
  for (const path of ["/balancer/logs", "/balancer/logs?address=0x12", `/balancer/logs?address=${FACTORY}&fromBlock=-1`, "/balancer/pools?creator=bob"]) {
    assert.equal((await fetch(`${INDEXER}${path}`)).status, 400, path);
  }
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {custom} from "viem";

import {createShapesPublicClient, fallbackTransport, rpcUrlsForChain} from "../chain/rpc";
import {buildConfig} from "../chain/wagmi";
import type {Deployment} from "../chain/abi";

const dep: Deployment = {
  rpc: "http://127.0.0.1:8545",
  chainId: 31337,
  shapes: "0x0000000000000000000000000000000000000000",
  lens: "0x0000000000000000000000000000000000000000",
  renderer: "0x0000000000000000000000000000000000000000",
  mintFeeWei: "0",
};

function blackholeThenHealthy(attempts: string[]) {
  return fallbackTransport([
    custom({
      request: async () => {
        attempts.push("blackholed primary");
        throw new Error("simulated primary-provider outage");
      },
    }),
    custom({
      request: async ({method}: {method: string}) => {
        attempts.push("healthy fallback");
        assert.equal(method, "eth_blockNumber");
        return "0x2a";
      },
    }),
  ]);
}

test("browser Wagmi client advances past a blackholed primary transport", async () => {
  const attempts: string[] = [];
  const config = buildConfig(dep, {
    primaryRpcUrl: "https://blackholed-primary.example",
    transport: blackholeThenHealthy(attempts),
  });

  const browserClient = config.getClient() as unknown as {
    request(args: {method: string}): Promise<string>;
  };
  assert.equal(await browserClient.request({method: "eth_blockNumber"}), "0x2a");
  assert.deepEqual(attempts, ["blackholed primary", "healthy fallback"]);
});

test("OG client advances past a blackholed primary transport", async () => {
  const attempts: string[] = [];
  const client = createShapesPublicClient(dep, {
    primaryRpcUrl: "https://blackholed-primary.example",
    transport: blackholeThenHealthy(attempts),
  });

  assert.equal(await client.getBlockNumber({cacheTime: 0}), 42n);
  assert.deepEqual(attempts, ["blackholed primary", "healthy fallback"]);
});

test("Sepolia provider list keeps a configured primary before independent public fallbacks", () => {
  const urls = rpcUrlsForChain(11155111, "https://deployment.example", "https://paid.example");
  assert.deepEqual(urls.slice(0, 2), ["https://paid.example", "https://deployment.example"]);
  assert.ok(urls.includes("https://ethereum-sepolia-rpc.publicnode.com"));
  assert.ok(urls.includes("https://public.1rpc.io/sepolia"));
});

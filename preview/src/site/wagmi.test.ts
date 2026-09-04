import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {create as createQrCode} from "cuer/QrCode";
import {connect, createConfig, writeContract, mock} from "@wagmi/core";
import {decodeFunctionData, http} from "viem";
import {mainnet} from "viem/chains";

import {buildConfig} from "../chain/wagmi";
import {mintRequest} from "./mint";
import {shapesAbi, type Deployment} from "../chain/abi";

const localDep: Deployment = {
  rpc: "http://127.0.0.1:8545",
  chainId: 31337,
  shapes: "0x0000000000000000000000000000000000000000",
  renderer: "0x0000000000000000000000000000000000000000",
  mintFeeWei: "0",
};

const mainnetDep: Deployment = {
  rpc: "https://ethereum-rpc.publicnode.com",
  chainId: mainnet.id,
  shapes: "0x00000000000000000000000000000000000000AA",
  renderer: "0x00000000000000000000000000000000000000CC",
  mintFeeWei: "1000000000000000",
};

const PROJECT_ID = "60af16a1be7c0077e8df5570cbed082f";

test("without a WalletConnect project id the config is injected-only", () => {
  const injectedOnly = buildConfig(localDep).connectors;
  assert.equal(injectedOnly.length, 1);
  assert.equal(injectedOnly[0].id, "injected");
});

test("server-rendered hosts can defer wallet hydration until React mounts", () => {
  assert.equal(buildConfig(localDep)._internal.ssr, false);
  assert.equal(buildConfig(localDep, {ssr: true})._internal.ssr, true);
  assert.equal(
    buildConfig(mainnetDep, {walletConnectProjectId: PROJECT_ID, ssr: true})._internal.ssr,
    true,
  );
});

test("a project id activates RainbowKit's standard wallet inventory on the deployment chain", () => {
  const config = buildConfig(mainnetDep, {walletConnectProjectId: PROJECT_ID});

  // The site declares exactly the deployment chain.
  assert.deepEqual(
    config.chains.map((chain) => chain.id),
    [mainnet.id],
  );

  // getDefaultConfig wires RainbowKit's maintained inventory instead of a custom wallet list.
  const connectors = config.connectors;
  assert.ok(connectors.length >= 5, `expected the full inventory, got ${connectors.length}`);
  assert.ok(connectors.some((c) => c.id === "safe"));
  assert.ok(connectors.some((c) => c.id === "baseAccount"));
});

test("the mainnet config uses viem's canonical chain (Multicall3 + explorer)", () => {
  const chain = buildConfig(mainnetDep, {walletConnectProjectId: PROJECT_ID}).chains[0];
  // Canonical `mainnet` from viem/wagmi, rather than a hand-built public-chain definition.
  assert.equal(chain.id, mainnet.id);
  assert.equal(chain.name, mainnet.name);
  assert.equal(
    chain.contracts?.multicall3?.address?.toLowerCase(),
    "0xca11bde05977b3631167028862be2a173976ca11",
  );
  assert.match(chain.blockExplorers?.default.url ?? "", /etherscan\.io/);
});

// A minimal JSON-RPC endpoint that answers the read calls viem makes while preparing a send and
// records the eth_sendTransaction it finally emits. Proves the mint reaches the wire, not a stub.
function rpcRecorder() {
  const sent: {to?: string; data?: string; value?: string; chainId?: string}[] = [];
  const reply = (method: string): unknown => {
    switch (method) {
      case "eth_chainId":
        return "0x1";
      case "eth_blockNumber":
        return "0x1";
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x3b9aca00";
      case "eth_estimateGas":
        return "0x5208";
      case "eth_getBlockByNumber":
        return {number: "0x1", baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380"};
      case "eth_feeHistory":
        return {baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0], oldestBlock: "0x0", reward: [["0x3b9aca00"]]};
      default:
        return null;
    }
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = JSON.parse(body);
      const one = (call: {id: number; method: string; params?: unknown[]}) => {
        if (call.method === "eth_sendTransaction") {
          const tx = (call.params?.[0] ?? {}) as Record<string, string>;
          sent.push({to: tx.to, data: tx.data ?? tx.input, value: tx.value, chainId: tx.chainId});
          return {jsonrpc: "2.0", id: call.id, result: `0x${"11".repeat(32)}`};
        }
        return {jsonrpc: "2.0", id: call.id, result: reply(call.method)};
      };
      const out = Array.isArray(calls) ? calls.map(one) : one(calls);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return {server, sent};
}

test("Mint initiates a real mainnet transaction to the Shapes contract", async () => {
  const {server, sent} = rpcRecorder();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address() as {port: number};
  const url = `http://127.0.0.1:${port}`;

  const account = "0x1111111111111111111111111111111111111111" as const;
  const chainDep = {...mainnetDep, rpc: url};
  // The mainnet chain the app configures, but with its RPC pointed at the local recorder so the
  // mock wallet's send is captured instead of hitting a live node.
  const base = buildConfig(chainDep, {walletConnectProjectId: PROJECT_ID}).chains[0];
  const chain = {...base, rpcUrls: {default: {http: [url]}}};
  // getDefaultConfig's WalletConnect connectors cannot open a relay session headlessly, so the
  // send is driven by a mock wallet on that same chain. The point under test is that mintRequest,
  // pushed through wagmi + viem against a mainnet-configured chain, emits the right eth_sendTransaction.
  const config = createConfig({
    chains: [chain],
    connectors: [mock({accounts: [account]})],
    transports: {[chain.id]: http(url)},
    ssr: false,
  });
  const connection = await connect(config, {connector: config.connectors[0]});
  // The wallet connects on the deployment chain, not an empty namespace.
  assert.equal(connection.chainId, mainnet.id);

  // mintRequest pins the deployment chain id; writeContract rejects a connector on any other
  // chain, so a successful send is itself proof the wallet is on it.
  const req = mintRequest(chainDep, {amountWei: 10n ** 16n, quantity: 1, fee: 5n * 10n ** 14n});
  await writeContract(config, req as unknown as Parameters<typeof writeContract>[1]);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(sent.length, 1, "exactly one transaction should be sent");
  const tx = sent[0];
  assert.equal(tx.to?.toLowerCase(), mainnetDep.shapes.toLowerCase());
  // 0.01 ETH denomination + 0.0005 ETH fee = 0.0105 ETH
  assert.equal(BigInt(tx.value ?? "0x0"), 10n ** 16n + 5n * 10n ** 14n);
  const decoded = decodeFunctionData({abi: shapesAbi, data: tx.data as `0x${string}`});
  assert.equal(decoded.functionName, "mint");
  assert.deepEqual(decoded.args, [10n ** 16n]);
});

test("WalletConnect QR generation accepts RainbowKit's borderless grid", () => {
  const value = "wc:shapes-test@2?symKey=00&relay-protocol=irn";
  const code = createQrCode(value);
  assert.equal(code.value, value);
  assert.ok(code.grid.length > 0);
});

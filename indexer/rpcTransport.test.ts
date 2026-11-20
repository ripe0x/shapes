import assert from "node:assert/strict";
import {spawn, type ChildProcess} from "node:child_process";
import {createServer, type Server} from "node:http";
import {after, before, test} from "node:test";
import {getLogsRetryHelper} from "@ponder/utils";
import type {RpcError} from "viem";
import {boundedRpcTransport} from "./rpcTransport.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let anvil: ChildProcess;
let rpcUrl: string;
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

before(async () => {
  const reservation = createServer();
  rpcUrl = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  anvil = spawn("anvil", ["--port", new URL(rpcUrl).port, "--silent", "--chain-id", "31337"], {stdio: "ignore"});
  let exited = false;
  anvil.on("exit", () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    assert.equal(exited, false, "The real Anvil node exited during setup");
    try {
      const response = await fetch(rpcUrl, {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_chainId", params: []})});
      assert.equal((await response.json()).result, "0x7a69");
      return;
    } catch { await wait(20); }
  }
  throw new Error("Real Anvil RPC did not start");
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Only the node created by this test is stopped; no existing chain or service is touched.
  anvil?.kill("SIGTERM");
});

/** Every successful reply comes unmodified from the real node. Only service failures are injected. */
async function proxy(options: {failures?: number; status?: number; errorCode?: number; errorMessage?: string;
  failureMethod?: string; delayMs?: number; malformed?: boolean; partialBody?: boolean} = {}) {
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  let failures = 0;
  const server = createServer(async (request, response) => {
    starts.push(Date.now());
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      const parsedBody = JSON.parse(Buffer.concat(body).toString());
      if (options.delayMs) await wait(options.delayMs);
      if ((!options.failureMethod || options.failureMethod === parsedBody.method) && failures < (options.failures ?? 0)) {
        failures++;
        if (options.partialBody) {
          response.writeHead(200, {"content-type": "application/json"});
          response.write('{"jsonrpc":"2.0","result":');
          await new Promise<void>((resolve) => response.once("close", resolve));
          return;
        }
        response.writeHead(options.status ?? 429, {"content-type": "application/json"});
        response.end(options.malformed ? "invalid JSON" : JSON.stringify({jsonrpc: "2.0", id: 1,
          error: {code: options.errorCode ?? -32005, message: options.errorMessage ?? "rate limit exceeded"}}));
        return;
      }
      const upstream = await fetch(rpcUrl, {method: "POST", headers: {"content-type": "application/json"},
        body: Buffer.concat(body)});
      response.writeHead(upstream.status, {"content-type": upstream.headers.get("content-type") ?? "application/json"});
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502);
      response.end();
    } finally {
      active--;
    }
  });
  servers.push(server);
  return {url: await listen(server), starts, get maxActive() { return maxActive; }, get active() { return active; }};
}

test("orders providers, bypasses a throttled primary, and returns to it after cooldown", async () => {
  const primary = await proxy({failures: 1});
  const fallback = await proxy();
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337,
    {cooldownMs: 100, maxCooldownMs: 200})({});
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  assert.equal(primary.starts.length, 1);
  assert.equal(fallback.starts.length, 2);
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  assert.equal(primary.starts.length, 1);
  const fallbackCalls = fallback.starts.length;
  await wait(110);
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  assert.equal(primary.starts.length, 3);
  assert.equal(fallback.starts.length, fallbackCalls);
});

test("all unavailable providers stay pending, increase backoff, and recover from real RPC", async () => {
  const primary = await proxy({failures: 2, status: 200, errorCode: -32005});
  const fallback = await proxy({failures: 2, status: 503});
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337,
    {cooldownMs: 30, maxCooldownMs: 60})({});
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  assert.ok(primary.starts[1]! - primary.starts[0]! >= 30);
  assert.ok(primary.starts[2]! - primary.starts[1]! >= 60);
  assert.equal(fallback.starts.length, 2);
});

test("physical RPC requests share the rate window and concurrency budget", async () => {
  const primary = await proxy({delayMs: 30});
  const unused = await proxy();
  const {request} = boundedRpcTransport([primary.url, unused.url], 31337,
    {requestsPerSecond: 5, maxConcurrent: 2})({});
  const started = Date.now();
  assert.deepEqual(await Promise.all(Array.from({length: 12}, () => request({method: "eth_blockNumber"}))),
    Array(12).fill("0x0"));
  // The startup chain validation also consumes a physical request in the same budget.
  assert.equal(primary.starts.length, 13);
  assert.equal(unused.starts.length, 0);
  assert.equal(primary.maxActive, 2);
  assert.ok(Date.now() - started >= 2_000);
  // Arrival timestamps include loopback transit jitter; the production budget measures starts.
  for (let i = 5; i < primary.starts.length; i++) {
    const elapsed = primary.starts[i]! - primary.starts[i - 5]!;
    assert.ok(elapsed >= 995, `Five-request arrival window was ${elapsed}ms`);
  }
});

test("a wrong-chain provider fails visibly instead of silently using the backup", async () => {
  const primary = await proxy();
  const fallback = await proxy();
  const {request} = boundedRpcTransport([primary.url, fallback.url], 1)({});
  await assert.rejects(request({method: "eth_chainId"}), /Wrong chain from RPC/);
  assert.equal(fallback.starts.length, 0);
});

test("permanent authentication errors fail instead of waiting forever", async () => {
  const primary = await proxy({failures: 100, status: 401});
  const fallback = await proxy({failures: 100, status: 403});
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337)({});
  await assert.rejects(request({method: "eth_chainId"}));
  assert.equal(primary.starts.length, 1);
  assert.equal(fallback.starts.length, 1);
});

test("invalid request parameters from a real node are returned without failover", async () => {
  const primary = await proxy();
  const fallback = await proxy();
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337)({});
  await assert.rejects(request({method: "eth_getBlockByNumber", params: ["invalid", false]}));
  assert.equal(fallback.starts.length, 0);
});

test("malformed service replies fail instead of waiting forever", async () => {
  const primary = await proxy({failures: 100, status: 200, malformed: true});
  const {request} = boundedRpcTransport([primary.url], 31337)({});
  await assert.rejects(request({method: "eth_chainId"}));
  assert.equal(primary.starts.length, 1);
});

test("a stalled response body is aborted and frees its connection before fallback completes", async () => {
  const primary = await proxy({failures: 100, partialBody: true});
  const fallback = await proxy();
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337, {timeoutMs: 50})({});
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  await wait(10);
  assert.equal(primary.active, 0);
  assert.equal(primary.starts.length, 1);
  assert.equal(primary.maxActive, 1);
  assert.equal(fallback.starts.length, 2);
});

test("request-size errors retain the details Ponder needs to split log ranges", async () => {
  const params: [{fromBlock: `0x${string}`; toBlock: `0x${string}`}] = [{fromBlock: "0x0", toBlock: "0x186a0"}];
  for (const status of [200, 400]) {
    const primary = await proxy({failures: 100, status, failureMethod: "eth_getLogs",
      errorMessage: "query returned more than 10000 results"});
    const fallback = await proxy();
    const {request} = boundedRpcTransport([primary.url, fallback.url], 31337)({});
    let caught: unknown;
    try { await request({method: "eth_getLogs", params}); } catch (error) { caught = error; }
    assert.ok(caught, `HTTP ${status} request-size error never reached Ponder`);
    const split = getLogsRetryHelper({params, error: caught as RpcError});
    assert.equal(split.shouldRetry, true, `HTTP ${status} discarded the range error details`);
    assert.equal(fallback.starts.length, 0);
  }
});

test("archive access restrictions on a fallback do not make a temporarily unavailable primary fatal", async () => {
  const primary = await proxy({failures: 1});
  const fallback = await proxy({failures: 100, status: 200, errorCode: -32602,
    errorMessage: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"});
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337, {cooldownMs: 30})({});
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  assert.equal(primary.starts.length, 3);
  assert.ok(fallback.starts.length >= 1, "The archive access failure was not reached");
});

test("execution reverts remain deterministic even when an RPC returns HTTP 500", async () => {
  const primary = await proxy({failures: 100, status: 500, failureMethod: "eth_call", errorCode: 3,
    errorMessage: "execution reverted: permission denied"});
  const fallback = await proxy();
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337)({});
  await assert.rejects(request({method: "eth_call", params: [{to: "0x0000000000000000000000000000000000000001"}, "latest"]}),
    /execution reverted/);
  assert.equal(primary.starts.length, 2);
  assert.equal(fallback.starts.length, 0);
});

test("concurrent failures release queued requests to the fallback and respect both connection budgets", async () => {
  const primary = await proxy({failures: 2, failureMethod: "eth_blockNumber", delayMs: 20});
  const fallback = await proxy({delayMs: 10});
  const {request} = boundedRpcTransport([primary.url, fallback.url], 31337,
    {cooldownMs: 100, maxCooldownMs: 200})({});
  assert.equal(await request({method: "eth_chainId"}), "0x7a69");
  assert.deepEqual(await Promise.all(Array.from({length: 3}, () => request({method: "eth_blockNumber"}))),
    ["0x0", "0x0", "0x0"]);
  assert.equal(primary.starts.length, 4);
  assert.equal(primary.maxActive, 2);
  assert.ok(fallback.maxActive <= 2);
  await wait(110);
  assert.equal(await request({method: "eth_blockNumber"}), "0x0");
  assert.equal(primary.starts.length, 5);
});

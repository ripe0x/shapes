import assert from "node:assert/strict";
import test from "node:test";
import {http} from "viem";
import {serialize} from "wagmi";
import {buildConfig, initialWalletState, ssrStorage} from "./wagmi";
import type {Deployment} from "./abi";

function dep(chainId: number, shapes: `0x${string}`): Deployment {
  return {
    rpc: "http://127.0.0.1:8545",
    chainId,
    shapes,
    renderer: "0x0000000000000000000000000000000000000001",
  };
}

test("buildConfig memoizes per deployment, not per object identity", () => {
  // Two structurally-equal but distinct objects, as a fresh JSON.parse of deployment.json would
  // produce on every fetch.
  const a = buildConfig(dep(90901, "0x0000000000000000000000000000000000000002"), {transport: http()});
  const b = buildConfig(dep(90901, "0x0000000000000000000000000000000000000002"), {transport: http()});
  assert.strictEqual(a, b);
});

test("buildConfig does not share a config across different deployments", () => {
  const a = buildConfig(dep(90911, "0x0000000000000000000000000000000000000003"), {transport: http()});
  const b = buildConfig(dep(90912, "0x0000000000000000000000000000000000000003"), {transport: http()});
  assert.notStrictEqual(a, b);
});

test("ssr mode persists connections via cookie storage instead of localStorage", () => {
  const withoutSsr = buildConfig(dep(90921, "0x0000000000000000000000000000000000000004"), {
    transport: http(),
  });
  const withSsr = buildConfig(dep(90922, "0x0000000000000000000000000000000000000004"), {
    transport: http(),
    ssr: true,
  });
  assert.notStrictEqual(withoutSsr.storage, ssrStorage);
  assert.strictEqual(withSsr.storage, ssrStorage);
});

test("initialWalletState is undefined with no cookie header", () => {
  assert.strictEqual(initialWalletState(undefined), undefined);
  assert.strictEqual(initialWalletState(null), undefined);
  assert.strictEqual(initialWalletState(""), undefined);
});

test("initialWalletState decodes a previously-persisted connection cookie", () => {
  const persisted = serialize({
    state: {chainId: 90931, current: "conn-1", connections: new Map()},
    version: 2,
  });
  const cookieHeader = `unrelated=1; wagmi.store=${persisted}`;
  const state = initialWalletState(cookieHeader);
  assert.equal(state?.chainId, 90931);
  assert.equal(state?.current, "conn-1");
});

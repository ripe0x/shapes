import {test} from "node:test";
import assert from "node:assert/strict";

import {buildConfig} from "../chain/wagmi";
import type {Deployment} from "../chain/abi";

const dep: Deployment = {
  rpc: "http://127.0.0.1:8545",
  chainId: 31337,
  shapes: "0x0000000000000000000000000000000000000000",
  lens: "0x0000000000000000000000000000000000000000",
  renderer: "0x0000000000000000000000000000000000000000",
  feeBps: "0",
};

test("wallet config keeps injected wallets without a WalletConnect project id", () => {
  const injectedOnly = buildConfig(dep).connectors;
  assert.equal(injectedOnly.length, 1);
  assert.equal(injectedOnly[0].id, "injected");

  // A non-empty real project id adds the existing RainbowKit mobile connector path. The actual
  // relay handshake is intentionally outside this deterministic unit test.
  assert.ok(buildConfig(dep, {walletConnectProjectId: "project-owned-id"}).connectors.length > 1);
});

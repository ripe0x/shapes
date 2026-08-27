import {test} from "node:test";
import assert from "node:assert/strict";
import {create as createQrCode} from "cuer/QrCode";

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

  // A non-empty real project id adds RainbowKit's standard named wallet inventory. The actual
  // relay handshake and platform-specific filtering are intentionally outside this unit test.
  const standardWallets = buildConfig(dep, {walletConnectProjectId: "project-owned-id"}).connectors;
  assert.ok(standardWallets.length >= 5);
  assert.ok(standardWallets.some((connector) => connector.id === "safe"));
  assert.ok(standardWallets.some((connector) => connector.id === "baseAccount"));
});

test("WalletConnect QR generation accepts RainbowKit's borderless grid", () => {
  const value = "wc:shapes-test@2?symKey=00&relay-protocol=irn";
  const code = createQrCode(value);
  assert.equal(code.value, value);
  assert.ok(code.grid.length > 0);
});

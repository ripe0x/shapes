import {test} from "node:test";
import assert from "node:assert/strict";

import {bufferGas} from "./tx";
import {PACKS_TX_GAS_CAP, packPaymentBalanceError, packsDeploymentFor, packsGasBudget} from "./packs";

test("Packs follow the site's chain and use the matching contract set", () => {
  assert.equal(packsDeploymentFor(1)?.packs, "0xf21514b090da7df4390803497d6ae673801e5ca7");
  assert.equal(packsDeploymentFor(11155111)?.packs, "0x6DB763fB3FA5B988BEDa8E7a4288c79d7E1E6f45");
  assert.equal(packsDeploymentFor(31337), null);
});

test("Packs transactions respect the per-transaction cap when the block limit is higher", () => {
  assert.equal(PACKS_TX_GAS_CAP, 16_777_216n);
  assert.equal(packsGasBudget(200_000_000n), PACKS_TX_GAS_CAP);
  assert.ok(bufferGas(11_184_811n) <= packsGasBudget(200_000_000n));
  assert.ok(bufferGas(11_184_812n) > packsGasBudget(200_000_000n));
  assert.equal(packsGasBudget(10_000_000n), 8_000_000n);
});

test("a pack payment checks the wallet balance before an RPC call hides OutOfFunds", () => {
  assert.equal(packPaymentBalanceError(16_307_083_507_946_864n, 33_000_000_000_000_000n),
    "This wallet has 0.016307083507946864 ETH. The pack needs 0.033 ETH plus ETH for network gas.");
  assert.equal(packPaymentBalanceError(33_000_000_000_000_000n, 33_000_000_000_000_000n),
    "This wallet has 0.033 ETH. The pack needs 0.033 ETH plus ETH for network gas.");
  assert.equal(packPaymentBalanceError(34_000_000_000_000_000n, 33_000_000_000_000_000n), null);
});

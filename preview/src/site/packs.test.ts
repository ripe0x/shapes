import {test} from "node:test";
import assert from "node:assert/strict";

import {bufferGas} from "./tx";
import {PACKS_TX_GAS_CAP, packsDeploymentFor, packsGasBudget} from "./packs";

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

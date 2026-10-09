import {test} from "node:test";
import assert from "node:assert/strict";

import {bufferGas} from "./tx";
import {packsGasBudget, SEPOLIA_TX_GAS_CAP} from "./packs";

test("Packs transactions respect Sepolia's per-transaction cap when the block limit is higher", () => {
  assert.equal(SEPOLIA_TX_GAS_CAP, 16_777_216n);
  assert.equal(packsGasBudget(200_000_000n), SEPOLIA_TX_GAS_CAP);
  assert.ok(bufferGas(11_184_811n) <= packsGasBudget(200_000_000n));
  assert.ok(bufferGas(11_184_812n) > packsGasBudget(200_000_000n));
  assert.equal(packsGasBudget(10_000_000n), 8_000_000n);
});

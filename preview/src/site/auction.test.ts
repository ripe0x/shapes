import {strict as assert} from "node:assert";
import {test} from "node:test";
import {parseBidEth, unitsToEth} from "./auction";
import {DENOMINATIONS, UNIT} from "../canonical/denominations";

test("unitsToEth renders every denomination on the ladder", () => {
  for (const wei of DENOMINATIONS) {
    const units = wei / UNIT;
    assert.equal(parseBidEth(unitsToEth(units)), wei);
  }
});

test("unitsToEth does not collapse the smallest unit to zero", () => {
  assert.notEqual(unitsToEth(1n), "0");
  assert.equal(parseBidEth(unitsToEth(1n)), UNIT);
});

test("parseBidEth accepts whole units and rejects finer amounts", () => {
  assert.equal(parseBidEth(""), 0n);
  assert.equal(parseBidEth("1"), 10n ** 18n);
  assert.equal(parseBidEth(unitsToEth(3n)), 3n * UNIT);
  assert.equal(parseBidEth("abc"), -1n);
  assert.equal(parseBidEth("-1"), -1n);
  // Half a unit is not expressible as cards.
  const halfUnit = unitsToEth(1n) + "5";
  assert.equal(parseBidEth(halfUnit), -1n);
});

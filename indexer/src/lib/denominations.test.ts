import assert from "node:assert/strict";
import test from "node:test";

import {DENOMINATIONS_WEI, backingForDenomIndex, denomIndexOfWei} from "./denominations.ts";

test("maps every denomination in both directions", () => {
  assert.equal(DENOMINATIONS_WEI.length, 9);
  for (let i = 0; i < DENOMINATIONS_WEI.length; i++) {
    assert.equal(denomIndexOfWei(DENOMINATIONS_WEI[i]!), i);
    assert.equal(backingForDenomIndex(i), DENOMINATIONS_WEI[i]);
  }
});

test("an off-ladder amount has no denomination index", () => {
  assert.equal(denomIndexOfWei(100_000_000_000_000n), -1);
});

test("an out-of-range denomination index throws", () => {
  assert.throws(() => backingForDenomIndex(9), /out of range 0\.\.8/);
});

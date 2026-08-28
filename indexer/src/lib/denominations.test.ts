import assert from "node:assert/strict";
import test from "node:test";

import {
  MAINNET_DENOMINATIONS_WEI,
  TESTNET_DENOMINATIONS_WEI,
  backingForDenomIndex,
  denominationsForLadder,
  denomIndexOfWei,
} from "./denominations.ts";

test("selects the immutable ladder explicitly", () => {
  assert.equal(denominationsForLadder(undefined), MAINNET_DENOMINATIONS_WEI);
  assert.equal(denominationsForLadder("mainnet"), MAINNET_DENOMINATIONS_WEI);
  assert.equal(denominationsForLadder("testnet"), TESTNET_DENOMINATIONS_WEI);
  assert.throws(() => denominationsForLadder("staging"), /unsupported SHAPES_LADDER staging/);
});

test("maps every mainnet and testnet denomination in both directions", () => {
  for (const ladder of [MAINNET_DENOMINATIONS_WEI, TESTNET_DENOMINATIONS_WEI]) {
    assert.equal(ladder.length, 9);
    for (let i = 0; i < ladder.length; i++) {
      assert.equal(denomIndexOfWei(ladder[i]!, ladder), i);
      assert.equal(backingForDenomIndex(i, ladder), ladder[i]);
    }
  }
});

test("Sepolia Shape #0 backing is testnet denomination zero", () => {
  assert.equal(denomIndexOfWei(100_000_000_000_000n, TESTNET_DENOMINATIONS_WEI), 0);
  assert.equal(denomIndexOfWei(100_000_000_000_000n, MAINNET_DENOMINATIONS_WEI), -1);
});

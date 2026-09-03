import assert from "node:assert/strict";
import test from "node:test";
import {formatCountdown, mintOpensIn} from "./mintOpensIn";

test("mintStart 0 means already open, regardless of now", () => {
  assert.deepEqual(mintOpensIn(0, 0n), {open: true, secondsLeft: 0});
  assert.deepEqual(mintOpensIn(Date.now(), 0n), {open: true, secondsLeft: 0});
});

test("now before mintStart is not open, with seconds remaining rounded up", () => {
  const mintStart = 1_000n; // unix seconds
  const now = 999_000; // 1 second before, in ms
  assert.deepEqual(mintOpensIn(now, mintStart), {open: false, secondsLeft: 1});
});

test("now at or after mintStart is open", () => {
  const mintStart = 1_000n;
  assert.equal(mintOpensIn(1_000_000, mintStart).open, true);
  assert.equal(mintOpensIn(1_000_001, mintStart).open, true);
});

test("formatCountdown drops the hours place under an hour", () => {
  assert.equal(formatCountdown(59), "0:59");
  assert.equal(formatCountdown(60), "1:00");
  assert.equal(formatCountdown(3_599), "59:59");
});

test("formatCountdown includes hours once past one", () => {
  assert.equal(formatCountdown(3_600), "1:00:00");
  assert.equal(formatCountdown(3_661), "1:01:01");
});

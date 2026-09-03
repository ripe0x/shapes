import assert from "node:assert/strict";
import test from "node:test";
import {formatCountdown, formatMintDate, mintOpensIn} from "./mintOpensIn";

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

test("a named time zone gives one label whatever zone the runtime is in", () => {
  // The label a server renders and the label the browser renders on first paint must match, or
  // React reports a hydration text mismatch on the landing page's mint heading.
  const ms = 1_788_462_000_000;
  assert.equal(formatMintDate(ms, "UTC"), "September 3 at 7:00 PM UTC");
  assert.notEqual(formatMintDate(ms, "America/New_York"), formatMintDate(ms, "UTC"));
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

import {test} from "node:test";
import assert from "node:assert/strict";

import {clearStoredActionNotice, storeActionNotice, takeStoredActionNotice} from "./actionNotice";

/** A minimal sessionStorage stand-in, installed as `window` for the duration of one test so
 *  these functions exercise their real read/write path instead of the "storage unavailable"
 *  fallback that runs under plain Node. */
function withFakeSessionStorage<T>(run: () => T): T {
  const backing = new Map<string, string>();
  const fakeWindow = {
    sessionStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    },
  };
  const previous = (globalThis as {window?: unknown}).window;
  (globalThis as {window?: unknown}).window = fakeWindow;
  try {
    return run();
  } finally {
    (globalThis as {window?: unknown}).window = previous;
  }
}

test("takeStoredActionNotice returns null without a prior store call", () => {
  withFakeSessionStorage(() => {
    assert.equal(takeStoredActionNotice(), null);
  });
});

test("storeActionNotice round-trips a notice, including bigint token ids, exactly once", () => {
  withFakeSessionStorage(() => {
    storeActionNotice({title: "Shape #5 grew", detail: "1 Shape was absorbed.", hash: "0xabc", tokenIds: [5n, 12n]});
    assert.deepEqual(takeStoredActionNotice(), {
      title: "Shape #5 grew",
      detail: "1 Shape was absorbed.",
      hash: "0xabc",
      tokenIds: [5n, 12n],
    });
    // Consumed: a second read after the same store finds nothing.
    assert.equal(takeStoredActionNotice(), null);
  });
});

test("clearStoredActionNotice removes a notice before it is ever taken", () => {
  withFakeSessionStorage(() => {
    storeActionNotice({title: "t", detail: "d", hash: "0x1", tokenIds: []});
    clearStoredActionNotice();
    assert.equal(takeStoredActionNotice(), null);
  });
});

test("takeStoredActionNotice does not throw when window is unavailable", () => {
  assert.equal(takeStoredActionNotice(), null);
});

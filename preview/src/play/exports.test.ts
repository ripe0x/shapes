import { test } from "node:test";
import assert from "node:assert/strict";

import { exportFilename } from "./exports";

const seed = 0x1a2b3c4d5e6f7890n;
// seedHex8 takes the first 8 hex chars of the full 64-char zero-padded seed, not a raw
// `toString(16)` (which would drop leading zeros and vary in length).
const hex8 = seed.toString(16).padStart(64, "0").slice(0, 8);

test("exportFilename: card", () => {
  assert.equal(exportFilename("card", seed, "0.01"), `shape-0.01eth-${hex8}.png`);
});

test("exportFilename: square", () => {
  assert.equal(exportFilename("square", seed, "100"), `shape-square-100eth-${hex8}.png`);
});

test("exportFilename: ladder ignores denomLabel", () => {
  assert.equal(exportFilename("ladder", seed), `shape-ladder-${hex8}.png`);
});

test("exportFilename: first 8 hex chars come from the zero-padded 64-char seed", () => {
  const small = 0x1n;
  assert.equal(exportFilename("ladder", small), "shape-ladder-00000000.png");
});

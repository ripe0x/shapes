import { test } from "node:test";
import assert from "node:assert/strict";

import { exportFilename, composeGifSvgs } from "./exports";
import { composeNodes, emptySession, keepCard, liveNodes } from "./session";

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

test("exportFilename: gif", () => {
  assert.equal(exportFilename("gif", seed, "0.1"), `shape-compose-0.1eth-${hex8}.gif`);
});

test("exportFilename: first 8 hex chars come from the zero-padded 64-char seed", () => {
  const small = 0x1n;
  assert.equal(exportFilename("ladder", small), "shape-ladder-00000000.png");
});

test("composeGifSvgs: one frame per cell plus an empty first frame and 8 holds of the finished card", () => {
  let s = emptySession();
  s = keepCard(s, 1, 0x1111n); // 0.05 ETH
  s = keepCard(s, 1, 0x2222n); // 0.05 ETH -> sum 0.1 ETH, denomIndex 2 (4x4 = 16 cells)
  const [a, b] = liveNodes(s);
  const composed = composeNodes(s, [a.key, b.key]);
  const result = liveNodes(composed)[0];

  const frames = composeGifSvgs(result, false);
  const cellCount = 16; // 4x4 grid at denomIndex 2
  assert.equal(frames.length, cellCount + 1 + 8);
  assert.ok(frames[0].includes(`<rect x="0" y="0" width="250" height="350" fill="#000"/></svg>`), "empty frame has the background rect and nothing else");
  assert.equal(frames[frames.length - 1], frames[frames.length - 8]); // hold frames are identical
  assert.notEqual(frames[0], frames[1]); // first cell frame differs from the empty frame
});

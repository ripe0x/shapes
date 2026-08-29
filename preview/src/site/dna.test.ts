import {test} from "node:test";
import assert from "node:assert/strict";

import {
  sampleComposeTraced,
  sampleSplitChildTraced,
  type LastMergeDonors,
  type SampleBurn,
  type SampleDonor,
} from "../canonical/sampling";
import {
  classifyDna,
  deriveComposeDna,
  deriveSeedDna,
  deriveSplitDna,
  geometryPercents,
  type RawComposeRecord,
  type RawShapeState,
  type RawSplitOrigin,
} from "./dna";

test("classifyDna: depth > 0 always wins", () => {
  assert.equal(classifyDna(1, 0), "compose");
  assert.equal(classifyDna(2, 25), "compose");
});

test("classifyDna: depth 0 falls to modules length", () => {
  assert.equal(classifyDna(0, 12), "split");
  assert.equal(classifyDna(0, 0), "seed");
});

test("geometryPercents: a full-bleed single-cell grid (denomIndex 8, 1x1) covers the whole card", () => {
  const state: RawShapeState = {seed: 1n, denomIndex: 8, inkGene: 0, modules: new Uint8Array()};
  const result = deriveSeedDna(state);
  const pct = geometryPercents(result.geometry);
  assert.ok(pct.widthPct > 0 && pct.widthPct <= 100);
  assert.ok(pct.heightPct > 0 && pct.heightPct <= 100);
  assert.ok(pct.leftPct >= 0 && pct.topPct >= 0);
});

test("deriveSeedDna: seed-derived token has no donors and a full cell array", () => {
  const state: RawShapeState = {seed: 0xabc123n, denomIndex: 4, inkGene: 2, modules: new Uint8Array()};
  const result = deriveSeedDna(state);
  assert.equal(result.kind, "seed");
  if (result.kind !== "seed") return;
  assert.equal(result.cells.length, result.bytes.length);
  assert.equal(result.geometry.cols * result.geometry.rows, result.bytes.length);
});

test("deriveSeedDna: a materialized snapshot with no recoverable provenance decodes its own bytes rather than re-deriving from the seed", () => {
  // A split parent snapshot has no token id, so drilling into it (dna.ts's loadDnaFromSnapshot
  // split-parent case) can only fall back to deriveSeedDna. Its stored bytes must be shown as-is,
  // not silently replaced by a fresh grammar-v1 derivation that would not match what was recorded.
  const seedOnly: RawShapeState = {seed: 0x77n, denomIndex: 2, inkGene: 1, modules: new Uint8Array()};
  const fromSeed = deriveSeedDna(seedOnly);

  // A byte array distinct from what this seed derives (reversed order; multi-cell grid so this
  // differs unless the sequence happens to be a palindrome, which it is not for this seed/denom).
  const reversed = Uint8Array.from(fromSeed.bytes).reverse();
  assert.notDeepEqual(reversed, fromSeed.bytes);

  const materialized: RawShapeState = {seed: 0x77n, denomIndex: 2, inkGene: 1, modules: reversed};
  const result = deriveSeedDna(materialized);
  assert.equal(result.kind, "seed");
  assert.deepEqual(result.bytes, reversed);
});

test("deriveComposeDna: reconstruction matching the live bytes returns a compose result with canonical donor order", () => {
  const survivor: SampleDonor = {seed: 0x1111n, denomIndex: 3, inkGene: 2};
  const burns: SampleBurn[] = [
    {tokenId: 9n, seed: 0x3333n, denomIndex: 1, inkGene: 1},
    {tokenId: 2n, seed: 0x2222n, denomIndex: 0, inkGene: 4},
  ];
  const newIndex = 4;
  const {bytes: liveModules} = sampleComposeTraced(survivor, burns, newIndex);

  const state: RawShapeState = {seed: survivor.seed, denomIndex: newIndex, inkGene: 5, modules: liveModules};
  const record: RawComposeRecord = {
    survivorDenomIndex: survivor.denomIndex,
    survivorInkGene: survivor.inkGene,
    survivorModules: new Uint8Array(),
    // Deliberately in calldata order (not ascending by id), matching how the contract stores inputs.
    inputs: burns.map((b) => ({id: b.tokenId, seed: b.seed, denomIndex: b.denomIndex, inkGene: b.inkGene, modules: new Uint8Array()})),
  };

  const result = deriveComposeDna(state, record, 1);
  assert.equal(result.kind, "compose");
  if (result.kind !== "compose") return;
  assert.equal(result.donors.length, 3);
  assert.deepEqual(
    result.donors.map((d) => d.id),
    ["survivor", "2", "9"], // survivor first, then burns ascending by id
  );
  assert.equal(result.cells.length, liveModules.length);
  assert.equal(result.survivorDepth, 0); // depth 1 read this record; the survivor's own depth is one less
});

test("deriveComposeDna: a live-bytes mismatch surfaces as an explicit error, never a silent render", () => {
  const survivor: SampleDonor = {seed: 0x1111n, denomIndex: 3, inkGene: 2};
  const burns: SampleBurn[] = [{tokenId: 5n, seed: 0x2222n, denomIndex: 1, inkGene: 1}];
  const newIndex = 4;
  const {bytes: liveModules} = sampleComposeTraced(survivor, burns, newIndex);
  const corrupted = new Uint8Array(liveModules);
  corrupted[0] = corrupted[0] ^ 0x01; // flip a bit, unless it happens to already be 0 - guard below
  if (corrupted[0] === liveModules[0]) corrupted[0] = corrupted[0] ^ 0x02;

  const state: RawShapeState = {seed: survivor.seed, denomIndex: newIndex, inkGene: 5, modules: corrupted};
  const record: RawComposeRecord = {
    survivorDenomIndex: survivor.denomIndex,
    survivorInkGene: survivor.inkGene,
    survivorModules: new Uint8Array(),
    inputs: burns.map((b) => ({id: b.tokenId, seed: b.seed, denomIndex: b.denomIndex, inkGene: b.inkGene, modules: new Uint8Array()})),
  };

  const result = deriveComposeDna(state, record, 1);
  assert.equal(result.kind, "mismatch");
});

test("deriveSplitDna (grammar branch): reconstruction matching the live bytes returns a split result with pool info", () => {
  const parent: SampleDonor = {seed: 0x9999n, denomIndex: 4, inkGene: 3};
  const childDenom = 3;
  const childIndex = 1;
  const {bytes: liveModules} = sampleSplitChildTraced(parent, childDenom, childIndex);

  const state: RawShapeState = {seed: 0xffffn, denomIndex: childDenom, inkGene: parent.inkGene, modules: liveModules};
  const origin: RawSplitOrigin = {
    parentSeed: parent.seed,
    parentId: 42n,
    parentDenomIndex: parent.denomIndex,
    parentInkGene: parent.inkGene,
    parentModules: new Uint8Array(),
    childIndex,
  };

  const result = deriveSplitDna(state, origin);
  assert.equal(result.kind, "split");
  if (result.kind !== "split") return;
  assert.equal(result.branch, "grammar");
  assert.equal(result.parent.seed, parent.seed);
  assert.equal(result.parent.denomIndex, parent.denomIndex);
  assert.equal(result.parent.materialized, false);
  assert.equal(result.cells.length, liveModules.length);
  // The grammar pool card renders at the CHILD's own denomination, not the parent's.
  assert.ok(result.pool != null);
  assert.equal(result.pool!.denomIndex, childDenom);
  assert.equal(result.poolLength, result.pool!.modules.length);
});

test("deriveSplitDna: a live-bytes mismatch surfaces as an explicit error", () => {
  const parent: SampleDonor = {seed: 0x9999n, denomIndex: 4, inkGene: 3};
  const childDenom = 3;
  const childIndex = 1;
  const {bytes: liveModules} = sampleSplitChildTraced(parent, childDenom, childIndex);
  const corrupted = new Uint8Array(liveModules);
  corrupted[0] = corrupted[0] ^ 0x01;
  if (corrupted[0] === liveModules[0]) corrupted[0] = corrupted[0] ^ 0x02;

  const state: RawShapeState = {seed: 0xffffn, denomIndex: childDenom, inkGene: parent.inkGene, modules: corrupted};
  const origin: RawSplitOrigin = {
    parentSeed: parent.seed,
    parentId: 42n,
    parentDenomIndex: parent.denomIndex,
    parentInkGene: parent.inkGene,
    parentModules: new Uint8Array(),
    childIndex,
  };

  const result = deriveSplitDna(state, origin);
  assert.equal(result.kind, "mismatch");
});

test("deriveSplitDna (record branch): pool is the compose record's donor modules, not the parent's own snapshot", () => {
  const parentSeed = 0x9999n;
  const parentInkGene = 3;
  const childDenom = 1;
  const childIndex = 0;

  const lastMergeDonors: LastMergeDonors = {
    survivor: {seed: parentSeed, denomIndex: 2, inkGene: parentInkGene},
    inputs: [
      {tokenId: 7n, seed: 0xaaan, denomIndex: 0, inkGene: 1},
      {tokenId: 3n, seed: 0xbbbn, denomIndex: 0, inkGene: 2},
    ],
  };
  const {bytes: liveModules} = sampleSplitChildTraced(
    {seed: parentSeed, denomIndex: 4, inkGene: parentInkGene},
    childDenom,
    childIndex,
    undefined,
    lastMergeDonors,
  );

  const state: RawShapeState = {seed: 0xccccn, denomIndex: childDenom, inkGene: parentInkGene, modules: liveModules};
  const origin: RawSplitOrigin = {
    parentSeed,
    parentId: 99n,
    parentDenomIndex: 4, // the parent's own (post-compose) denomination, informational only
    parentInkGene,
    parentModules: new Uint8Array([0x00]), // informational snapshot; must play no part in reconstruction
    childIndex,
  };
  const record: RawComposeRecord = {
    survivorDenomIndex: 2,
    survivorInkGene: parentInkGene,
    survivorModules: new Uint8Array(),
    // Deliberately not sorted by id, matching how the contract stores inputs.
    inputs: [
      {id: 7n, seed: 0xaaan, denomIndex: 0, inkGene: 1, modules: new Uint8Array()},
      {id: 3n, seed: 0xbbbn, denomIndex: 0, inkGene: 2, modules: new Uint8Array()},
    ],
  };

  const result = deriveSplitDna(state, origin, record);
  assert.equal(result.kind, "split");
  if (result.kind !== "split") return;
  assert.equal(result.branch, "record");
  assert.equal(result.pool, undefined, "record branch has no single-grid pool card");
  assert.ok(result.poolLength > 0);
  assert.equal(result.cells.length, liveModules.length);
});

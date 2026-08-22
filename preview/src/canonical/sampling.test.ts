import {test} from "node:test";
import assert from "node:assert/strict";

import {composeShape, KIND_ORDER} from "./render";
import {cellCountAt} from "./denominations";
import {encodeModuleByte, kindIndexOf} from "./moduleCodec";
import {
  composeSampledShape,
  composeSampleSeedInputs,
  sampleCompose,
  sampleComposeTraced,
  sampleSplitChild,
  sampleSplitChildTraced,
  splitSampleSeedInputs,
  type SampleBurn,
  type SampleDonor,
} from "./sampling";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const survivor: SampleDonor = {
  seed: 0x1111n,
  denomIndex: 3,
  inkGene: 2,
};

const burns: SampleBurn[] = [
  {tokenId: 5n, seed: 0x2222n, denomIndex: 1, inkGene: 3},
  {tokenId: 2n, seed: 0x3333n, denomIndex: 4, inkGene: 1},
  {tokenId: 9n, seed: 0x4444n, denomIndex: 0, inkGene: 4},
];

test("sampleCompose: deterministic for identical inputs", () => {
  const a = sampleCompose(survivor, burns, 5);
  const b = sampleCompose(survivor, burns, 5);
  assert.equal(bytesEqual(a, b), true);
  assert.equal(a.length, cellCountAt(5));
});

test("sampleCompose: burn calldata order does not affect the result", () => {
  const inOrder = sampleCompose(survivor, burns, 5);
  const shuffled = sampleCompose(survivor, [burns[2], burns[0], burns[1]], 5);
  const reversed = sampleCompose(survivor, [...burns].reverse(), 5);
  assert.equal(bytesEqual(inOrder, shuffled), true);
  assert.equal(bytesEqual(inOrder, reversed), true);
});

test("sampleCompose: different newIndex or different donors change the result", () => {
  const a = sampleCompose(survivor, burns, 5);
  const b = sampleCompose(survivor, burns, 6);
  assert.equal(bytesEqual(a, b), false);

  const otherSurvivor: SampleDonor = {...survivor, seed: 0x9999n};
  const c = sampleCompose(otherSurvivor, burns, 5);
  assert.equal(bytesEqual(a, c), false);
});

test("sampleCompose: every donor is reachable under units weighting", () => {
  // Three equal-weight donors (denomIndex 0 -> unitsAt = 1 each), each materialized with a
  // single, distinct marker byte so its cells are identifiable in the output. Sampling into
  // the largest grid (denomIndex 0, 25 cells) gives each donor an independent 1/3 chance per
  // cell; over 25 draws every donor is expected to appear. The PRNG is deterministic, so this
  // is a fixed check, not a flaky probabilistic one.
  const markerA = encodeModuleByte(0, false, 0); // circle, outline
  const markerB = encodeModuleByte(1, true, 0); // square, solid
  const markerC = encodeModuleByte(5, false, 0); // diamond, outline

  const s: SampleDonor = {
    seed: 0xaaan,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array([markerA]),
  };
  const b1: SampleBurn = {
    tokenId: 1n,
    seed: 0xbbbn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array([markerB]),
  };
  const b2: SampleBurn = {
    tokenId: 2n,
    seed: 0xcccn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array([markerC]),
  };

  const out = sampleCompose(s, [b1, b2], 0);
  assert.equal(out.length, 25);
  assert.equal(out.includes(markerA), true, "survivor never selected");
  assert.equal(out.includes(markerB), true, "burn 1 never selected");
  assert.equal(out.includes(markerC), true, "burn 2 never selected");
});

test("sampleCompose: an original (unmaterialized) donor derives modules from composeShape", () => {
  // A single-donor compose (no burns) is a resample of the donor's own grammar-v1 modules:
  // every output byte must appear in the donor's own encoded module list.
  const amountWei = 500_000_000_000_000_000n; // denomIndex 3
  const composition = composeShape(survivor.seed, amountWei, survivor.inkGene);
  const derivedBytes = new Set(
    composition.modules.map((m) => encodeModuleByte(kindIndexOf(m.kind), m.solid, m.rot)),
  );

  const out = sampleCompose(survivor, [], 3);
  for (const b of out) {
    assert.equal(derivedBytes.has(b), true, `sampled byte 0x${b.toString(16)} not in donor's own modules`);
  }
});

test("sampleSplitChild: deterministic and depends on childIndex", () => {
  const parent: SampleDonor = {seed: 0x5555n, denomIndex: 2, inkGene: 5};
  const a = sampleSplitChild(parent, 4, 0);
  const b = sampleSplitChild(parent, 4, 0);
  assert.equal(bytesEqual(a, b), true);

  const c = sampleSplitChild(parent, 4, 1);
  assert.equal(bytesEqual(a, c), false);
});

test("sampleSplitChild: childIndex 256 apart does not alias", () => {
  const parent: SampleDonor = {seed: 0x5555n, denomIndex: 2, inkGene: 5};
  assert.equal(bytesEqual(sampleSplitChild(parent, 4, 0), sampleSplitChild(parent, 4, 256)), false);
  assert.equal(bytesEqual(sampleSplitChild(parent, 4, 1), sampleSplitChild(parent, 4, 257)), false);
});

test("sampleSplitChild: cell count follows the child denomination's grid", () => {
  const parent: SampleDonor = {seed: 0x5555n, denomIndex: 2, inkGene: 5};
  assert.equal(sampleSplitChild(parent, 4, 0).length, cellCountAt(4));
  assert.equal(sampleSplitChild(parent, 0, 0).length, cellCountAt(0));
});

test("sampleSplitChild: a 1-module parent fills every child cell with that module", () => {
  const markerByte = encodeModuleByte(7, true, 180); // rtriangle, solid, rot 180
  const parent: SampleDonor = {
    seed: 0x6666n,
    denomIndex: 8,
    inkGene: 0,
    modules: new Uint8Array([markerByte]),
  };

  const child = sampleSplitChild(parent, 0, 0); // denomIndex 0 -> 25 cells
  assert.equal(child.length, 25);
  for (const b of child) assert.equal(b, markerByte);
});

test("composeSampledShape: decodes bytes with no random draws and matches seed-path geometry", () => {
  const denomIndex = 4; // 3x3 grid, 9 cells
  const modules = new Uint8Array([
    encodeModuleByte(kindIndexOf("circle"), true, 0),
    encodeModuleByte(kindIndexOf("square"), false, 0),
    encodeModuleByte(kindIndexOf("triangle"), true, 90),
    encodeModuleByte(kindIndexOf("half"), false, 180),
    encodeModuleByte(kindIndexOf("quarter"), true, 270),
    encodeModuleByte(kindIndexOf("diamond"), false, 0),
    encodeModuleByte(kindIndexOf("halfsquare"), true, 90),
    encodeModuleByte(kindIndexOf("rtriangle"), false, 180),
    encodeModuleByte(kindIndexOf("line"), false, 90),
  ]);

  const card = composeSampledShape(modules, denomIndex, 4);
  assert.equal(card.draws, 0);
  assert.equal(card.modules.length, 9);
  assert.equal(card.denomIndex, denomIndex);
  for (let i = 0; i < modules.length; i++) {
    assert.equal(KIND_ORDER.indexOf(card.modules[i].kind), modules[i] & 0x0f);
  }

  // Positions/size/weight are pure functions of the grid, independent of seed: compare against
  // the seed-drawn path at the same denomination (any seed).
  const seedCard = composeShape(0x7777n, card.amountWei, 4);
  for (let i = 0; i < card.modules.length; i++) {
    assert.equal(card.modules[i].cx, seedCard.modules[i].cx);
    assert.equal(card.modules[i].cy, seedCard.modules[i].cy);
    assert.equal(card.modules[i].weight, seedCard.modules[i].weight);
  }
});

test("composeSampledShape: rejects a byte array of the wrong length", () => {
  assert.throws(() => composeSampledShape(new Uint8Array(8), 4, 0)); // denomIndex 4 wants 9
});

/* ------------------------------------------------------------------ *
 * Traced sampling: sampleCompose/sampleSplitChild delegate to the traced core, so equivalence
 * is structural, not incidental — these tests pin that down and check the trace itself is
 * internally consistent.
 * ------------------------------------------------------------------ */

test("sampleComposeTraced: bytes match sampleCompose for default, shuffled and reversed burn order", () => {
  const untracedInOrder = sampleCompose(survivor, burns, 5);
  const untracedShuffled = sampleCompose(survivor, [burns[2], burns[0], burns[1]], 5);
  const untracedReversed = sampleCompose(survivor, [...burns].reverse(), 5);

  const tracedInOrder = sampleComposeTraced(survivor, burns, 5);
  const tracedShuffled = sampleComposeTraced(survivor, [burns[2], burns[0], burns[1]], 5);
  const tracedReversed = sampleComposeTraced(survivor, [...burns].reverse(), 5);

  assert.equal(bytesEqual(tracedInOrder.bytes, untracedInOrder), true);
  assert.equal(bytesEqual(tracedShuffled.bytes, untracedShuffled), true);
  assert.equal(bytesEqual(tracedReversed.bytes, untracedReversed), true);
  // Every trace byte agrees with the parallel bytes array, cell for cell.
  for (let j = 0; j < tracedInOrder.bytes.length; j++) {
    assert.equal(tracedInOrder.trace[j].byte, tracedInOrder.bytes[j]);
  }
});

test("sampleComposeTraced: bytes match sampleCompose when donors are materialized", () => {
  const markerA = encodeModuleByte(0, false, 0); // circle, outline
  const markerB = encodeModuleByte(1, true, 0); // square, solid
  const markerC = encodeModuleByte(5, false, 0); // diamond, outline

  const s: SampleDonor = {seed: 0xaaan, denomIndex: 0, inkGene: 0, modules: new Uint8Array([markerA])};
  const b1: SampleBurn = {
    tokenId: 1n,
    seed: 0xbbbn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array([markerB]),
  };
  const b2: SampleBurn = {
    tokenId: 2n,
    seed: 0xcccn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array([markerC]),
  };

  const untraced = sampleCompose(s, [b1, b2], 0);
  const {bytes, trace} = sampleComposeTraced(s, [b1, b2], 0);
  assert.equal(bytesEqual(bytes, untraced), true);

  // A single-module donor's every draw resolves to moduleIndex 0, and each donor's own marker
  // byte, decoded from the correct donor id and materialized flag (all three are materialized
  // here, each with a one-byte array).
  const byId = new Map(trace.map((cell) => [cell.donorId, cell]));
  for (const cell of trace) {
    assert.equal(cell.moduleIndex, 0);
    assert.equal(cell.donorMaterialized, true);
    if (cell.donorId === "survivor") assert.equal(cell.byte, markerA);
    if (cell.donorId === "1") assert.equal(cell.byte, markerB);
    if (cell.donorId === "2") assert.equal(cell.byte, markerC);
  }
  assert.equal(byId.has("survivor"), true, "survivor never selected");
  assert.equal(byId.has("1"), true, "burn 1 never selected");
  assert.equal(byId.has("2"), true, "burn 2 never selected");
});

test("sampleComposeTraced: an unmaterialized donor is flagged accordingly and donorIndex 0 is the survivor", () => {
  const {trace} = sampleComposeTraced(survivor, burns, 5);
  for (const cell of trace) {
    if (cell.donorIndex === 0) {
      assert.equal(cell.donorId, "survivor");
      assert.equal(cell.donorMaterialized, false); // `survivor` fixture carries no `modules`
    }
  }
});

test("composeSampleSeedInputs: burnSeedFold is order-invariant and matches the trace's own stream", () => {
  const inOrder = composeSampleSeedInputs(survivor, burns, 5);
  const shuffled = composeSampleSeedInputs(survivor, [burns[2], burns[0], burns[1]], 5);
  assert.equal(inOrder.burnSeedFold, shuffled.burnSeedFold);
  assert.equal(inOrder.sampleSeed, shuffled.sampleSeed);
  assert.equal(inOrder.survivorSeed, survivor.seed);
  assert.equal(inOrder.newIndex, 5);
});

test("sampleSplitChildTraced: bytes match sampleSplitChild, including past the uint8 range", () => {
  const parent: SampleDonor = {seed: 0x5555n, denomIndex: 2, inkGene: 5};

  const untraced = sampleSplitChild(parent, 4, 0);
  const {bytes, trace, parentMaterialized, parentCellCount} = sampleSplitChildTraced(parent, 4, 0);
  assert.equal(bytesEqual(bytes, untraced), true);
  assert.equal(parentMaterialized, false);
  assert.equal(parentCellCount, cellCountAt(2));
  for (let j = 0; j < bytes.length; j++) assert.equal(trace[j].byte, bytes[j]);

  const untracedWide = sampleSplitChild(parent, 4, 256);
  const tracedWide = sampleSplitChildTraced(parent, 4, 256);
  assert.equal(bytesEqual(tracedWide.bytes, untracedWide), true);
  assert.equal(bytesEqual(tracedWide.bytes, bytes), false);
});

test("sampleSplitChildTraced: a materialized 1-module parent traces every cell to moduleIndex 0", () => {
  const markerByte = encodeModuleByte(7, true, 180); // rtriangle, solid, rot 180
  const parent: SampleDonor = {
    seed: 0x6666n,
    denomIndex: 8,
    inkGene: 0,
    modules: new Uint8Array([markerByte]),
  };

  const {bytes, trace, parentMaterialized, parentCellCount} = sampleSplitChildTraced(parent, 0, 0);
  assert.equal(bytes.length, 25);
  assert.equal(parentMaterialized, true);
  assert.equal(parentCellCount, 1);
  for (const cell of trace) {
    assert.equal(cell.moduleIndex, 0);
    assert.equal(cell.byte, markerByte);
  }
});

test("splitSampleSeedInputs: the seed carries the untruncated childIndex", () => {
  const parent: SampleDonor = {seed: 0x5555n, denomIndex: 2, inkGene: 5};
  const a = splitSampleSeedInputs(parent, 4, 1);
  const wide = splitSampleSeedInputs(parent, 4, 257);
  assert.equal(a.childIndex, 1);
  assert.equal(wide.childIndex, 257);
  assert.notEqual(a.sampleSeed, wide.sampleSeed);
  assert.equal(a.parentSeed, parent.seed);
});

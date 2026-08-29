import {test} from "node:test";
import assert from "node:assert/strict";

import {CANONICAL, composeShape, KIND_ORDER} from "./render";
import {DENOMINATIONS, cellCountAt} from "./denominations";
import {encodeModuleByte, kindIndexOf} from "./moduleCodec";
import {
  composeSampledShape,
  composeSampleSeedInputs,
  effectiveModuleBytes,
  grammarSplitPoolBytes,
  sampleCompose,
  sampleComposeTraced,
  sampleSplitChild,
  sampleSplitChildTraced,
  splitRecordPoolBytes,
  splitSampleSeedInputs,
  type LastMergeDonors,
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
  // Three equal-weight donors (denomIndex 0 -> unitsAt = 1 each), each materialized with 25
  // copies of a distinct marker byte so its cells are identifiable in the output, and so the
  // donor's module count (25) meets the result's cell count (25) under D1' without-replacement
  // module draws (SAMPLING_SPEC.md section 10 invariant 6). Sampling into the largest grid
  // (denomIndex 0, 25 cells) gives each donor an independent 1/3 chance per cell; over 25 draws
  // every donor is expected to appear. The PRNG is deterministic, so this is a fixed check, not
  // a flaky probabilistic one.
  const markerA = encodeModuleByte(0, false, 0); // circle, outline
  const markerB = encodeModuleByte(1, true, 0); // square, solid
  const markerC = encodeModuleByte(5, false, 0); // diamond, outline

  const s: SampleDonor = {
    seed: 0xaaan,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array(25).fill(markerA),
  };
  const b1: SampleBurn = {
    tokenId: 1n,
    seed: 0xbbbn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array(25).fill(markerB),
  };
  const b2: SampleBurn = {
    tokenId: 2n,
    seed: 0xcccn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array(25).fill(markerC),
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
  const amountWei = DENOMINATIONS[survivor.denomIndex];
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

test("sampleSplitChild (grammar branch, D3'): parent.modules is ignored even when the parent is materialized", () => {
  const markerByte = encodeModuleByte(7, true, 180); // rtriangle, solid, rot 180
  const materializedParent: SampleDonor = {
    seed: 0x6666n,
    denomIndex: 8,
    inkGene: 0,
    modules: new Uint8Array([markerByte]),
  };
  const seedDerivedParent: SampleDonor = {seed: 0x6666n, denomIndex: 8, inkGene: 0};

  // No `lastMergeDonors`, so both take the grammar branch: the pool is the parent seed's
  // expression at the CHILD's own denomination, regardless of whether `parent.modules` is set.
  const fromMaterialized = sampleSplitChild(materializedParent, 0, 0);
  const fromSeedDerived = sampleSplitChild(seedDerivedParent, 0, 0);
  assert.equal(bytesEqual(fromMaterialized, fromSeedDerived), true);

  // The one-byte `materializedParent.modules` plays no part: not every cell is `markerByte`.
  assert.equal(
    fromMaterialized.every((b) => b === markerByte),
    false,
    "grammar branch must not fill from the parent's own single stored module",
  );
});

test("sampleSplitChild (record branch, D3'): a 1-module pool fills every child cell with that module", () => {
  const markerByte = encodeModuleByte(7, true, 180); // rtriangle, solid, rot 180
  const parent: SampleDonor = {seed: 0x6666n, denomIndex: 8, inkGene: 0};
  const lastMergeDonors: LastMergeDonors = {
    survivor: {seed: parent.seed, denomIndex: 8, inkGene: 0, modules: new Uint8Array([markerByte])},
    inputs: [],
  };

  const child = sampleSplitChild(parent, 0, 0, CANONICAL, lastMergeDonors); // denomIndex 0 -> 25 cells
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

  // 25 copies each, so donor module count (25) meets the result's cell count (25) — see the
  // note on the previous test.
  const s: SampleDonor = {seed: 0xaaan, denomIndex: 0, inkGene: 0, modules: new Uint8Array(25).fill(markerA)};
  const b1: SampleBurn = {
    tokenId: 1n,
    seed: 0xbbbn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array(25).fill(markerB),
  };
  const b2: SampleBurn = {
    tokenId: 2n,
    seed: 0xcccn,
    denomIndex: 0,
    inkGene: 0,
    modules: new Uint8Array(25).fill(markerC),
  };

  const untraced = sampleCompose(s, [b1, b2], 0);
  const {bytes, trace} = sampleComposeTraced(s, [b1, b2], 0);
  assert.equal(bytesEqual(bytes, untraced), true);

  // Every donor's byte is a uniform fill, so the byte still identifies the donor id regardless
  // of which module index within the donor was drawn (all three are materialized here).
  const byId = new Map<string, typeof trace>();
  for (const cell of trace) {
    assert.equal(cell.donorMaterialized, true);
    assert.ok(cell.moduleIndex >= 0 && cell.moduleIndex < 25, "moduleIndex within donor's range");
    if (cell.donorId === "survivor") assert.equal(cell.byte, markerA);
    if (cell.donorId === "1") assert.equal(cell.byte, markerB);
    if (cell.donorId === "2") assert.equal(cell.byte, markerC);
    byId.set(cell.donorId, [...(byId.get(cell.donorId) ?? []), cell]);
  }
  assert.equal(byId.has("survivor"), true, "survivor never selected");
  assert.equal(byId.has("1"), true, "burn 1 never selected");
  assert.equal(byId.has("2"), true, "burn 2 never selected");

  // D1': module choice within a donor is without replacement, so no donor's moduleIndex repeats
  // across the cells it supplied.
  for (const [, cells] of byId) {
    const indices = cells.map((c) => c.moduleIndex);
    assert.equal(new Set(indices).size, indices.length, "donor's moduleIndex repeated across cells");
  }
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

/* ------------------------------------------------------------------ *
 * D1' (issue #21A): injective compose provenance. Module choice within a donor is without
 * replacement, so no two result cells trace to the same (donorIndex, moduleIndex) pair.
 * ------------------------------------------------------------------ */

test("sampleComposeTraced: no (donorIndex, moduleIndex) pair repeats", () => {
  const {trace} = sampleComposeTraced(survivor, burns, 5);
  const seen = new Set<string>();
  for (const cell of trace) {
    const key = `${cell.donorIndex}:${cell.moduleIndex}`;
    assert.equal(seen.has(key), false, `(donorIndex, moduleIndex) pair ${key} repeated`);
    seen.add(key);
  }
});

test("sampleComposeTraced: a 5x0.01 -> 0.05 compose (issue #21A's example) has 20 distinct (donor, module) pairs", () => {
  // Five 0.01 ETH donors (denomIndex 0, 25 modules each) composing into 0.05 ETH (denomIndex 1,
  // 20 cells): every donor's module count exceeds the result's cell count, and D1' draws each
  // donor module at most once, so the trace's 20 cells must carry 20 distinct source pairs.
  const dustSurvivor: SampleDonor = {seed: 0xd0n, denomIndex: 0, inkGene: 0};
  const dustBurns: SampleBurn[] = [
    {tokenId: 1n, seed: 0xd1n, denomIndex: 0, inkGene: 1},
    {tokenId: 2n, seed: 0xd2n, denomIndex: 0, inkGene: 2},
    {tokenId: 3n, seed: 0xd3n, denomIndex: 0, inkGene: 3},
    {tokenId: 4n, seed: 0xd4n, denomIndex: 0, inkGene: 4},
  ];
  const {bytes, trace} = sampleComposeTraced(dustSurvivor, dustBurns, 1);
  assert.equal(bytes.length, 20);
  assert.equal(trace.length, 20);
  const pairs = new Set(trace.map((c) => `${c.donorIndex}:${c.moduleIndex}`));
  assert.equal(pairs.size, 20, "expected 20 distinct (donor, module) pairs");
});

test("sampleComposeTraced: mixed materialized/seed-derived donors round-trip through composeSampledShape", () => {
  const materializedSurvivor: SampleDonor = {
    seed: 0xe0n,
    denomIndex: 1, // 20 modules, materialized
    inkGene: 2,
    modules: effectiveModuleBytes({seed: 0xe0n, denomIndex: 1, inkGene: 2}),
  };
  const seedDerivedBurn: SampleBurn = {
    tokenId: 7n,
    seed: 0xe1n,
    denomIndex: 4, // 9 modules, seed-derived (no `modules`)
    inkGene: 5,
  };

  const {bytes, trace} = sampleComposeTraced(materializedSurvivor, [seedDerivedBurn], 5); // -> 6 cells
  assert.equal(bytes.length, cellCountAt(5));

  const pairs = new Set(trace.map((c) => `${c.donorIndex}:${c.moduleIndex}`));
  assert.equal(pairs.size, trace.length, "mixed-donor compose must still be injective");

  const card = composeSampledShape(bytes, 5, materializedSurvivor.inkGene);
  assert.equal(card.modules.length, cellCountAt(5));
  for (let i = 0; i < card.modules.length; i++) {
    assert.equal(encodeModuleByte(kindIndexOf(card.modules[i].kind), card.modules[i].solid, card.modules[i].rot), bytes[i]);
  }
});

test("sampleSplitChildTraced (grammar branch): bytes match sampleSplitChild, including past the uint8 range", () => {
  const parent: SampleDonor = {seed: 0x5555n, denomIndex: 2, inkGene: 5};

  const untraced = sampleSplitChild(parent, 4, 0);
  const {bytes, trace, branch, poolLength} = sampleSplitChildTraced(parent, 4, 0);
  assert.equal(bytesEqual(bytes, untraced), true);
  assert.equal(branch, "grammar");
  // The grammar pool is sized to the CHILD's own denomination (4), not the parent's (2).
  assert.equal(poolLength, cellCountAt(4));
  for (let j = 0; j < bytes.length; j++) assert.equal(trace[j].byte, bytes[j]);

  const untracedWide = sampleSplitChild(parent, 4, 256);
  const tracedWide = sampleSplitChildTraced(parent, 4, 256);
  assert.equal(bytesEqual(tracedWide.bytes, untracedWide), true);
  assert.equal(bytesEqual(tracedWide.bytes, bytes), false);
});

test("sampleSplitChildTraced (record branch): a 1-module pool traces every cell to moduleIndex 0", () => {
  const markerByte = encodeModuleByte(7, true, 180); // rtriangle, solid, rot 180
  const parent: SampleDonor = {seed: 0x6666n, denomIndex: 8, inkGene: 0};
  const lastMergeDonors: LastMergeDonors = {
    survivor: {seed: parent.seed, denomIndex: 8, inkGene: 0, modules: new Uint8Array([markerByte])},
    inputs: [],
  };

  const {bytes, trace, branch, poolLength} = sampleSplitChildTraced(parent, 0, 0, CANONICAL, lastMergeDonors);
  assert.equal(bytes.length, 25);
  assert.equal(branch, "record");
  assert.equal(poolLength, 1);
  for (const cell of trace) {
    assert.equal(cell.moduleIndex, 0);
    assert.equal(cell.byte, markerByte);
  }
});

/* ------------------------------------------------------------------ *
 * D3' (issue #21B): the split pool. Record branch draws from the parent's top compose record's
 * donor modules (canonical order); grammar branch draws from the parent seed's expression at the
 * child's own denomination. Neither branch reads the parent's own stored modules.
 * ------------------------------------------------------------------ */

test("splitRecordPoolBytes: survivor first, then inputs sorted ascending by token id regardless of input order", () => {
  const survivorBytes = new Uint8Array([encodeModuleByte(0, false, 0), encodeModuleByte(1, false, 0)]);
  const in1Bytes = new Uint8Array([encodeModuleByte(2, false, 0)]);
  const in2Bytes = new Uint8Array([encodeModuleByte(3, false, 0)]);

  const donorsInOrder: LastMergeDonors = {
    survivor: {seed: 0x1n, denomIndex: 1, inkGene: 0, modules: survivorBytes},
    inputs: [
      {tokenId: 5n, seed: 0x2n, denomIndex: 0, inkGene: 0, modules: in1Bytes},
      {tokenId: 9n, seed: 0x3n, denomIndex: 0, inkGene: 0, modules: in2Bytes},
    ],
  };
  const donorsShuffled: LastMergeDonors = {
    survivor: donorsInOrder.survivor,
    inputs: [...donorsInOrder.inputs].reverse(),
  };

  const poolInOrder = splitRecordPoolBytes(donorsInOrder);
  const poolShuffled = splitRecordPoolBytes(donorsShuffled);
  assert.equal(bytesEqual(poolInOrder, poolShuffled), true, "pool must not depend on input array order");
  assert.equal(
    bytesEqual(poolInOrder, new Uint8Array([...survivorBytes, ...in1Bytes, ...in2Bytes])),
    true,
    "pool must be survivor then inputs ascending by token id",
  );
});

test("grammarSplitPoolBytes: depends on the CHILD's own denomination, not the parent's", () => {
  const parentSeed = 0x7777n;
  const poolAtDenom0 = grammarSplitPoolBytes(parentSeed, 0, 3);
  const poolAtDenom2 = grammarSplitPoolBytes(parentSeed, 2, 3);
  assert.equal(poolAtDenom0.length, cellCountAt(0));
  assert.equal(poolAtDenom2.length, cellCountAt(2));
  assert.equal(bytesEqual(poolAtDenom0, poolAtDenom2), false);
});

test("sampleSplitChildTraced: record branch escapes a 1-module parent's monoculture (issue #21B)", () => {
  // A composed 100 ETH apex (1 module) whose compose record's donors together carry more than
  // one distinct byte: the record branch's pool has variety even though the parent's own
  // materialized geometry does not.
  const parent: SampleDonor = {seed: 0x8888n, denomIndex: 8, inkGene: 0};
  const lastMergeDonors: LastMergeDonors = {
    survivor: {
      seed: parent.seed,
      denomIndex: 7,
      inkGene: 0,
      modules: new Uint8Array([encodeModuleByte(0, false, 0), encodeModuleByte(1, false, 0)]),
    },
    inputs: [
      {
        tokenId: 1n,
        seed: 0x9999n,
        denomIndex: 7,
        inkGene: 0,
        modules: new Uint8Array([encodeModuleByte(2, true, 0), encodeModuleByte(3, true, 0)]),
      },
    ],
  };

  const {bytes} = sampleSplitChildTraced(parent, 5, 0, CANONICAL, lastMergeDonors); // 5 ETH child, 6 cells
  const distinct = new Set(bytes);
  assert.ok(distinct.size > 1, "record-branch split must escape single-module monoculture");
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";

import { centerGene, geneAtCompose, geneAtMint } from "../canonical/ink";
import { unitsAt } from "../canonical/denominations";
import { sampleComposeTraced, type SampleBurn, type SampleDonor } from "../canonical/sampling";
import {
  composeNodes,
  composeSummedIndex,
  emptySession,
  keepCard,
  liveNodes,
  removeNode,
  textSeed,
  TRAY_CAP,
  type PlaySession,
} from "./session";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const seedA = 0x1111n;
const seedB = 0x2222n;

test("composeNodes: matches sampleComposeTraced called directly with the same donors", () => {
  let s = emptySession();
  s = keepCard(s, 1, seedA); // 0.05 ETH
  s = keepCard(s, 1, seedB); // 0.05 ETH -> sum 0.1 ETH, denomIndex 2
  const before = liveNodes(s);
  const [nodeA, nodeB] = before;

  const composed = composeNodes(s, [nodeA.key, nodeB.key]);
  const result = liveNodes(composed)[0];

  const survivorDonor: SampleDonor = { seed: seedA, denomIndex: 1, inkGene: geneAtMint(seedA, 1) };
  const burnDonor: SampleBurn = {
    tokenId: BigInt(nodeB.demoId),
    seed: seedB,
    denomIndex: 1,
    inkGene: geneAtMint(seedB, 1),
  };
  const expected = sampleComposeTraced(survivorDonor, [burnDonor], 2);

  assert.equal(bytesEqual(result.modules!, expected.bytes), true);
  assert.deepEqual(result.trace, expected.trace);
  assert.equal(result.denomIndex, 2);
  assert.equal(result.seed, seedA);
  assert.equal(result.demoId, nodeA.demoId);
});

test("composeNodes: chained compose samples from the stored bytes, not the survivor's bare seed", () => {
  let s = emptySession();
  s = keepCard(s, 1, seedA); // key1 demoId1, 0.05 ETH
  s = keepCard(s, 1, seedB); // key2 demoId2, 0.05 ETH
  const gen1 = liveNodes(s);
  s = composeNodes(s, [gen1[0].key, gen1[1].key]); // -> 0.1 ETH, demoId1, key3

  const firstResult = liveNodes(s)[0];
  assert.equal(firstResult.denomIndex, 2);
  assert.equal(firstResult.demoId, 1);

  // Pool the compose result (0.1 ETH) with four more 0.1 ETH cards -> 0.5 ETH, denomIndex 3.
  const extraSeeds = [0x3333n, 0x4444n, 0x5555n, 0x6666n];
  for (const seed of extraSeeds) s = keepCard(s, 2, seed);

  const liveBeforeSecond = liveNodes(s);
  assert.equal(liveBeforeSecond.length, 5);
  const secondKeys = liveBeforeSecond.map((n) => n.key);

  const chained = composeNodes(s, secondKeys);
  const secondResult = liveNodes(chained)[0];
  assert.equal(secondResult.denomIndex, 3);
  // The first compose's result survives as the survivor (lowest demoId).
  assert.equal(secondResult.demoId, firstResult.demoId);

  const burns: SampleBurn[] = liveBeforeSecond
    .filter((n) => n.key !== firstResult.key)
    .sort((a, b) => a.demoId - b.demoId)
    .map((n) => ({ seed: n.seed, denomIndex: n.denomIndex, inkGene: n.inkGene, tokenId: BigInt(n.demoId) }));

  const materializedSurvivor: SampleDonor = {
    seed: firstResult.seed,
    denomIndex: firstResult.denomIndex,
    inkGene: firstResult.inkGene,
    modules: firstResult.modules,
  };
  const expectedMaterialized = sampleComposeTraced(materializedSurvivor, burns, 3);
  assert.equal(bytesEqual(secondResult.modules!, expectedMaterialized.bytes), true);

  const bareSurvivor: SampleDonor = {
    seed: firstResult.seed,
    denomIndex: firstResult.denomIndex,
    inkGene: firstResult.inkGene,
    // no `modules` -> derived fresh from the seed, ignoring the first compose entirely.
  };
  const expectedBare = sampleComposeTraced(bareSurvivor, burns, 3);
  assert.equal(bytesEqual(secondResult.modules!, expectedBare.bytes), false);
});

test("composeSummedIndex / composeNodes: a sum that lands on no rung is rejected", () => {
  let s = emptySession();
  s = keepCard(s, 0, seedA); // 0.01 ETH
  s = keepCard(s, 0, seedB); // 0.01 ETH -> sum 0.02 ETH, no denomination
  const keys = liveNodes(s).map((n) => n.key);
  assert.equal(composeSummedIndex(liveNodes(s)), -1);
  assert.throws(() => composeNodes(s, keys));
});

test("composeNodes: survivor is the lowest demoId, parents are survivor then burns ascending", () => {
  let s = emptySession();
  const seeds = [0x10n, 0x20n, 0x30n, 0x40n, 0x50n];
  for (const seed of seeds) s = keepCard(s, 0, seed); // five 0.01 ETH cards -> sum 0.05 ETH, denomIndex 1
  const nodes = liveNodes(s);
  const shuffledKeys = [nodes[2].key, nodes[0].key, nodes[3].key, nodes[1].key, nodes[4].key];

  const composed = composeNodes(s, shuffledKeys);
  const result = liveNodes(composed)[0];

  assert.equal(result.demoId, nodes[0].demoId); // node[0] has the lowest demoId
  assert.deepEqual(
    result.parents,
    [nodes[0].key, nodes[1].key, nodes[2].key, nodes[3].key, nodes[4].key], // survivor, then ascending demoId
  );
});

test("composeNodes: result ink gene matches a hand-computed geneAtCompose call", () => {
  let s = emptySession();
  s = keepCard(s, 1, seedA);
  s = keepCard(s, 1, seedB);
  const [nodeA, nodeB] = liveNodes(s);
  const composed = composeNodes(s, [nodeA.key, nodeB.key]);
  const result = liveNodes(composed)[0];

  const geneA = geneAtMint(seedA, 1);
  const geneB = geneAtMint(seedB, 1);
  const uA = unitsAt(1);
  const uB = unitsAt(1);
  const expectedGene = geneAtCompose(
    seedA,
    seedB, // burnSeedFold, single burn
    geneA,
    1,
    2,
    Math.max(geneA, geneB),
    Math.min(geneA, geneB),
    centerGene(BigInt(geneA) * uA + BigInt(geneB) * uB, uA + uB),
  );
  assert.equal(result.inkGene, expectedGene);
});

test("keepCard: tray cap of 8 live cards is enforced", () => {
  let s: PlaySession = emptySession();
  for (let i = 0; i < TRAY_CAP; i++) s = keepCard(s, 0, BigInt(i + 1));
  assert.equal(liveNodes(s).length, TRAY_CAP);
  assert.throws(() => keepCard(s, 0, 999n));
});

test("removeNode: drops a live node, is a no-op for a consumed one", () => {
  let s = emptySession();
  s = keepCard(s, 1, seedA);
  s = keepCard(s, 1, seedB);
  const [nodeA, nodeB] = liveNodes(s);
  const composed = composeNodes(s, [nodeA.key, nodeB.key]);
  const resultKey = liveNodes(composed)[0].key;

  // nodeA is consumed in `composed`; removing it must not change the session.
  const untouched = removeNode(composed, nodeA.key);
  assert.deepEqual(untouched, composed);

  // Removing the compose result un-consumes its parents: nodeA and nodeB become live again.
  const removed = removeNode(composed, resultKey);
  const removedLive = liveNodes(removed).map((n) => n.key).sort();
  assert.deepEqual(removedLive, [nodeA.key, nodeB.key].sort());
});

test("textSeed: matches keccak256(utf8(trimmed text))", () => {
  const expectedBytes = keccak_256(new TextEncoder().encode("vitalik.eth"));
  let expected = 0n;
  for (const b of expectedBytes) expected = (expected << 8n) | BigInt(b);
  assert.equal(textSeed("  vitalik.eth  "), expected);
});

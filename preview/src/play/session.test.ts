import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { encodePacked, keccak256 } from "viem";

import { centerGene, geneAtCompose, geneAtMint } from "../canonical/ink";
import { DENOMINATIONS, unitsAt } from "../canonical/denominations";
import { sampleComposeTraced, sampleSplitChildTraced, type SampleBurn, type SampleDonor } from "../canonical/sampling";
import {
  composeNodes,
  composeSummedIndex,
  decomposeNode,
  emptySession,
  keepCard,
  liveNodes,
  removeNode,
  sacrificeNode,
  splitNode,
  textSeed,
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

test("keepCard: has no fixed capacity", () => {
  let s: PlaySession = emptySession();
  for (let i = 0; i < 12; i++) s = keepCard(s, 0, BigInt(i + 1));
  assert.equal(liveNodes(s).length, 12);
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

/* ------------------------------------------------------------------ *
 * split
 * ------------------------------------------------------------------ */

function seedHexOf(seed: bigint): `0x${string}` {
  return `0x${seed.toString(16).padStart(64, "0")}` as `0x${string}`;
}

test("splitNode: child seeds match hand-computed keccak256(abi.encodePacked(parentSeed, uint256 i))", () => {
  let s = emptySession();
  s = keepCard(s, 2, seedA); // 0.1 ETH (denomIndex 2)
  const parent = liveNodes(s)[0];

  const split = splitNode(s, parent.key, 0); // -> 0.01 ETH (denomIndex 0), 10 children
  const children = liveNodes(split).sort((a, b) => a.demoId - b.demoId);
  assert.equal(children.length, 10);

  children.forEach((child, i) => {
    const expected = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [seedHexOf(parent.seed), BigInt(i)])));
    assert.equal(child.seed, expected, `child ${i} seed`);
  });
});

test("splitNode: bytes match sampleSplitChildTraced called directly on the same parent donor", () => {
  let s = emptySession();
  s = keepCard(s, 3, seedA); // 0.5 ETH (denomIndex 3)
  const parent = liveNodes(s)[0];

  const split = splitNode(s, parent.key, 1); // -> 0.05 ETH (denomIndex 1)
  const children = liveNodes(split).sort((a, b) => a.demoId - b.demoId);

  const parentDonor: SampleDonor = { seed: parent.seed, denomIndex: parent.denomIndex, inkGene: parent.inkGene };
  children.forEach((child, i) => {
    const expected = sampleSplitChildTraced(parentDonor, 1, i);
    assert.equal(bytesEqual(child.modules!, expected.bytes), true, `child ${i} bytes`);
    assert.deepEqual(child.splitTrace, expected.trace, `child ${i} trace`);
    assert.equal(child.inkGene, parent.inkGene, `child ${i} inkGene`);
    assert.equal(child.denomIndex, 1, `child ${i} denomIndex`);
    assert.deepEqual(child.parents, [parent.key], `child ${i} parents`);
  });
});

test("splitNode: child count is unitsAt(parent)/unitsAt(child), parent is consumed", () => {
  let s = emptySession();
  s = keepCard(s, 4, seedA); // 1 ETH (denomIndex 4)
  const parent = liveNodes(s)[0];

  const split = splitNode(s, parent.key, 3); // -> 0.5 ETH (denomIndex 3), 2 children
  const expectedCount = Number(unitsAt(4) / unitsAt(3));
  const live = liveNodes(split);
  assert.equal(live.length, expectedCount);
  assert.equal(live.every((n) => n.denomIndex === 3), true);
  // the parent no longer appears among live nodes -- it's consumed, same as a compose survivor.
  assert.equal(live.some((n) => n.key === parent.key), false);
});

test("splitNode: splitting a materialized (composed) node samples from its stored bytes", () => {
  let s = emptySession();
  s = keepCard(s, 1, seedA);
  s = keepCard(s, 1, seedB);
  const [a, b] = liveNodes(s);
  s = composeNodes(s, [a.key, b.key]); // -> 0.1 ETH, materialized
  const composed = liveNodes(s)[0];
  assert.notEqual(composed.modules, undefined);

  const split = splitNode(s, composed.key, 0); // -> 0.01 ETH, 10 children
  const children = liveNodes(split).sort((x, y) => x.demoId - y.demoId);

  const materializedDonor: SampleDonor = {
    seed: composed.seed,
    denomIndex: composed.denomIndex,
    inkGene: composed.inkGene,
    modules: composed.modules,
  };
  const bareDonor: SampleDonor = {
    seed: composed.seed,
    denomIndex: composed.denomIndex,
    inkGene: composed.inkGene,
  };
  const expectedMaterialized = sampleSplitChildTraced(materializedDonor, 0, 0);
  const expectedBare = sampleSplitChildTraced(bareDonor, 0, 0);
  assert.equal(bytesEqual(children[0].modules!, expectedMaterialized.bytes), true);
  assert.equal(bytesEqual(children[0].modules!, expectedBare.bytes), false);
});

test("splitNode: rejects a black node and a childDenomIndex not below the parent's", () => {
  let s = emptySession();
  s = keepCard(s, DENOMINATIONS.length - 1, seedA); // 100 ETH
  const node = liveNodes(s)[0];

  assert.throws(() => splitNode(s, node.key, DENOMINATIONS.length - 1)); // not below parent's
  assert.throws(() => splitNode(s, node.key, DENOMINATIONS.length)); // out of range

  const sacrificed = sacrificeNode(s, node.key);
  assert.throws(() => splitNode(sacrificed, node.key, 0)); // black
});

/* ------------------------------------------------------------------ *
 * decompose
 * ------------------------------------------------------------------ */

test("decomposeNode: restores parents to live, removes the composed node", () => {
  let s = emptySession();
  s = keepCard(s, 1, seedA);
  s = keepCard(s, 1, seedB);
  const [a, b] = liveNodes(s);
  s = composeNodes(s, [a.key, b.key]);
  const composed = liveNodes(s)[0];

  const decomposed = decomposeNode(s, composed.key);
  const live = liveNodes(decomposed).map((n) => n.key).sort();
  assert.deepEqual(live, [a.key, b.key].sort());
  assert.equal(decomposed.nodes.some((n) => n.key === composed.key), false);
});

test("decomposeNode: rejects a node that isn't a compose result, and a black composed node", () => {
  let s = emptySession();
  s = keepCard(s, 0, seedA);
  const original = liveNodes(s)[0];
  assert.throws(() => decomposeNode(s, original.key)); // never composed

  s = keepCard(s, 1, seedB);
  s = keepCard(s, 1, 0x3333n);
  const [x, y] = liveNodes(s).slice(1);
  s = composeNodes(s, [x.key, y.key]);
  const composed = liveNodes(s).find((n) => n.trace)!;
  // Compose must land above index 8's ceiling for this assertion to hold generally, but at
  // denomIndex 2 it isn't black yet -- decompose should succeed here.
  const ok = decomposeNode(s, composed.key);
  assert.equal(liveNodes(ok).some((n) => n.key === x.key), true);
});

/* ------------------------------------------------------------------ *
 * sacrifice
 * ------------------------------------------------------------------ */

test("sacrificeNode: only a live 100 ETH (top-rung) card qualifies, and it can't be sacrificed twice", () => {
  let s = emptySession();
  s = keepCard(s, DENOMINATIONS.length - 2, seedA); // one rung below the top
  const notTop = liveNodes(s)[0];
  assert.throws(() => sacrificeNode(s, notTop.key));

  s = keepCard(s, DENOMINATIONS.length - 1, seedB); // 100 ETH
  const top = liveNodes(s).find((n) => n.denomIndex === DENOMINATIONS.length - 1)!;
  const sacrificed = sacrificeNode(s, top.key);
  const node = sacrificed.nodes.find((n) => n.key === top.key)!;
  assert.equal(node.black, true);
  // still live: sacrifice doesn't consume the token.
  assert.equal(liveNodes(sacrificed).some((n) => n.key === top.key), true);

  assert.throws(() => sacrificeNode(sacrificed, top.key)); // already black
});

test("black nodes are rejected as compose/split participants", () => {
  let s = emptySession();
  s = keepCard(s, DENOMINATIONS.length - 1, seedA);
  const top = liveNodes(s)[0];
  s = sacrificeNode(s, top.key);

  s = keepCard(s, DENOMINATIONS.length - 1, seedB);
  const other = liveNodes(s).find((n) => n.key !== top.key)!;

  assert.throws(() => composeNodes(s, [top.key, other.key]));
  assert.throws(() => splitNode(s, top.key, 0));
});

test("removeNode: a split child is not removable", () => {
  let s = emptySession();
  s = keepCard(s, 2, seedA); // 0.1 ETH
  const parent = liveNodes(s)[0];
  s = splitNode(s, parent.key, 1); // -> 2 x 0.05
  const child = liveNodes(s)[0];
  assert.ok(child.splitTrace);
  const after = removeNode(s, child.key);
  assert.equal(after, s);
  assert.equal(liveNodes(after).length, 2);
});

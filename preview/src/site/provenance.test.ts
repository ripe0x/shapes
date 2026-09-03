import {test} from "node:test";
import assert from "node:assert/strict";

import {isProvenanceRollup, provenanceRollupLabel, unrollLineage} from "./provenance";
import type {ProvNode} from "../chain/history";

test("provenance rollup placeholders are labels, not denomination-zero token cards", () => {
  const rollup = {more: 12};
  assert.equal(isProvenanceRollup(rollup), true);
  assert.equal(provenanceRollupLabel(rollup), "+12 more");
  assert.equal(isProvenanceRollup({}), false);
});

function node(partial: Partial<ProvNode> & {id: bigint; seed: bigint; di: number; rel: ProvNode["rel"]}): ProvNode {
  return {mintBorn: false, contributors: [], ...partial};
}

test("unrollLineage: mint-born root with no composes", () => {
  const root = node({id: 1n, seed: 10n, di: 0, rel: "root", mintBorn: true});
  const lineage = unrollLineage(root);
  assert.deepEqual(lineage.origin, {kind: "mint"});
  assert.equal(lineage.steps.length, 0);
  assert.equal(lineage.final, root);
  assert.equal(lineage.birthDi, 0);
});

test("unrollLineage: split-born root with two stacked composes", () => {
  const splitParent = node({id: 4n, seed: 40n, di: 2, rel: "splitSource", mintBorn: true});
  const oldest = node({id: 5n, seed: 50n, di: 1, rel: "self", contributors: [splitParent]});
  const donor1 = node({id: 6n, seed: 60n, di: 1, rel: "merged", mintBorn: true});
  const mid = node({id: 5n, seed: 50n, di: 2, rel: "self", contributors: [oldest, donor1]});
  const donor2 = node({id: 7n, seed: 70n, di: 2, rel: "merged", mintBorn: true});
  const root = node({id: 5n, seed: 50n, di: 3, rel: "root", contributors: [mid, donor2]});

  const lineage = unrollLineage(root);
  assert.deepEqual(lineage.origin, {kind: "split", parent: splitParent});
  assert.equal(lineage.birthDi, 1);
  assert.equal(lineage.steps.length, 2);
  assert.equal(lineage.steps[0].state, mid);
  assert.deepEqual(lineage.steps[0].donors, [donor1]);
  assert.equal(lineage.steps[1].state, root);
  assert.deepEqual(lineage.steps[1].donors, [donor2]);
  assert.equal(lineage.final, root);
});

test("unrollLineage: truncated oldest state has unknown origin", () => {
  const root = node({id: 9n, seed: 90n, di: 2, rel: "root", truncated: true});
  const lineage = unrollLineage(root);
  assert.deepEqual(lineage.origin, {kind: "unknown"});
  assert.equal(lineage.steps.length, 0);
  assert.equal(lineage.birthDi, 2);
});

test("unrollLineage: a step with a rollup donor keeps the rollup as a donor entry", () => {
  const selfState = node({id: 2n, seed: 20n, di: 0, rel: "self", mintBorn: true});
  const rollupDonor = node({id: 0n, seed: 0n, di: 0, rel: "merged", more: 12});
  const root = node({id: 2n, seed: 20n, di: 1, rel: "root", contributors: [selfState, rollupDonor]});

  const lineage = unrollLineage(root);
  assert.deepEqual(lineage.origin, {kind: "mint"});
  assert.equal(lineage.birthDi, 0);
  assert.equal(lineage.steps.length, 1);
  assert.equal(lineage.steps[0].state, root);
  assert.deepEqual(lineage.steps[0].donors, [rollupDonor]);
  assert.ok(isProvenanceRollup(lineage.steps[0].donors[0]));
});

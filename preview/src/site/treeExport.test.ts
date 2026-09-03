import assert from "node:assert/strict";
import test from "node:test";

import {layoutTree, type LayoutCard, type TreeNode} from "./ProvenanceTree";
import {buildTreeSvg} from "./treeExport";

const ART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" width="2000" height="2800"><rect width="250" height="350" fill="#000"/></svg>`;
const ART = `data:image/svg+xml;base64,${Buffer.from(ART_SVG).toString("base64")}`;

function node(key: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {key, art: ART, title: `#${key}`, lines: [], children: [], ...extra};
}

// Three generations: root -> {childA -> grandA, childB -> [rollup chip]}.
const grandA = node("ga");
const rollup = node("ro", {rollup: 5, children: []});
const childA = node("a", {children: [grandA]});
const childB = node("b", {children: [rollup]});
const root = node("r", {children: [childA, childB]});
const expandedKeys = new Set(["r", "a", "b"]);

function overlaps(a: LayoutCard, b: LayoutCard): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("layoutTree: a three-generation tree places every expanded card and rollup, none overlapping", () => {
  const layout = layoutTree(root, expandedKeys);
  // root, childA, childB, grandA are cards; the rollup chip is not.
  assert.equal(layout.cards.length, 4);
  assert.equal(layout.rollups.length, 1);
  assert.deepEqual(
    layout.cards.map((c) => c.node.key).sort(),
    ["a", "b", "ga", "r"],
  );

  for (let i = 0; i < layout.cards.length; i++) {
    for (let j = i + 1; j < layout.cards.length; j++) {
      assert.ok(!overlaps(layout.cards[i], layout.cards[j]), `${layout.cards[i].node.key} overlaps ${layout.cards[j].node.key}`);
    }
  }
});

test("layoutTree: connectors join each parent's centre to its child's (or rollup's) centre", () => {
  const layout = layoutTree(root, expandedKeys);
  assert.equal(layout.connectors.length, 4); // root->a, root->b, a->ga, b->rollup

  const byKey = new Map(layout.cards.map((c) => [c.node.key, c]));
  const rollupCard = layout.rollups[0];
  const center = (c: {x: number; y: number; w: number; h: number}) => ({x: c.x + c.w / 2, y: c.y + c.h / 2});

  const rootCenter = center(byKey.get("r")!);
  const aCenter = center(byKey.get("a")!);
  const bCenter = center(byKey.get("b")!);
  const gaCenter = center(byKey.get("ga")!);
  const rollupCenter = center(rollupCard);

  const hasConnector = (p1: {x: number; y: number}, p2: {x: number; y: number}) =>
    layout.connectors.some((c) => c.x1 === p1.x && c.y1 === p1.y && c.x2 === p2.x && c.y2 === p2.y);

  assert.ok(hasConnector(rootCenter, aCenter));
  assert.ok(hasConnector(rootCenter, bCenter));
  assert.ok(hasConnector(aCenter, gaCenter));
  assert.ok(hasConnector(bCenter, rollupCenter));
});

test("layoutTree: extraRoots lays out an independent forest side by side, un-overlapping", () => {
  const secondRoot = node("s", {children: [node("s1")]});
  const layout = layoutTree(root, new Set(["r", "a", "b", "s"]), [secondRoot]);
  // root's subtree (4 cards + 1 rollup) plus secondRoot's subtree (2 cards).
  assert.equal(layout.cards.length, 6);
  assert.ok(layout.cards.some((c) => c.node.key === "s") && layout.cards.some((c) => c.node.key === "s1"));

  for (let i = 0; i < layout.cards.length; i++) {
    for (let j = i + 1; j < layout.cards.length; j++) {
      assert.ok(!overlaps(layout.cards[i], layout.cards[j]), `${layout.cards[i].node.key} overlaps ${layout.cards[j].node.key}`);
    }
  }
});

test("buildTreeSvg: one nested <svg> per card, the rollup text, and dimensions at 2x the layout", () => {
  const layout = layoutTree(root, expandedKeys);
  const svg = buildTreeSvg(layout, {focusedKey: "a"});

  const nestedSvgCount = (svg.match(/<svg /g) ?? []).length - 1; // minus the document's own opening tag
  assert.equal(nestedSvgCount, layout.cards.length);
  assert.ok(svg.includes("+5 more"));

  const widthMatch = svg.match(/^<svg[^>]*\swidth="([\d.]+)"/);
  const heightMatch = svg.match(/\sheight="([\d.]+)"/);
  assert.ok(widthMatch && heightMatch);
  assert.equal(Number(widthMatch![1]), layout.width * 2);
  assert.equal(Number(heightMatch![1]), layout.height * 2);
});

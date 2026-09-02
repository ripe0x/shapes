/**
 * Playground session model. Pure state, no React: a session is the tray of demo cards a visitor
 * has kept plus every compose result derived from them. Every seed and every sampled byte comes
 * from the canonical renderer/sampler in `../canonical`, so a session's cards are exactly what a
 * mint or compose at those inputs would produce on chain.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { DENOMINATIONS, denominationIndex, unitsAt } from "../canonical/denominations";
import { centerGene, geneAtCompose, geneAtMint } from "../canonical/ink";
import { CANONICAL } from "../canonical/params";
import { composeShape, type Composition } from "../canonical/render";
import {
  composeSampledShape,
  sampleComposeTraced,
  sampleSplitChildTraced,
  type LastMergeDonors,
  type ComposeTraceCell,
  type SampleBurn,
  type SampleDonor,
  type SplitTraceCell,
} from "../canonical/sampling";
import { productionSeed } from "../seeds";
import { splitChildSeed } from "../splitSeed";

export interface PlayNode {
  /** Unique per session. Composed results and their consumed parents each keep their own key. */
  key: number;
  /** Display id (#1, #2, ...). A composed result keeps its survivor's demoId. */
  demoId: number;
  denomIndex: number;
  inkGene: number;
  seed: bigint;
  /** Set iff the seed came from typed text. */
  seedText?: string;
  /** Set iff this node is a compose result: its materialized module bytes. */
  modules?: Uint8Array;
  /** Node keys of this node's compose inputs, canonical donor order (survivor first, then burns
   *  ascending by demoId), or the single parent key for a split child. Set iff this node is a
   *  compose result or a split child. */
  parents?: number[];
  /** Per-cell provenance from the compose that produced this node. Set iff composed. */
  trace?: ComposeTraceCell[];
  /** Per-cell provenance from the split that produced this node. Set iff this node is a split
   *  child. Distinct from `trace`, which stays compose-only. */
  splitTrace?: SplitTraceCell[];
  /** Set iff this node has been sacrificed: renders inverted, and can no longer be composed,
   *  split, decomposed, or selected. */
  black?: true;
}

export interface PlaySession {
  nodes: PlayNode[];
  nextKey: number;
  nextDemoId: number;
}

export function emptySession(): PlaySession {
  return { nodes: [], nextKey: 1, nextDemoId: 1 };
}

/** A session node's rendered composition: sampled from its stored bytes if composed, otherwise
 *  drawn fresh from its seed. */
export function nodeComposition(node: PlayNode): Composition {
  if (node.modules) return composeSampledShape(node.modules, node.denomIndex, node.inkGene, CANONICAL);
  return composeShape(node.seed, DENOMINATIONS[node.denomIndex], node.inkGene, CANONICAL);
}

/** Nodes not consumed as a compose input. The tray shows these. */
export function liveNodes(s: PlaySession): PlayNode[] {
  const consumed = new Set<number>();
  for (const n of s.nodes) for (const key of n.parents ?? []) consumed.add(key);
  return s.nodes.filter((n) => !consumed.has(n.key));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

/** keccak256(utf8(trimmed text)) — the personal-seed hook. Never a raw integer (see seeds.ts). */
export function textSeed(text: string): bigint {
  return bytesToBigInt(keccak_256(new TextEncoder().encode(text.trim())));
}

/** A production-style random seed: keccak256(bytes32(index)) over a random index, never a raw
 *  consecutive integer (see seeds.ts header). */
export function randomSeed(): bigint {
  const indexBytes = new Uint8Array(8);
  crypto.getRandomValues(indexBytes);
  return productionSeed(bytesToBigInt(indexBytes));
}

/** Add one seed-derived card to the tray. */
export function keepCard(s: PlaySession, denomIndex: number, seed: bigint, seedText?: string): PlaySession {
  const node: PlayNode = {
    key: s.nextKey,
    demoId: s.nextDemoId,
    denomIndex,
    inkGene: geneAtMint(seed, denomIndex),
    seed,
    seedText,
  };
  return { nodes: [...s.nodes, node], nextKey: s.nextKey + 1, nextDemoId: s.nextDemoId + 1 };
}

/** Add a protocol-accurate Complete Shape at `targetDenomIndex`. It starts with the required
 *  number of independent 0.01 ETH origins, then composes them one ladder rung at a time. The
 *  returned session retains the entire tree so every intermediate composition can be explored. */
export function buildCompleteShape(
  s: PlaySession,
  targetDenomIndex: number,
  seedFactory: () => bigint = randomSeed,
): PlaySession {
  if (!Number.isInteger(targetDenomIndex) || targetDenomIndex < 0 || targetDenomIndex >= DENOMINATIONS.length) {
    throw new Error(`targetDenomIndex out of range: ${targetDenomIndex}`);
  }

  const originCount = Number(unitsAt(targetDenomIndex));
  const nodes = [...s.nodes];
  let nextKey = s.nextKey;
  let nextDemoId = s.nextDemoId;
  let currentKeys: number[] = [];

  for (let i = 0; i < originCount; i++) {
    const seed = seedFactory();
    currentKeys.push(nextKey);
    nodes.push({
      key: nextKey++,
      demoId: nextDemoId++,
      denomIndex: 0,
      inkGene: geneAtMint(seed, 0),
      seed,
    });
  }

  let next: PlaySession = { nodes, nextKey, nextDemoId };
  for (let level = 0; level < targetDenomIndex; level++) {
    const groupSize = Number(unitsAt(level + 1) / unitsAt(level));
    const producedKeys: number[] = [];
    for (let offset = 0; offset < currentKeys.length; offset += groupSize) {
      const resultKey = next.nextKey;
      next = composeNodes(next, currentKeys.slice(offset, offset + groupSize));
      producedKeys.push(resultKey);
    }
    currentKeys = producedKeys;
  }

  return next;
}

/** Remove a live (unconsumed) node from the session. No-op if `key` is not live. */
export function removeNode(s: PlaySession, key: number): PlaySession {
  const live = new Set(liveNodes(s).map((n) => n.key));
  if (!live.has(key)) return s;
  // Split children are not individually removable: the URL codec encodes a split as one atomic
  // op covering all of its children, so a missing sibling would be unrepresentable and the
  // encoder's contiguous-sibling walk would misencode the session.
  const node = s.nodes.find((n) => n.key === key);
  if (node?.splitTrace) return s;
  return { ...s, nodes: s.nodes.filter((n) => n.key !== key) };
}

/** denominationIndex of the summed backing of `nodes`, or -1 when the sum lands on no rung. */
export function composeSummedIndex(nodes: readonly PlayNode[]): number {
  let sum = 0n;
  for (const n of nodes) sum += DENOMINATIONS[n.denomIndex];
  return denominationIndex(sum);
}

function toDonor(n: PlayNode): SampleDonor {
  return { seed: n.seed, denomIndex: n.denomIndex, inkGene: n.inkGene, modules: n.modules };
}

/**
 * Compose the selected live nodes. Survivor = selected node with the lowest demoId (keeps its id
 * and seed, per contract semantics); the rest burn, ordered ascending by demoId for both the
 * sampler's donor order and the stored `parents`. Throws when fewer than two nodes are selected,
 * a key is not live, or the summed backing does not land exactly on a denomination above the
 * survivor's.
 */
export function composeNodes(s: PlaySession, rawKeys: number[]): PlaySession {
  const keys = [...new Set(rawKeys)];
  if (keys.length < 2) throw new Error("select at least two cards to compose");

  const live = liveNodes(s);
  const selected = keys.map((k) => {
    const n = live.find((x) => x.key === k);
    if (!n) throw new Error(`node ${k} is not a live card`);
    if (n.black) throw new Error("a black card cannot be composed");
    return n;
  });

  const newIndex = composeSummedIndex(selected);
  if (newIndex < 0) throw new Error("selection does not sum to a denomination");

  const survivor = selected.reduce((a, b) => (b.demoId < a.demoId ? b : a));
  if (newIndex <= survivor.denomIndex) {
    throw new Error("result denomination must be above the survivor's");
  }
  const burns = selected.filter((n) => n.key !== survivor.key).sort((a, b) => a.demoId - b.demoId);

  const survivorDonor = toDonor(survivor);
  const burnDonors: SampleBurn[] = burns.map((n) => ({ ...toDonor(n), tokenId: BigInt(n.demoId) }));

  const { bytes, trace } = sampleComposeTraced(survivorDonor, burnDonors, newIndex);

  // Result ink gene: geneAtCompose over the pool statistics of {survivor + burns}. Mirrors
  // Dna.tsx's ComposeDna resultGene computation.
  let sumW = 0n;
  let unitsTotal = 0n;
  let best = survivor.inkGene;
  let worst = survivor.inkGene;
  for (const n of selected) {
    const u = unitsAt(n.denomIndex);
    sumW += BigInt(n.inkGene) * u;
    unitsTotal += u;
    if (n.inkGene > best) best = n.inkGene;
    if (n.inkGene < worst) worst = n.inkGene;
  }
  let burnSeedFold = 0n;
  for (const b of burnDonors) burnSeedFold ^= b.seed;
  const resultGene = geneAtCompose(
    survivor.seed,
    burnSeedFold,
    survivor.inkGene,
    survivor.denomIndex,
    newIndex,
    best,
    worst,
    centerGene(sumW, unitsTotal),
  );

  const resultNode: PlayNode = {
    key: s.nextKey,
    demoId: survivor.demoId,
    denomIndex: newIndex,
    inkGene: resultGene,
    seed: survivor.seed,
    modules: bytes,
    parents: [survivor.key, ...burns.map((n) => n.key)],
    trace,
  };

  return { nodes: [...s.nodes, resultNode], nextKey: s.nextKey + 1, nextDemoId: s.nextDemoId };
}

/**
 * Split a live node into equal children at a lower denomination (contract semantics: `split`).
 * Child count is `unitsAt(node.denomIndex) / unitsAt(childDenomIndex)` (always a whole number —
 * every rung's unit count divides every higher rung's, by construction of the ladder). Child i's
 * seed is `splitChildSeed(parentSeed, i)`, i.e. `keccak256(abi.encodePacked(parentSeed,
 * uint256(i)))`, mirroring `Shapes._childSeed`. Ink gene is the parent's, verbatim. Module bytes
 * come from `sampleSplitChildTraced` over the parent's effective modules (its stored bytes if
 * materialized, otherwise grammar-v1 from its seed). The parent is consumed: each child's
 * `parents` names it, so `liveNodes` excludes it, the same mechanism compose uses. Throws when
 * the node is not live, is black, or `childDenomIndex` is not strictly below the node's.
 */
export function splitNode(s: PlaySession, key: number, childDenomIndex: number): PlaySession {
  const live = liveNodes(s);
  const node = live.find((n) => n.key === key);
  if (!node) throw new Error(`node ${key} is not a live card`);
  if (node.black) throw new Error("a black card cannot be split");
  if (childDenomIndex < 0 || childDenomIndex >= DENOMINATIONS.length) {
    throw new Error(`childDenomIndex out of range: ${childDenomIndex}`);
  }
  if (childDenomIndex >= node.denomIndex) {
    throw new Error("split denomination must be below the parent's");
  }

  const childCount = Number(unitsAt(node.denomIndex) / unitsAt(childDenomIndex));
  const parentDonor = toDonor(node);

  // D3' pool selection (SAMPLING_SPEC.md section 6): a composed parent's children sample from
  // its last merge's donor pool. The session still holds those donors verbatim — a compose
  // result's `parents` are its consumed input nodes, the same snapshot the contract's compose
  // record stores — so passing them reproduces the record branch exactly. A split child or an
  // original card has no record; `sampleSplitChildTraced` then uses the grammar branch.
  let lastMerge: LastMergeDonors | undefined;
  if (node.trace && node.parents) {
    const byKey = new Map(s.nodes.map((n) => [n.key, n]));
    const donorNodes = node.parents.map((k) => byKey.get(k)!);
    lastMerge = {
      survivor: toDonor(donorNodes[0]),
      inputs: donorNodes.slice(1).map((n) => ({ ...toDonor(n), tokenId: BigInt(n.demoId) })),
    };
  }

  const children: PlayNode[] = [];
  for (let i = 0; i < childCount; i++) {
    const { bytes, trace } = sampleSplitChildTraced(parentDonor, childDenomIndex, i, CANONICAL, lastMerge);
    children.push({
      key: s.nextKey + i,
      demoId: s.nextDemoId + i,
      denomIndex: childDenomIndex,
      inkGene: node.inkGene,
      seed: splitChildSeed(node.seed, i),
      modules: bytes,
      parents: [node.key],
      splitTrace: trace,
    });
  }

  return {
    nodes: [...s.nodes, ...children],
    nextKey: s.nextKey + childCount,
    nextDemoId: s.nextDemoId + childCount,
  };
}

/**
 * Undo a node's most recent compose (contract semantics: `decompose`). The node must be live and
 * a compose result (has `trace`); it is removed and its compose inputs become live again — the
 * same filtering `removeNode` does, but only valid for a composed node. An original (non-composed)
 * card still goes through `removeNode`. Throws when the node is not live, was not produced by a
 * compose, or is black.
 */
export function decomposeNode(s: PlaySession, key: number): PlaySession {
  const live = liveNodes(s);
  const node = live.find((n) => n.key === key);
  if (!node) throw new Error(`node ${key} is not a live card`);
  if (!node.trace) throw new Error("only a composed card can be decomposed");
  if (node.black) throw new Error("a black card cannot be decomposed");
  return { ...s, nodes: s.nodes.filter((n) => n.key !== key) };
}

/**
 * Sacrifice a live node (contract semantics: `sacrifice`). On chain this requires a complete
 * apex (100 ETH backing, 10,000 independent origins) and sends its ETH to an unspendable
 * address; the token stays alive and renders inverted (Black). The demo has no origin count to
 * check (mint/compose sampling doesn't track it), so it gates only on denomination: any live
 * top-rung (100 ETH) card qualifies here, and the UI states the real on-chain gate in its
 * confirmation copy. Throws when the node is not live, is not at the top denomination, or is
 * already black.
 */
export function sacrificeNode(s: PlaySession, key: number): PlaySession {
  const live = liveNodes(s);
  const node = live.find((n) => n.key === key);
  if (!node) throw new Error(`node ${key} is not a live card`);
  if (node.denomIndex !== DENOMINATIONS.length - 1) {
    throw new Error("only a complete 100 ETH Shape can be sacrificed");
  }
  if (node.black) throw new Error("already sacrificed");
  return { ...s, nodes: s.nodes.map((n) => (n.key === key ? { ...n, black: true } : n)) };
}

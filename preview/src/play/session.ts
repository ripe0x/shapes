/**
 * Playground session model. Pure state, no React: a session is the tray of demo cards a visitor
 * has kept plus every compose result derived from them. Every seed and every sampled byte comes
 * from the canonical renderer/sampler in `../canonical`, so a session's cards are exactly what a
 * mint or compose at those inputs would produce on chain.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { DENOMINATIONS, denominationIndex, unitsAt } from "../canonical/denominations";
import { centerGene, geneAtCompose, geneAtMint } from "../canonical/ink";
import { sampleComposeTraced, type ComposeTraceCell, type SampleBurn, type SampleDonor } from "../canonical/sampling";
import { productionSeed } from "../seeds";

export const TRAY_CAP = 8;

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
   *  ascending by demoId). Set iff this node is a compose result. */
  parents?: number[];
  /** Per-cell provenance from the compose that produced this node. Set iff composed. */
  trace?: ComposeTraceCell[];
}

export interface PlaySession {
  nodes: PlayNode[];
  nextKey: number;
  nextDemoId: number;
}

export function emptySession(): PlaySession {
  return { nodes: [], nextKey: 1, nextDemoId: 1 };
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

/** Add a card to the tray. Throws when the live tray is already at capacity. */
export function keepCard(s: PlaySession, denomIndex: number, seed: bigint, seedText?: string): PlaySession {
  if (liveNodes(s).length >= TRAY_CAP) {
    throw new Error(`tray is full (max ${TRAY_CAP})`);
  }
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

/** Remove a live (unconsumed) node from the session. No-op if `key` is not live. */
export function removeNode(s: PlaySession, key: number): PlaySession {
  const live = new Set(liveNodes(s).map((n) => n.key));
  if (!live.has(key)) return s;
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

import type {ProvNode} from "../chain/history";

/** Rollups are layout sentinels, never token cards. `id: 0n` is not a token reference here. */
export function isProvenanceRollup(node: Pick<ProvNode, "more">): node is Pick<ProvNode, "more"> & {more: number} {
  return typeof node.more === "number" && node.more > 0;
}

export function provenanceRollupLabel(node: Pick<ProvNode, "more">): string {
  return `+${node.more ?? 0} more`;
}

/** One state a token passed through: what it looked like after absorbing `donors`. */
export interface LineageStep {
  state: ProvNode;
  donors: ProvNode[];
}

export interface Lineage {
  origin: {kind: "mint"} | {kind: "split"; parent: ProvNode} | {kind: "unknown"};
  /** Chronological, oldest first. Only states that absorbed donors. */
  steps: LineageStep[];
  /** The root: current state for a live token, last known state otherwise. */
  final: ProvNode;
  /** Denomination at birth (the oldest state's `di`, exact whenever `origin` is not `unknown`). */
  birthDi: number;
}

/**
 * Unroll a `ProvNode`'s `self` chain (the same token's earlier states, per `loadProvenance`)
 * into a chronological timeline. `di` on a state is its denomination at the end of that state;
 * the oldest state in the chain predates any of its own merges, so its `di` is the birth
 * denomination exactly, except when it is truncated (origin unknown, no exact birth state).
 */
export function unrollLineage(root: ProvNode): Lineage {
  const newestFirst: ProvNode[] = [];
  let cur: ProvNode | undefined = root;
  while (cur) {
    newestFirst.push(cur);
    cur = cur.contributors.find((c) => c.rel === "self");
  }
  const oldestFirst = newestFirst.reverse();
  const oldest = oldestFirst[0];

  const donorsOf = (state: ProvNode): ProvNode[] =>
    state.contributors.filter((c) => c.rel !== "self" && c.rel !== "splitSource");

  const splitParent = oldest.contributors.find((c) => c.rel === "splitSource");
  const origin: Lineage["origin"] = oldest.truncated
    ? {kind: "unknown"}
    : splitParent
      ? {kind: "split", parent: splitParent}
      : oldest.mintBorn
        ? {kind: "mint"}
        : {kind: "unknown"};

  const steps: LineageStep[] = [];
  for (let i = 1; i < oldestFirst.length; i++) {
    const donors = donorsOf(oldestFirst[i]);
    if (donors.length > 0) steps.push({state: oldestFirst[i], donors});
  }

  return {origin, steps, final: root, birthDi: oldest.di};
}

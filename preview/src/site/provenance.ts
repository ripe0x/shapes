import {type PublicClient} from "viem";
import {type Deployment} from "../chain/abi";
import {
  INDEXER_TIMEOUT_MS,
  MAX_INDEXER_LAG_BLOCKS,
  checkpointOf,
  indexerQuery,
  requireFreshCheckpoint,
  type IndexerMeta,
} from "./indexerClient";

export interface ProvNode {
  id: bigint;
  seed: bigint;
  /// Denomination index at the end of this token's life (current, for a live root).
  di: number;
  /// How this node relates to the node it nests under. `self` is the same token one merge
  /// earlier: a compose keeps the survivor alive, so its prior state is drawn as a node of its
  /// own — otherwise a five-way merge would show four children and a missing fifth.
  rel: "root" | "merged" | "splitSource" | "piece" | "self";
  /// True for tokens whose life began at a mint (the tree's leaves).
  mintBorn: boolean;
  contributors: ProvNode[];
  truncated?: boolean;
  /// This ancestor already appears elsewhere in the tree; its subtree is not repeated.
  repeat?: boolean;
  /// A rollup placeholder: `more` sibling contributors were not expanded (a wide merge/split,
  /// e.g. an apex Complete's thousands of grains). Rendered as a "+N more" chip, not a card.
  more?: number;
}

const PROV_MAX_NODES = 150;
const PROV_MAX_DEPTH = 12;
// Contributors expanded per merge/split before the rest collapse into a "+N more" rollup. Keeps a
// wide tree (a 10,000-grain apex) legible and bounds the per-level edge queries.
const PROV_MAX_CHILDREN = 8;
// Edges per direction in one level's query. A single compose can name thousands of burned ids;
// only the first PROV_MAX_CHILDREN of each are expanded, but the count behind the "+N more"
// rollup is read from the full group.
const EDGE_LIMIT = 1000;

/// A "+N more" placeholder for un-expanded sibling contributors.
function rollup(more: number, rel: ProvNode["rel"]): ProvNode {
  return {id: 0n, seed: 0n, di: 0, rel, mintBorn: false, contributors: [], more};
}

const EDGE_FIELDS = "id kind childId parentId childSeed parentDenomIndex childMintDenomIndex block logIndex";

const LEVEL_QUERY = `query ProvenanceLevel($ids: [BigInt!], $limit: Int!) {
  _meta { status }
  fromParent: lineageEdges(where: {parentId_in: $ids}, limit: $limit) { items { ${EDGE_FIELDS} } }
  toChild: lineageEdges(where: {childId_in: $ids}, limit: $limit) { items { ${EDGE_FIELDS} } }
}`;

const ROOT_QUERY = `query ProvenanceRoot($id: BigInt!) {
  token(id: $id) { id seed mintDenomIndex }
}`;

interface IndexedEdge {
  id: string;
  kind: string;
  childId: string;
  parentId: string;
  childSeed: `0x${string}`;
  parentDenomIndex: number;
  childMintDenomIndex: number;
  block: string;
  logIndex: number;
}

/** How a token was born, as the ancestry walk needs it: its own seed and birth denomination, and
 *  the split it came out of when it has one. */
interface Birth {
  seed: bigint;
  di: number;
  splitParentId?: bigint;
}

/** One compose still standing on a token: the ids it burned and the denomination the survivor
 *  reached. */
interface Merge {
  burnedIds: bigint[];
  di: number;
}

export interface LoadProvenanceOptions {
  indexerUrl?: string;
  fetch?: typeof fetch;
  maxIndexerLagBlocks?: bigint;
  indexerTimeoutMs?: number;
}

/** Edges from one compose, split, or decompose: those sharing a transaction and a log index. */
function groupByEvent(edges: IndexedEdge[]): Map<string, IndexedEdge[]> {
  const groups = new Map<string, IndexedEdge[]>();
  for (const edge of edges) {
    const key = `${edge.id.slice(0, edge.id.lastIndexOf("-"))}`;
    const group = groups.get(key);
    if (group) group.push(edge);
    else groups.set(key, [edge]);
  }
  return groups;
}

/**
 * Replays a token's compose (push) and decompose (pop) events in block order as a LIFO stack: a
 * decompose reverses its survivor's most recent still-standing compose, so a compose immediately
 * undone cancels out of the ancestry entirely and a stacked sequence leaves only the net-standing
 * composes.
 */
function standingMerges(edges: IndexedEdge[]): Merge[] {
  type Op = {kind: "push" | "pop"; block: bigint; logIndex: number; merge?: Merge};
  const ops: Op[] = [];
  for (const group of groupByEvent(edges).values()) {
    const first = group[0]!;
    if (first.kind === "split") continue;
    const op: Op = {
      kind: first.kind === "continuation" ? "push" : "pop",
      block: BigInt(first.block),
      logIndex: first.logIndex,
    };
    if (op.kind === "push") {
      op.merge = {burnedIds: group.map((e) => BigInt(e.childId)), di: first.parentDenomIndex};
    }
    ops.push(op);
  }
  ops.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const stack: Merge[] = [];
  for (const op of ops) {
    if (op.kind === "push") stack.push(op.merge!);
    else stack.pop();
  }
  return stack;
}

/**
 * A token's ancestry from the indexer's lineage edges: the split input for a split-born token,
 * and every token a compose burned into this id that a later decompose has not reversed. Each
 * edge carries its child's seed and birth denomination, so a burned ancestor can still be drawn.
 * Bounded by node, depth and per-merge budgets; a cut branch is marked `truncated`.
 *
 * Null when the deployment names no indexer, or the indexer is unreachable, malformed, following
 * another chain, or behind the chain head by more than `maxIndexerLagBlocks`.
 */
export async function loadProvenance(
  publicClient: PublicClient,
  dep: Deployment,
  id: bigint,
  options: LoadProvenanceOptions = {},
): Promise<ProvNode | null> {
  const url = options.indexerUrl ?? dep.indexerUrl;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!url || !fetcher) return null;
  const timeoutMs = options.indexerTimeoutMs ?? INDEXER_TIMEOUT_MS;

  try {
    // Ancestry is walked breadth-first: one query per level, not one per node. Every level's
    // edges name the ids of the level above it, which is the next frontier.
    const births = new Map<string, Birth>();
    const merges = new Map<string, Merge[]>();
    const known = new Set<string>();
    let frontier = [id];
    let checkpoint: bigint | undefined;

    for (let depth = 0; depth <= PROV_MAX_DEPTH && frontier.length > 0; depth++) {
      const payload = await indexerQuery<{
        _meta?: IndexerMeta;
        fromParent: {items: IndexedEdge[]};
        toChild: {items: IndexedEdge[]};
      }>(url, fetcher, LEVEL_QUERY, {ids: frontier.map(String), limit: EDGE_LIMIT}, timeoutMs);
      const data = payload.data;
      if (!data?.fromParent?.items || !data.toChild?.items) {
        throw new Error("Shapes indexer returned an invalid provenance response");
      }
      if (checkpoint === undefined) checkpoint = checkpointOf(data._meta, dep.chainId);

      for (const edge of data.toChild.items) {
        const key = edge.childId;
        if (!births.has(key)) {
          births.set(key, {
            seed: BigInt(edge.childSeed),
            di: edge.childMintDenomIndex,
            splitParentId: edge.kind === "split" ? BigInt(edge.parentId) : undefined,
          });
        }
      }

      const next: bigint[] = [];
      const byParent = new Map<string, IndexedEdge[]>();
      for (const edge of data.fromParent.items) {
        const list = byParent.get(edge.parentId) ?? [];
        list.push(edge);
        byParent.set(edge.parentId, list);
      }
      for (const parent of frontier) {
        const key = parent.toString();
        if (known.has(key)) continue;
        known.add(key);
        const standing = standingMerges(byParent.get(key) ?? []);
        merges.set(key, standing);
        for (const merge of standing) {
          for (const burned of merge.burnedIds.slice(0, PROV_MAX_CHILDREN)) next.push(burned);
        }
        const split = births.get(key)?.splitParentId;
        if (split !== undefined) next.push(split);
      }
      frontier = [...new Set(next.map(String))].filter((k) => !known.has(k)).map(BigInt);
    }

    requireFreshCheckpoint(
      checkpoint ?? 0n,
      await publicClient.getBlockNumber(),
      options.maxIndexerLagBlocks ?? MAX_INDEXER_LAG_BLOCKS,
    );

    // The root is the one token no edge names as a child when it was minted directly, so its own
    // birth is read from its row.
    if (!births.has(id.toString())) {
      const rootPayload = await indexerQuery<{
        token: {id: string; seed: `0x${string}`; mintDenomIndex: number} | null;
      }>(url, fetcher, ROOT_QUERY, {id: id.toString()}, timeoutMs);
      const row = rootPayload.data?.token;
      if (!row) return null;
      births.set(id.toString(), {seed: BigInt(row.seed), di: row.mintDenomIndex});
    }

    let budget = PROV_MAX_NODES;
    const visited = new Set<string>();

    function build(nid: bigint, rel: ProvNode["rel"], depth: number): ProvNode | null {
      const key = nid.toString();
      const birth = births.get(key);
      if (!birth) return null; // no birth the indexer knows: not a token to draw

      const own = merges.get(key) ?? [];
      const finalDi = own.length > 0 ? own[own.length - 1]!.di : birth.di;

      budget -= 1;
      // An ancestor can contribute along more than one line (every piece of a split shares the
      // split's input); its subtree is expanded once and referenced after that.
      if (visited.has(key)) {
        return {
          id: nid,
          seed: birth.seed,
          di: finalDi,
          rel,
          mintBorn: birth.splitParentId === undefined,
          contributors: [],
          repeat: true,
        };
      }
      visited.add(key);

      // The token at birth, with its birth contributors.
      let node: ProvNode = {
        id: nid,
        seed: birth.seed,
        di: birth.di,
        rel,
        mintBorn: birth.splitParentId === undefined,
        contributors: [],
      };
      if (budget <= 0 || depth >= PROV_MAX_DEPTH) {
        node.di = finalDi;
        node.truncated = birth.splitParentId !== undefined || own.length > 0;
        return node;
      }
      const childDepth = depth + own.length + 1;
      if (birth.splitParentId !== undefined) {
        const child = build(birth.splitParentId, "splitSource", childDepth);
        if (child) node.contributors.push(child);
      }

      // Each merge is a level of its own: the token one state earlier beside what it absorbed.
      // Without this, a five-way merge would show four children and no fifth.
      for (let e = 0; e < own.length; e++) {
        node.rel = "self";
        const upper: ProvNode = {
          id: nid,
          seed: birth.seed,
          di: own[e]!.di,
          rel,
          mintBorn: false,
          contributors: [node],
        };
        budget -= 1;
        const d = depth + own.length - 1 - e;
        const burned = own[e]!.burnedIds;
        const shown = burned.slice(0, PROV_MAX_CHILDREN);
        for (const bid of shown) {
          const child = build(bid, "merged", d + 1);
          if (child) upper.contributors.push(child);
        }
        const hidden = burned.length - shown.length;
        if (hidden > 0) upper.contributors.push(rollup(hidden, "merged"));
        node = upper;
      }
      return node;
    }

    return build(id, "root", 0);
  } catch {
    return null;
  }
}

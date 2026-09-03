import {type PublicClient} from "viem";
import {shapesAbi, denomIndexOf, type Deployment} from "./abi";
import {splitChildSeed} from "../splitSeed";

// Public RPCs cap eth_getLogs at ~50k blocks, so a scan from block 0 is rejected outright. Walk
// from the deploy block to head in windows under that cap and concatenate.
const MAX_RANGE = 45_000n;

export async function paginate<T>(
  dep: Deployment,
  latest: bigint,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = BigInt(dep.fromBlock ?? 0); from <= latest; from += MAX_RANGE + 1n) {
    const to = from + MAX_RANGE < latest ? from + MAX_RANGE : latest;
    out.push(...(await fetch(from, to)));
  }
  return out;
}

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
// wide tree (a 10,000-grain apex) legible and bounds the lazy per-node mint fetches.
const PROV_MAX_CHILDREN = 8;

/// A "+N more" placeholder for un-expanded sibling contributors.
function rollup(more: number, rel: ProvNode["rel"]): ProvNode {
  return {id: 0n, seed: 0n, di: 0, rel, mintBorn: false, contributors: [], more};
}

/// A token's ancestry, reconstructed from events alone. Contributors are: the split input for
/// a split-born token, and every token a compose burned into this id that a later decompose has
/// not reversed. Every ancestor's seed is recoverable — mints carry it in ShapeMinted and split
/// children derive from the parent seed — so burned ancestors can still be drawn. Bounded by
/// node and depth budgets; a cut branch is marked `truncated`.
export async function loadProvenance(
  publicClient: PublicClient,
  dep: Deployment,
  id: bigint,
): Promise<ProvNode | null> {
  const base = {address: dep.shapes, abi: shapesAbi} as const;
  const latest = await publicClient.getBlockNumber();
  // Recomposition events are few (one per compose/split/decompose) and give the tree its
  // structure, so they are fetched whole. Mints are the many; an apex Complete has thousands of
  // ancestor mints whose logs overflow the RPC response. So a node's mint is fetched lazily by
  // its indexed tokenId, only for the bounded set of nodes the walk renders, and cached.
  const [composed, split, decomposed] = await Promise.all([
    paginate(dep, latest, (fromBlock, toBlock) => publicClient.getContractEvents({...base, eventName: "Composed", fromBlock, toBlock})),
    paginate(dep, latest, (fromBlock, toBlock) => publicClient.getContractEvents({...base, eventName: "Split", fromBlock, toBlock})),
    paginate(dep, latest, (fromBlock, toBlock) => publicClient.getContractEvents({...base, eventName: "Decomposed", fromBlock, toBlock})),
  ]);

  const mintCache = new Map<string, {seed: bigint; di: number} | null>();
  async function mintOf(nid: bigint): Promise<{seed: bigint; di: number} | null> {
    const k = nid.toString();
    const cached = mintCache.get(k);
    if (cached !== undefined) return cached;
    const logs = await paginate(dep, latest, (fromBlock, toBlock) =>
      publicClient.getContractEvents({...base, eventName: "ShapeMinted", args: {tokenId: nid}, fromBlock, toBlock}),
    );
    const l = logs[0];
    const v = l ? {seed: BigInt(l.args.seed!), di: denomIndexOf(l.args.amountWei!)} : null;
    mintCache.set(k, v);
    return v;
  }
  const splitOf = new Map<string, {parentId: bigint; parentSeed: bigint; index: number; di: number}>();
  for (const l of split) {
    l.args.newIds!.forEach((nid, i) => {
      splitOf.set(nid.toString(), {
        parentId: l.args.tokenId!,
        parentSeed: BigInt(l.args.parentSeed!),
        index: i,
        di: l.args.outDenoms![i],
      });
    });
  }
  // Composed (push) and Decomposed (pop) events per survivor, replayed in block order as a LIFO
  // stack: a Decomposed event reverses its survivor's most recent still-standing Composed event,
  // so a compose immediately undone by a decompose cancels out of the ancestry entirely, and a
  // stacked compose-decompose-compose sequence leaves only the net-standing composes.
  type StackOp =
    | {kind: "push"; block: bigint; logIndex: number; burnedIds: bigint[]; di: number}
    | {kind: "pop"; block: bigint; logIndex: number};
  const opsBySurvivor = new Map<string, StackOp[]>();
  const pushOp = (k: string, op: StackOp) => {
    if (!opsBySurvivor.has(k)) opsBySurvivor.set(k, []);
    opsBySurvivor.get(k)!.push(op);
  };
  for (const l of composed) {
    pushOp(l.args.survivorId!.toString(), {
      kind: "push",
      block: l.blockNumber!,
      logIndex: l.logIndex!,
      burnedIds: [...l.args.burnedIds!],
      di: l.args.denomIndex!,
    });
  }
  for (const l of decomposed) {
    pushOp(l.args.survivorId!.toString(), {kind: "pop", block: l.blockNumber!, logIndex: l.logIndex!});
  }
  const absorbedBy = new Map<string, {burnedIds: bigint[]; di: number}[]>();
  for (const [k, ops] of opsBySurvivor) {
    ops.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    const stack: {burnedIds: bigint[]; di: number}[] = [];
    for (const op of ops) {
      if (op.kind === "push") stack.push({burnedIds: op.burnedIds, di: op.di});
      else stack.pop();
    }
    absorbedBy.set(k, stack);
  }

  let budget = PROV_MAX_NODES;
  const visited = new Set<string>();

  async function build(nid: bigint, rel: ProvNode["rel"], depth: number): Promise<ProvNode | null> {
    const k = nid.toString();
    const split = splitOf.get(k);
    // A token is born once (mint XOR split); only fetch the mint when it is not split-born, so
    // the targeted mint query runs at most once per rendered node.
    const mint = split ? null : await mintOf(nid);
    if (!mint && !split) return null; // no birth event: not a token we know

    const seed = mint ? mint.seed : splitChildSeed(split!.parentSeed, split!.index);
    const birthDi = (mint ?? split)!.di;
    const merges = absorbedBy.get(k) ?? [];
    const finalDi = merges.length > 0 ? merges[merges.length - 1].di : birthDi;

    budget -= 1;
    // An ancestor can contribute along more than one line (every piece of a split shares the
    // split's input); its subtree is expanded once and referenced after that.
    if (visited.has(k)) {
      return {id: nid, seed, di: finalDi, rel, mintBorn: !!mint, contributors: [], repeat: true};
    }
    visited.add(k);

    // The token at birth, with its birth contributors.
    let node: ProvNode = {id: nid, seed, di: birthDi, rel, mintBorn: !!mint, contributors: []};
    if (budget <= 0 || depth >= PROV_MAX_DEPTH) {
      node.di = finalDi;
      node.truncated = !!split || merges.length > 0;
      return node;
    }
    const childDepth = depth + merges.length + 1;
    const push = (child: ProvNode | null) => {
      if (child) node.contributors.push(child);
    };
    if (split) push(await build(split.parentId, "splitSource", childDepth));

    // Each merge is a level of its own: the token one state earlier beside what it absorbed.
    // Without this, a five-way merge would show four children and no fifth.
    for (let e = 0; e < merges.length; e++) {
      node.rel = "self";
      const upper: ProvNode = {
        id: nid,
        seed,
        di: merges[e].di,
        rel,
        mintBorn: false,
        contributors: [node],
      };
      budget -= 1;
      const d = depth + merges.length - 1 - e;
      const burned = merges[e].burnedIds;
      const shown = burned.slice(0, PROV_MAX_CHILDREN);
      for (const bid of shown) {
        const child = await build(bid, "merged", d + 1);
        if (child) upper.contributors.push(child);
      }
      const hidden = burned.length - shown.length;
      if (hidden > 0) upper.contributors.push(rollup(hidden, "merged"));
      node = upper;
    }
    return node;
  }

  return await build(id, "root", 0);
}

export interface DecomposeInput {
  id: bigint; // the original id it is re-minted under
  seed: bigint; // its birth seed
  di: number; // its denomination index
}

/// The inputs the next `decompose(survivorId)` will restore: the burned inputs of the survivor's
/// most recent still-standing compose, each with the id and seed it is re-minted under. Replays the
/// survivor's compose(push)/decompose(pop) events as a LIFO stack — the top is what decompose pops —
/// then resolves each burned input's birth seed (mint or split-child). Empty when the
/// survivor has no standing compose.
export async function loadDecomposePreview(
  publicClient: PublicClient,
  dep: Deployment,
  survivorId: bigint,
): Promise<DecomposeInput[]> {
  const base = {address: dep.shapes, abi: shapesAbi} as const;
  const latest = await publicClient.getBlockNumber();
  const [composed, split, decomposed] = await Promise.all([
    paginate(dep, latest, (f, t) => publicClient.getContractEvents({...base, eventName: "Composed", fromBlock: f, toBlock: t})),
    paginate(dep, latest, (f, t) => publicClient.getContractEvents({...base, eventName: "Split", fromBlock: f, toBlock: t})),
    paginate(dep, latest, (f, t) => publicClient.getContractEvents({...base, eventName: "Decomposed", fromBlock: f, toBlock: t})),
  ]);

  const key = survivorId.toString();
  type Op = {kind: "push" | "pop"; block: bigint; logIndex: number; burnedIds?: bigint[]};
  const ops: Op[] = [];
  for (const l of composed)
    if (l.args.survivorId!.toString() === key)
      ops.push({kind: "push", block: l.blockNumber!, logIndex: l.logIndex!, burnedIds: [...l.args.burnedIds!]});
  for (const l of decomposed)
    if (l.args.survivorId!.toString() === key) ops.push({kind: "pop", block: l.blockNumber!, logIndex: l.logIndex!});
  ops.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const stack: bigint[][] = [];
  for (const op of ops) op.kind === "push" ? stack.push(op.burnedIds!) : stack.pop();
  const top = stack[stack.length - 1];
  if (!top) return [];

  const splitOf = new Map<string, {parentSeed: bigint; index: number; di: number}>();
  for (const l of split)
    l.args.newIds!.forEach((nid, i) =>
      splitOf.set(nid.toString(), {parentSeed: BigInt(l.args.parentSeed!), index: i, di: l.args.outDenoms![i]}));

  const out: DecomposeInput[] = [];
  for (const id of top) {
    const k = id.toString();
    const sp = splitOf.get(k);
    if (sp) {
      out.push({id, seed: splitChildSeed(sp.parentSeed, sp.index), di: sp.di});
      continue;
    }
    // Mint-born: fetch its ShapeMinted by indexed id.
    const logs = await paginate(dep, latest, (f, t) =>
      publicClient.getContractEvents({...base, eventName: "ShapeMinted", args: {tokenId: id}, fromBlock: f, toBlock: t}));
    const m = logs[0];
    if (m) out.push({id, seed: BigInt(m.args.seed!), di: denomIndexOf(m.args.amountWei!)});
  }
  return out;
}

export interface SplitBirth {
  parentSeed: `0x${string}`;
  parentId: bigint;
  siblingIds: bigint[]; // every output of the split, in split (index) order
  index: number; // this token's position in siblingIds
}

/// The split that created a token, if any: the latest Split event listing it among the
/// outputs. Latest, because a later history query may include more than one matching split in
/// more than one event; only the newest corresponds to the live split record.
export async function findSplitBirth(
  publicClient: PublicClient,
  dep: Deployment,
  id: bigint,
): Promise<SplitBirth | null> {
  const latest = await publicClient.getBlockNumber();
  const events = await paginate(dep, latest, (fromBlock, toBlock) =>
    publicClient.getContractEvents({
      address: dep.shapes,
      abi: shapesAbi,
      eventName: "Split",
      fromBlock,
      toBlock,
    }),
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const l = events[i];
    const at = l.args.newIds?.findIndex((x) => x === id) ?? -1;
    if (at >= 0) {
      return {
        parentSeed: l.args.parentSeed as `0x${string}`,
        parentId: l.args.tokenId as bigint,
        siblingIds: [...(l.args.newIds as readonly bigint[])],
        index: at,
      };
    }
  }
  return null;
}

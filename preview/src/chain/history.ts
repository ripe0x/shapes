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

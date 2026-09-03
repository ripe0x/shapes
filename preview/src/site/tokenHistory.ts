import {formatEther, type PublicClient} from "viem";
import {DENOMINATIONS, type Deployment} from "../chain/abi";
import {
  INDEXER_TIMEOUT_MS,
  MAX_INDEXER_LAG_BLOCKS,
  checkpointOf,
  indexerQuery,
  requireFreshCheckpoint,
  type IndexerMeta,
} from "./indexerClient";

export type HistKind =
  | "mint"
  | "bornFromSplit"
  | "splitInto"
  | "absorbed"
  | "mergedAway"
  | "decomposed"
  | "revived"
  | "backingBurned"
  | "redeemed"
  | "transfer";

export interface HistEvent {
  key: string;
  block: bigint;
  logIndex: number;
  /** Unix seconds of the block the event is in. */
  timestamp: number;
  tx: `0x${string}`;
  kind: HistKind;
  /** One-line human description of what happened to this token. */
  text: string;
}

/** Edges per direction in one history read. A token's own history is bounded by the number of
 *  recompositions it took part in, far below this. */
const EDGE_LIMIT = 500;

const HISTORY_QUERY = `query TokenHistory($id: BigInt!, $limit: Int!) {
  _meta { status }
  token(id: $id) {
    id
    mintDenomIndex
    mintedAtBlock
    mintedAt
    mintTxHash
  }
  fromParent: lineageEdges(where: {parentId: $id}, limit: $limit) {
    items { id kind childId parentId parentDenomIndex block logIndex timestamp txHash }
  }
  toChild: lineageEdges(where: {childId: $id}, limit: $limit) {
    items { id kind childId parentId parentDenomIndex block logIndex timestamp txHash }
  }
  activitys(where: {tokenIds_has: $id}, orderBy: "orderKey", orderDirection: "desc", limit: $limit) {
    items { id kind blockNumber logIndex timestamp txHash actor counterparty amountWei }
  }
}`;

interface IndexedEdge {
  id: string;
  kind: string;
  childId: string;
  parentId: string;
  parentDenomIndex: number;
  block: string;
  logIndex: number;
  timestamp: string;
  txHash: `0x${string}`;
}

/** The `activity` row fields a token's own history reads. `tokenIds` itself is not selected: the
 *  query already filters on this token, and no line here names a sibling id. */
interface IndexedActivity {
  id: string;
  kind: string;
  blockNumber: string;
  logIndex: number;
  timestamp: string;
  txHash: `0x${string}`;
  actor: `0x${string}`;
  counterparty: `0x${string}` | null;
  amountWei: string | null;
}

interface HistoryData {
  _meta?: IndexerMeta;
  token: {
    id: string;
    mintDenomIndex: number;
    mintedAtBlock: string;
    mintedAt: string;
    mintTxHash: `0x${string}`;
  } | null;
  fromParent: {items: IndexedEdge[]};
  toChild: {items: IndexedEdge[]};
  activitys: {items: IndexedActivity[]};
}

export interface LoadTokenHistoryOptions {
  indexerUrl?: string;
  fetch?: typeof fetch;
  maxIndexerLagBlocks?: bigint;
  indexerTimeoutMs?: number;
}

function denomLabelAt(denomIndex: number): string {
  return DENOMINATIONS[denomIndex]?.label ?? "?";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Edges from one compose, split, or decompose: the ones sharing a transaction hash and log
 *  index, since each of those events emits its whole id array under a single log. */
function groupByEvent(edges: IndexedEdge[]): IndexedEdge[][] {
  const groups = new Map<string, IndexedEdge[]>();
  for (const edge of edges) {
    const key = `${edge.txHash}-${edge.logIndex}`;
    const group = groups.get(key);
    if (group) group.push(edge);
    else groups.set(key, [edge]);
  }
  return [...groups.values()];
}

function eventFrom(edge: IndexedEdge, kind: HistKind, text: string): HistEvent {
  return {
    key: `${edge.txHash}-${edge.logIndex}-${kind}`,
    block: BigInt(edge.block),
    logIndex: edge.logIndex,
    timestamp: Number(edge.timestamp),
    tx: edge.txHash,
    kind,
    text,
  };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The kinds an `activity` row supplies that a lineage edge cannot: a holder-to-holder transfer, a
 * redemption, and a backing burn. Recompositions come from the edges instead, which carry the
 * denominations and per-event counts those lines need. Null for every other kind.
 */
function historyFromActivity(row: IndexedActivity): HistEvent | null {
  const at = {
    key: row.id,
    block: BigInt(row.blockNumber),
    logIndex: row.logIndex,
    timestamp: Number(row.timestamp),
    tx: row.txHash,
  };
  const wei = row.amountWei === null ? 0n : BigInt(row.amountWei);
  switch (row.kind) {
    case "transfer":
      return {...at, kind: "transfer", text: `From ${short(row.actor)} to ${short(row.counterparty ?? row.actor)}`};
    case "redeem":
      return {...at, kind: "redeemed", text: `${formatEther(wei)} ETH returned to ${short(row.actor)}`};
    case "burnBacking":
      return {...at, kind: "backingBurned", text: `${formatEther(wei)} ETH backing burned`};
    default:
      return null;
  }
}

/**
 * One token's history, from the indexer's lineage edges, its own mint row, and the activity rows
 * naming it. Null when the deployment names no indexer, or the indexer is unreachable, malformed,
 * following another chain, or behind the chain head by more than `maxIndexerLagBlocks`; the caller
 * renders no history section rather than scanning the chain's event log for it.
 *
 * Covers birth (a mint, or the split that created it), every recomposition the token took part in,
 * holder-to-holder transfers, its redemption, and a burn of its backing.
 */
export async function loadTokenHistory(
  publicClient: PublicClient,
  dep: Deployment,
  id: bigint,
  options: LoadTokenHistoryOptions = {},
): Promise<HistEvent[] | null> {
  const url = options.indexerUrl ?? dep.indexerUrl;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!url || !fetcher) return null;

  try {
    const [head, payload] = await Promise.all([
      publicClient.getBlockNumber(),
      indexerQuery<HistoryData>(
        url,
        fetcher,
        HISTORY_QUERY,
        {id: id.toString(), limit: EDGE_LIMIT},
        options.indexerTimeoutMs ?? INDEXER_TIMEOUT_MS,
      ),
    ]);
    const data = payload.data;
    if (!data?.fromParent?.items || !data.toChild?.items || !data.activitys?.items) {
      throw new Error("Shapes indexer returned an invalid history response");
    }
    requireFreshCheckpoint(
      checkpointOf(data._meta, dep.chainId),
      head,
      options.maxIndexerLagBlocks ?? MAX_INDEXER_LAG_BLOCKS,
    );

    const out: HistEvent[] = [];
    const asChild = data.toChild.items;
    const asParent = data.fromParent.items;

    const bornFromSplit = asChild.find((edge) => edge.kind === "split");
    if (bornFromSplit) {
      out.push(eventFrom(bornFromSplit, "bornFromSplit", `Created by splitting #${bornFromSplit.parentId}`));
    } else if (data.token) {
      // A direct mint always credits exactly one origin; the contract emits ShapeMinted from no
      // other path.
      out.push({
        key: `${data.token.mintTxHash}-mint`,
        block: BigInt(data.token.mintedAtBlock),
        logIndex: 0,
        timestamp: Number(data.token.mintedAt),
        tx: data.token.mintTxHash,
        kind: "mint",
        text: `1 origin, ${denomLabelAt(data.token.mintDenomIndex)} ETH`,
      });
    }

    for (const edge of asChild) {
      if (edge.kind === "continuation") {
        out.push(eventFrom(edge, "mergedAway", `Merged into #${edge.parentId}`));
      } else if (edge.kind === "revival") {
        out.push(
          eventFrom(edge, "revived", `Revived under this original id by #${edge.parentId}'s decompose`),
        );
      }
    }

    for (const group of groupByEvent(asParent)) {
      const edge = group[0]!;
      const n = group.length;
      if (edge.kind === "split") {
        out.push(eventFrom(edge, "splitInto", `Split into ${n} shapes`));
      } else if (edge.kind === "continuation") {
        out.push(
          eventFrom(edge, "absorbed", `Absorbed ${plural(n, "Shape")} and grew to a larger denomination`),
        );
      } else if (edge.kind === "revival") {
        out.push(
          eventFrom(
            edge,
            "decomposed",
            `Released ${plural(n, "Shape")} under their original IDs and reverted to ` +
              `${denomLabelAt(edge.parentDenomIndex)} ETH`,
          ),
        );
      }
    }

    for (const row of data.activitys.items) {
      const event = historyFromActivity(row);
      if (event) out.push(event);
    }

    out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    return out;
  } catch {
    return null;
  }
}

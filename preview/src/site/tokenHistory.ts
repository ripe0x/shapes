import {type PublicClient} from "viem";
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

/**
 * One token's history, from the indexer's lineage edges and its own mint row. Null when the
 * deployment names no indexer, or the indexer is unreachable, malformed, following another chain,
 * or behind the chain head by more than `maxIndexerLagBlocks`; the caller renders no history
 * section rather than scanning the chain's event log for it.
 *
 * Covers birth (a mint, or the split that created it) and every recomposition the token took part
 * in. Transfers, redemptions, and backing burns are not lineage edges and are absent until the
 * indexer records them.
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
    if (!data?.fromParent?.items || !data.toChild?.items) {
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

    out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    return out;
  } catch {
    return null;
  }
}

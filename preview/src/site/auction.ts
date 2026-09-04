import {formatEther, parseEther, type PublicClient} from "viem";
import {auctionHouseAbi, shapesAbi, DENOMINATIONS, type Deployment} from "../chain/abi";
import {UNIT} from "../canonical/denominations";
import {
  INDEXER_TIMEOUT_MS,
  MAX_INDEXER_LAG_BLOCKS,
  checkpointOf,
  indexerQuery,
  requireFreshCheckpoint,
  type IndexerMeta,
} from "./indexerClient";

/** The smallest denomination, and the unit every bid amount is carried in. */
export {UNIT};

// Public RPCs cap eth_getLogs at ~50k blocks, so a scan from block 0 is rejected outright. Walk
// from the deploy block to head in windows under that cap and concatenate.
const MAX_RANGE = 45_000n;

async function paginate<T>(
  dep: Deployment,
  latest: bigint,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (
    let from = BigInt(dep.auctionHouseFromBlock ?? dep.fromBlock ?? 0);
    from <= latest;
    from += MAX_RANGE + 1n
  ) {
    const to = from + MAX_RANGE < latest ? from + MAX_RANGE : latest;
    out.push(...(await fetch(from, to)));
  }
  return out;
}

export interface AuctionState {
  id: bigint;
  seller: `0x${string}`;
  tokenId: bigint;
  /** Zero until the first bid lands: the clock starts then, not at creation. */
  endTime: bigint;
  /** Unix time bids open. Zero or past means open since creation. */
  startTime: bigint;
  duration: bigint;
  extensionWindow: number;
  minIncrementBps: number;
  reserveUnits: bigint;
  highestUnits: bigint;
  highestBidder: `0x${string}`;
  /** Cards the standing bidder has in escrow: the bid itself, across every top-up. Empty before
   *  the first bid and again once the seller claims the proceeds. */
  highestCards: bigint[];
  settled: boolean;
  /** True once claimLot delivered the token to the winner. */
  lotClaimed: boolean;
  /** Smallest bid that would take the lead right now, in units. */
  minimumUnits: bigint;
  /** The connected wallet's own escrowed total and cards, if any. */
  yourUnits: bigint;
  yourCards: bigint[];
  /** Chain block timestamp (unix seconds) read alongside this auction, paired with the
   *  wall-clock instant (`Date.now()`) it was read at. Anchors the countdown to the chain's
   *  clock instead of the browser's: on a dev chain whose clock has been advanced far past real
   *  time, comparing `endTime` to `Date.now()` directly would show a wildly wrong remainder. */
  chainNow: number;
  readAt: number;
}

/** Estimated current chain time: the block timestamp read alongside `a` plus the wall-clock time
 *  elapsed since that read. Lets a UI tick a countdown every second without re-fetching the
 *  chain, while staying anchored to the chain's own clock rather than `Date.now()`. */
export function chainNowFor(a: AuctionState): number {
  return a.chainNow + (Date.now() - a.readAt) / 1000;
}

/**
 * Auction slot as loaded by the site: "loading" before the first read resolves, "error" when the
 * read failed (dead RPC, mid-redeploy chain) so the page can offer a retry instead of claiming
 * there is no auction,
 * null once resolved with no live auction, otherwise the loaded state. Kept
 * distinct from `AuctionState | null` so a slow first read cannot render as
 * "no auction is running."
 */
export type AuctionSlot = AuctionState | null | "loading" | "error";

export type Phase = "scheduled" | "pre-bid" | "live" | "ended-unsettled" | "settled";

/** Lifecycle phase from auction state and chain time. */
export function getPhase(a: AuctionState, now: number): Phase {
  if (a.settled) return "settled";
  if (a.endTime === 0n && Number(a.startTime) > now) return "scheduled";
  const left = secondsLeft(a, now);
  if (left === null) return "pre-bid";
  if (left === 0) return "ended-unsettled";
  return "live";
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function unitsToEth(units: bigint): string {
  const s = formatEther(units * UNIT);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * Parses an ETH amount typed into the bid field. Returns the amount in wei, or -1n when the
 * string is not a number or does not land on a whole number of units. Amounts finer than a
 * unit are not expressible as cards and the contract rejects them.
 */
export function parseBidEth(input: string): bigint {
  const t = input.trim();
  if (!t) return 0n;
  let wei: bigint;
  try {
    wei = parseEther(t);
  } catch {
    return -1n;
  }
  if (wei < 0n || wei % UNIT !== 0n) return -1n;
  return wei;
}

/** Seconds remaining, or null while the auction has not started. */
export function secondsLeft(a: AuctionState, now: number): number | null {
  if (a.endTime === 0n) return null;
  // `now` (chainNowFor) is fractional, extrapolated between block reads; floored to whole
  // seconds so the countdown display doesn't render a fractional second.
  return Math.max(0, Math.floor(Number(a.endTime) - now));
}

/** Seconds until bidding opens, or null when the auction is not `"scheduled"`. */
export function secondsUntilStart(a: AuctionState, now: number): number | null {
  if (getPhase(a, now) !== "scheduled") return null;
  return Math.floor(Number(a.startTime) - now);
}

/** Formats seconds as "Hh MMm SSs", dropping units that are always zero at this magnitude
 *  (no hours below 3600s, no minutes below 60s) but always keeping seconds. */
export function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? m.toString().padStart(2, "0") : m.toString();
  const ss = h > 0 || m > 0 ? s.toString().padStart(2, "0") : s.toString();
  if (h > 0) return `${h}h ${mm}m ${ss}s`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${s}s`;
}

/** Formats a past unix timestamp relative to `now`, both in seconds, as "just now" / "Xm ago" /
 *  "Xh ago" / "Xd ago". Not for a future timestamp; the auction's own countdown covers that. */
export function formatRelativeTime(timestamp: number, now: number): string {
  if (timestamp <= 0) return "";
  const diff = Math.max(0, now - timestamp);
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** True once the deadline has passed and a bid exists, so `settle` would succeed. */
export function isSettleable(a: AuctionState, now: number): boolean {
  return !a.settled && a.endTime !== 0n && now >= Number(a.endTime);
}

/**
 * Whether the header's AUCTION link should show: the house's latest auction has loaded (not
 * "loading"/"error"/null) and is open for bids or awaiting settlement, i.e. every phase except
 * "settled".
 */
export function isAuctionActive(auction: AuctionSlot): boolean {
  if (typeof auction !== "object" || auction === null) return false;
  return getPhase(auction, chainNowFor(auction)) !== "settled";
}

/** The minimal card set for an amount, as `[denominationIndex, count]` pairs, largest first. */
export function breakdown(backingWei: bigint): {di: number; count: number}[] {
  const out: {di: number; count: number}[] = [];
  let remaining = backingWei;
  for (let i = DENOMINATIONS.length - 1; i >= 0; i--) {
    const amount = DENOMINATIONS[i]!.wei;
    const count = remaining / amount;
    if (count > 0n) out.push({di: i, count: Number(count)});
    remaining %= amount;
  }
  return out;
}

/**
 * The auction listed for a token, resolved through the house's own index rather than an assumed
 * auction id: the collection owner token is not necessarily the first auction created. Null when
 * the token has no auction.
 */
export async function loadAuctionFor(
  publicClient: PublicClient,
  dep: Deployment,
  tokenId: bigint,
  viewer: `0x${string}` | undefined,
): Promise<AuctionState | null> {
  if (!dep.auctionHouse) return null;
  const house = {address: dep.auctionHouse, abi: auctionHouseAbi} as const;
  const [exists, auctionId] = await publicClient.readContract({
    ...house,
    functionName: "getAuctionFor",
    args: [dep.shapes, tokenId],
  });
  if (exists) return loadAuction(publicClient, dep, auctionId, viewer);

  // claimLot deletes the token's index entry, so a finished auction is not listed there any
  // more. The record and its history still exist; the latest AuctionCreated for this token,
  // read from the house's logs, gives its id.
  const latest = await publicClient.getBlockNumber();
  const created = await paginate(dep, latest, (fromBlock, toBlock) =>
    publicClient.getContractEvents({
      ...house,
      eventName: "AuctionCreated",
      args: {nft: dep.shapes},
      fromBlock,
      toBlock,
    }),
  );
  const last = created.filter((log) => log.args.tokenId === tokenId).at(-1);
  const id = last?.args.auctionId;
  return id === undefined ? null : loadAuction(publicClient, dep, id, viewer);
}

export async function loadAuction(
  publicClient: PublicClient,
  dep: Deployment,
  auctionId: bigint,
  viewer: `0x${string}` | undefined,
): Promise<AuctionState | null> {
  if (!dep.auctionHouse) return null;
  const house = {address: dep.auctionHouse, abi: auctionHouseAbi} as const;

  // Guard before reading the auction record: the getter reverts for an id that has never been
  // created, and a house address with no code (or none deployed yet) returns zero data.
  const count = await publicClient.readContract({...house, functionName: "auctionCount"});
  if (count <= auctionId) return null;

  const raw = await publicClient.readContract({...house, functionName: "auctions", args: [auctionId]});
  if (raw.seller === ZERO) return null;

  // The leader's escrow is the viewer's own read when the viewer leads, so it is not read twice.
  const viewerLeads = !!viewer && viewer.toLowerCase() === raw.highestBidder.toLowerCase();
  const [minimumUnits, leaderCards, yourUnits, yourCards, block] = await Promise.all([
    publicClient.readContract({...house, functionName: "minimumBid", args: [auctionId]}),
    raw.highestBidder === ZERO || viewerLeads
      ? Promise.resolve([] as readonly bigint[])
      : publicClient.readContract({...house, functionName: "escrowedCards", args: [auctionId, raw.highestBidder]}),
    viewer
      ? publicClient.readContract({...house, functionName: "bidUnits", args: [auctionId, viewer]})
      : Promise.resolve(0n),
    viewer
      ? publicClient.readContract({...house, functionName: "escrowedCards", args: [auctionId, viewer]})
      : Promise.resolve([] as readonly bigint[]),
    publicClient.getBlock({blockTag: "latest"}),
  ]);
  const readAt = Date.now();

  return {
    id: auctionId,
    seller: raw.seller,
    tokenId: raw.tokenId,
    endTime: raw.endTime,
    startTime: raw.startTime,
    duration: raw.duration,
    extensionWindow: raw.extensionWindow,
    minIncrementBps: raw.minIncrementBps,
    reserveUnits: raw.reserveUnits,
    highestUnits: raw.highestUnits,
    highestBidder: raw.highestBidder,
    highestCards: [...(viewerLeads ? yourCards : leaderCards)],
    settled: raw.settled,
    lotClaimed: raw.lotClaimed,
    minimumUnits: BigInt(minimumUnits),
    yourUnits: BigInt(yourUnits),
    yourCards: [...yourCards],
    chainNow: Number(block.timestamp),
    readAt,
  };
}

export interface BidHistoryCard {
  id: bigint;
  /** Denomination index, or -1 when the card's backing could not be resolved (e.g. since burned). */
  di: number;
}

export interface BidHistoryEntry {
  key: string;
  block: bigint;
  logIndex: number;
  tx: `0x${string}`;
  bidder: `0x${string}`;
  /** This bidder's whole escrowed total after this bid, in units. Not the increment: BidPlaced
   *  carries the running total, since a bidder can top up across several transactions. */
  totalUnits: bigint;
  timestamp: number;
  /** Cards this bid's transaction moved into escrow, ascending by id. */
  cards: BidHistoryCard[];
}

/** Bids per auction in one read. An auction's bid count is bounded by its duration in practice;
 *  this cap keeps a hostile or broken response from growing without limit. */
const BID_LIMIT = 500;
// Escrowed cards read alongside those bids. Ponder rejects a limit above 1000, so a bid whose
// transaction escrowed enough cards to pass this shows the cards that fit.
const CARD_LIMIT = 1000;

const BID_QUERY = `query AuctionBids($auctionId: BigInt!, $limit: Int!) {
  _meta { status }
  activitys(
    where: {kind: "bid", auctionId: $auctionId}
    orderBy: "orderKey"
    orderDirection: "desc"
    limit: $limit
  ) {
    items { id actor units blockNumber logIndex txHash timestamp }
  }
}`;

const ESCROWED_CARDS_QUERY = `query EscrowedCards($txHashes: [String!], $limit: Int!) {
  escrowedCards(where: {txHash_in: $txHashes}, limit: $limit) {
    items { id txHash tokenId denomIndex }
  }
}`;

/** A `kind: "bid"` activity row: `actor` is the bidder, `units` its running escrowed total. */
interface IndexedBid {
  id: string;
  actor: `0x${string}`;
  units: string;
  blockNumber: string;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp: string;
}

interface IndexedEscrowedCard {
  id: string;
  txHash: `0x${string}`;
  tokenId: string;
  denomIndex: number;
}

export interface LoadBidHistoryOptions {
  indexerUrl?: string;
  fetch?: typeof fetch;
  maxIndexerLagBlocks?: bigint;
  indexerTimeoutMs?: number;
}

/**
 * Bid history for one auction, newest first, from the indexer. Each bid carries the cards its own
 * transaction moved into the house's custody, with the denomination they held then. Null when the
 * deployment names no indexer, or the indexer is unreachable, malformed, following another chain,
 * or behind the chain head by more than `maxIndexerLagBlocks`; the caller renders no bid history
 * rather than scanning the chain's event log for it.
 */
export async function loadBidHistory(
  publicClient: PublicClient,
  dep: Deployment,
  auctionId: bigint,
  options: LoadBidHistoryOptions = {},
): Promise<BidHistoryEntry[] | null> {
  const url = options.indexerUrl ?? dep.indexerUrl;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!dep.auctionHouse || !url || !fetcher) return null;

  try {
    const timeoutMs = options.indexerTimeoutMs ?? INDEXER_TIMEOUT_MS;
    const [head, payload] = await Promise.all([
      publicClient.getBlockNumber(),
      indexerQuery<{_meta?: IndexerMeta; activitys: {items: IndexedBid[]}}>(
        url,
        fetcher,
        BID_QUERY,
        {auctionId: auctionId.toString(), limit: BID_LIMIT},
        timeoutMs,
      ),
    ]);
    const bids = payload.data?.activitys?.items;
    if (!bids) throw new Error("Shapes indexer returned an invalid bid response");
    requireFreshCheckpoint(
      checkpointOf(payload.data?._meta, dep.chainId),
      head,
      options.maxIndexerLagBlocks ?? MAX_INDEXER_LAG_BLOCKS,
    );
    if (bids.length === 0) return [];

    const txHashes = [...new Set(bids.map((row) => row.txHash))];
    const cardsPayload = await indexerQuery<{escrowedCards: {items: IndexedEscrowedCard[]}}>(
      url,
      fetcher,
      ESCROWED_CARDS_QUERY,
      {txHashes, limit: CARD_LIMIT},
      timeoutMs,
    );
    const cardRows = cardsPayload.data?.escrowedCards?.items;
    if (!cardRows) throw new Error("Shapes indexer returned an invalid escrowed-card response");

    const cardsByTx = new Map<string, BidHistoryCard[]>();
    for (const row of cardRows) {
      const list = cardsByTx.get(row.txHash) ?? [];
      list.push({id: BigInt(row.tokenId), di: row.denomIndex});
      cardsByTx.set(row.txHash, list);
    }
    for (const list of cardsByTx.values()) {
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    return bids
      .map((row) => ({
        key: row.id,
        block: BigInt(row.blockNumber),
        logIndex: row.logIndex,
        tx: row.txHash,
        bidder: row.actor,
        totalUnits: BigInt(row.units),
        timestamp: Number(row.timestamp),
        cards: cardsByTx.get(row.txHash) ?? [],
      }))
      .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
  } catch {
    return null;
  }
}

/** The lot's artwork, from the Shapes contract's tokenURI. */
export async function loadLotImage(
  publicClient: PublicClient,
  dep: Deployment,
  a: AuctionState,
): Promise<string | null> {
  try {
    const uri = await publicClient.readContract({
      address: dep.shapes,
      abi: shapesAbi,
      functionName: "tokenURI",
      args: [a.tokenId],
    });
    const bytes = Uint8Array.from(
      atob(uri.replace("data:application/json;base64,", "")),
      (c) => c.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes)).image as string;
  } catch {
    return null; // the lot was burned, or is not renderable
  }
}

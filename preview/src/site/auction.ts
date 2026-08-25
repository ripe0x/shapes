import {decodeEventLog, type PublicClient} from "viem";
import {auctionHouseAbi, shapesAbi, DENOMINATIONS, denomIndexOf, type Deployment} from "../chain/abi";
import {paginate} from "../chain/history";
import {UNIT} from "../canonical/denominations";

/** The smallest denomination, and the unit every bid amount is carried in. */
export {UNIT};

export interface AuctionState {
  id: bigint;
  seller: `0x${string}`;
  tokenId: bigint;
  /** Zero until the first bid lands: the clock starts then, not at creation. */
  endTime: bigint;
  duration: bigint;
  extensionWindow: number;
  minIncrementBps: number;
  reserveUnits: bigint;
  highestUnits: bigint;
  highestBidder: `0x${string}`;
  settled: boolean;
  /** Smallest bid that would take the lead right now, in units. */
  minimumUnits: bigint;
  /** The connected wallet's own escrowed total and cards, if any. */
  yourUnits: bigint;
  yourCards: bigint[];
}

/**
 * Auction slot as loaded by the site: "loading" before the first read resolves,
 * null once resolved with no live auction, otherwise the loaded state. Kept
 * distinct from `AuctionState | null` so a slow first read cannot render as
 * "no auction is running."
 */
export type AuctionSlot = AuctionState | null | "loading";

export type Phase = "pre-bid" | "live" | "ended-unsettled" | "settled";

/** Lifecycle phase from auction state and chain time. */
export function getPhase(a: AuctionState, now: number): Phase {
  if (a.settled) return "settled";
  const left = secondsLeft(a, now);
  if (left === null) return "pre-bid";
  if (left === 0) return "ended-unsettled";
  return "live";
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function unitsToEth(units: bigint): string {
  const wei = units * UNIT;
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 16n; // hundredths
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}`;
}

/** Seconds remaining, or null while the auction has not started. */
export function secondsLeft(a: AuctionState, now: number): number | null {
  if (a.endTime === 0n) return null;
  return Math.max(0, Number(a.endTime) - now);
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

  const [minimumUnits, yourUnits, yourCards] = await Promise.all([
    publicClient.readContract({...house, functionName: "minimumBid", args: [auctionId]}),
    viewer
      ? publicClient.readContract({...house, functionName: "bidUnits", args: [auctionId, viewer]})
      : Promise.resolve(0n),
    viewer
      ? publicClient.readContract({...house, functionName: "escrowedCards", args: [auctionId, viewer]})
      : Promise.resolve([] as readonly bigint[]),
  ]);

  return {
    id: auctionId,
    seller: raw.seller,
    tokenId: raw.tokenId,
    endTime: raw.endTime,
    duration: raw.duration,
    extensionWindow: raw.extensionWindow,
    minIncrementBps: raw.minIncrementBps,
    reserveUnits: raw.reserveUnits,
    highestUnits: raw.highestUnits,
    highestBidder: raw.highestBidder,
    settled: raw.settled,
    minimumUnits: BigInt(minimumUnits),
    yourUnits: BigInt(yourUnits),
    yourCards: [...yourCards],
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

// Keyed by house address, auction id, and the count of BidPlaced logs seen so far: the entry list
// only needs recomputing once a new bid appears, so a repeat call with the same log count returns
// the prior result without re-fetching a receipt per bid.
const bidHistoryCache = new Map<string, BidHistoryEntry[]>();

/**
 * Bid history for one auction, newest first. Each BidPlaced log is paired with the cards its
 * transaction moved into escrow: a card the bidder already held arrives as a Shapes Transfer to
 * the house, a card the ETH path mints arrives as ShapeMinted (which also gives its exact
 * denomination without a separate read). A transferred card's denomination is resolved by a live
 * backingOf read, since the mint event does not cover a card that already existed.
 */
export async function loadBidHistory(
  publicClient: PublicClient,
  dep: Deployment,
  auctionId: bigint,
): Promise<BidHistoryEntry[]> {
  if (!dep.auctionHouse) return [];
  const house = {address: dep.auctionHouse, abi: auctionHouseAbi} as const;
  const houseAddr = dep.auctionHouse.toLowerCase();
  const shapesAddr = dep.shapes.toLowerCase();
  const latest = await publicClient.getBlockNumber();

  const placed = await paginate(dep, latest, (fromBlock, toBlock) =>
    publicClient.getContractEvents({...house, eventName: "BidPlaced", args: {auctionId}, fromBlock, toBlock}),
  );

  const cacheKey = `${houseAddr}:${auctionId}:${placed.length}`;
  const cached = bidHistoryCache.get(cacheKey);
  if (cached) return cached;

  const backingCache = new Map<string, bigint | null>();
  const backingOf = async (id: bigint): Promise<bigint | null> => {
    const k = id.toString();
    if (backingCache.has(k)) return backingCache.get(k)!;
    let v: bigint | null;
    try {
      v = await publicClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "backingOf", args: [id]});
    } catch {
      v = null; // the card no longer exists: composed, split, or redeemed since
    }
    backingCache.set(k, v);
    return v;
  };

  const raw: Omit<BidHistoryEntry, "timestamp">[] = [];
  for (const log of placed) {
    const tx = log.transactionHash as `0x${string}`;
    const receipt = await publicClient.getTransactionReceipt({hash: tx});

    const enteredIds = new Set<bigint>();
    const mintedAmounts = new Map<string, bigint>();
    for (const rl of receipt.logs) {
      if (rl.address.toLowerCase() !== shapesAddr) continue;
      let decoded;
      try {
        decoded = decodeEventLog({abi: shapesAbi, data: rl.data, topics: rl.topics});
      } catch {
        continue; // a Shapes log this ABI does not decode
      }
      if (decoded.eventName === "Transfer") {
        const args = decoded.args as {from: string; to: string; tokenId: bigint};
        if (args.to.toLowerCase() === houseAddr) enteredIds.add(args.tokenId);
      } else if (decoded.eventName === "ShapeMinted") {
        const args = decoded.args as {tokenId: bigint; amountWei: bigint};
        mintedAmounts.set(args.tokenId.toString(), args.amountWei);
      }
    }

    const cards: BidHistoryCard[] = [];
    for (const id of enteredIds) {
      const minted = mintedAmounts.get(id.toString());
      const wei = minted ?? (await backingOf(id));
      cards.push({id, di: wei === null ? -1 : denomIndexOf(wei)});
    }
    cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    raw.push({
      key: `${tx}-${log.logIndex}`,
      block: log.blockNumber as bigint,
      logIndex: log.logIndex as number,
      tx,
      bidder: log.args.bidder as `0x${string}`,
      totalUnits: BigInt(log.args.units ?? 0n),
      cards,
    });
  }

  const blocks = [...new Set(raw.map((e) => e.block))];
  const stamps = new Map(
    await Promise.all(
      blocks.map(async (b) => {
        const blk = await publicClient.getBlock({blockNumber: b});
        return [b, Number(blk.timestamp)] as const;
      }),
    ),
  );

  const entries = raw
    .map((e) => ({...e, timestamp: stamps.get(e.block) ?? 0}))
    .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));

  bidHistoryCache.set(cacheKey, entries);
  return entries;
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

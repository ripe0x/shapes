import type {PublicClient} from "viem";
import {auctionHouseAbi, shapesAbi, DENOMINATIONS, type Deployment} from "../chain/abi";

/** 0.01 ETH: the smallest denomination, and the unit every bid amount is carried in. */
export const UNIT = 10_000_000_000_000_000n;

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

export function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
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

/** The lot's artwork. Returns null once the lot has been redeemed and no longer renders. */
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
    return null; // the lot was burned
  }
}

// Row construction for the `activity` table. Kept apart from the handlers so the id, ordering
// key and per-kind detail fields are testable without a chain.

/** The kinds an activity row can carry. See the `activity` table comment for what `tokenIds`
 *  holds under each one. */
export type ActivityKind =
  | "mint"
  | "compose"
  | "decompose"
  | "split"
  | "redeem"
  | "burnBacking"
  | "ownerTokenMoved"
  | "transfer"
  | "auctionCreated"
  | "bid"
  | "auctionSettled"
  | "lotClaimed";

/** Where in the chain an event sits, taken from a Ponder event's log, block and transaction. */
export interface ActivityAt {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  timestamp: bigint;
}

/** Optional per-kind fields. Every one is null on the kinds that do not carry it. */
export interface ActivityDetails {
  counterparty?: `0x${string}`;
  amountWei?: bigint;
  auctionId?: bigint;
  units?: bigint;
}

export interface ActivityRow {
  id: string;
  blockNumber: bigint;
  logIndex: number;
  orderKey: bigint;
  timestamp: bigint;
  txHash: `0x${string}`;
  kind: ActivityKind;
  tokenIds: bigint[];
  actor: `0x${string}`;
  counterparty: `0x${string}` | null;
  amountWei: bigint | null;
  auctionId: bigint | null;
  units: bigint | null;
}

/** `blockNumber << 32 | logIndex`: one descending sort over this value reproduces chain order. */
export function activityOrderKey(blockNumber: bigint, logIndex: number): bigint {
  return (blockNumber << 32n) | BigInt(logIndex);
}

/** Primary key for one event's row. */
export function activityId(txHash: `0x${string}`, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

/** Primary key for a transaction's mint row. Every `ShapeMinted` in a transaction folds into one
 *  row, so the key names the transaction rather than any single log. */
export function mintActivityId(txHash: `0x${string}`): string {
  return `${txHash}-mint`;
}

export function activityRow(
  at: ActivityAt,
  kind: ActivityKind,
  tokenIds: bigint[],
  actor: `0x${string}`,
  details: ActivityDetails = {},
): ActivityRow {
  return {
    id: activityId(at.txHash, at.logIndex),
    blockNumber: at.blockNumber,
    logIndex: at.logIndex,
    orderKey: activityOrderKey(at.blockNumber, at.logIndex),
    timestamp: at.timestamp,
    txHash: at.txHash,
    kind,
    tokenIds,
    actor,
    counterparty: details.counterparty ?? null,
    amountWei: details.amountWei ?? null,
    auctionId: details.auctionId ?? null,
    units: details.units ?? null,
  };
}

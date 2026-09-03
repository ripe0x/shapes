import React from "react";
import {formatEther} from "viem";
import {DENOMINATIONS} from "../chain/abi";
import {tokenArt, type ArtToken} from "./art";
import {AddressName} from "./AddressName";
import {INDEXER_TIMEOUT_MS, indexerEndpoint, queryIndexer} from "./data";
import {C} from "./theme";
import {short, txUrl} from "./ui";

/** Rows per page, and per "Show more". */
export const ACTIVITY_PAGE_SIZE = 20;
/** Thumbnails drawn per row before the rest collapse into a count. A compose can name thousands
 *  of inputs; the row still has to fit on a line. */
export const ACTIVITY_MAX_THUMBS = 6;
/** One bid or settlement unit, the finest amount the denomination ladder expresses. */
const UNIT_WEI = 10n ** 16n;

/** One `activity` row as the indexer stores it. */
export interface ActivityEvent {
  id: string;
  blockNumber: bigint;
  timestamp: bigint;
  txHash: `0x${string}`;
  kind: string;
  tokenIds: bigint[];
  actor: `0x${string}`;
  counterparty: `0x${string}` | null;
  amountWei: bigint | null;
  auctionId: bigint | null;
  units: bigint | null;
}

/** The `token` row behind one thumbnail. The indexer keeps a row for every id ever minted, so a
 *  Shape burned by the event this row records still draws. */
export interface ActivityToken extends ArtToken {
  id: bigint;
  live: boolean;
}

/** Plain-word label per kind. An unrecognised kind (an indexer ahead of this build) shows its
 *  own name rather than nothing. */
const LABELS: Record<string, string> = {
  mint: "Minted",
  compose: "Composed into",
  split: "Split into",
  decompose: "Decomposed",
  redeem: "Redeemed",
  burnBacking: "Burned backing",
  ownerTokenMoved: "Owner token moved",
  transfer: "Transferred",
  auctionCreated: "Auction listed",
  bid: "Bid",
  auctionSettled: "Settled",
  lotClaimed: "Claimed",
};

export function activityLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}

/** Short address form for text-only detail lines, such as the counterparty of a transfer. */
function addressLabel(address: `0x${string}`): string {
  return short(address);
}

/** Trailing "0.10" becomes "0.1", "1.0" becomes "1". */
function eth(wei: bigint): string {
  return `${formatEther(wei)} ETH`;
}

/** Thousands-separated count for the stats row; empty while the value has not loaded. */
export function formatStatCount(n: bigint | null): string {
  return n === null ? "" : n.toLocaleString("en-US");
}

/** The one line of detail a kind carries beyond its label: the value moved, the counterparty, or
 *  the tokens involved. Empty when the label already says everything. */
export function activityDetail(event: ActivityEvent): string {
  const lead = event.tokenIds[0];
  switch (event.kind) {
    case "mint": {
      const n = event.tokenIds.length;
      const value = event.amountWei === null ? "" : `, ${eth(event.amountWei)}`;
      return `${n} Shape${n === 1 ? "" : "s"}${value}`;
    }
    case "compose":
    case "decompose":
      return lead === undefined ? "" : `#${lead}`;
    case "split": {
      const n = Math.max(0, event.tokenIds.length - 1);
      return `${n} Shape${n === 1 ? "" : "s"}`;
    }
    case "redeem":
      return event.amountWei === null ? "" : `${eth(event.amountWei)} returned`;
    case "burnBacking":
      return event.amountWei === null ? "" : `${eth(event.amountWei)} burned`;
    case "transfer":
      return event.counterparty === null ? "" : `to ${addressLabel(event.counterparty)}`;
    case "bid":
    case "auctionSettled":
      return event.units === null
        ? `Auction ${event.auctionId ?? "?"}`
        : `${eth(event.units * UNIT_WEI)}, auction ${event.auctionId ?? "?"}`;
    case "auctionCreated":
    case "lotClaimed":
      return `Auction ${event.auctionId ?? "?"}`;
    default:
      return "";
  }
}

export interface ActivityThumb {
  id: bigint;
  image: string;
  live: boolean;
}

/** What one feed row draws: the Shapes it can render, how many it could not, and how many it
 *  left out to stay on one line. A Shape the indexer has no row for cannot be drawn at all, so
 *  it is counted rather than guessed at. */
export interface ActivityRowModel {
  event: ActivityEvent;
  label: string;
  detail: string;
  thumbs: ActivityThumb[];
  /** Ids the indexer holds no token row for. */
  missing: number;
  /** Ids beyond `ACTIVITY_MAX_THUMBS` that resolved but are not drawn. */
  hidden: number;
}

export function activityRowModel(
  event: ActivityEvent,
  tokensById: ReadonlyMap<string, ActivityToken>,
  maxThumbs = ACTIVITY_MAX_THUMBS,
): ActivityRowModel {
  const resolved: ActivityToken[] = [];
  let missing = 0;
  for (const id of event.tokenIds) {
    const row = tokensById.get(id.toString());
    if (row) resolved.push(row);
    else missing++;
  }

  const drawn = resolved.slice(0, maxThumbs);
  return {
    event,
    label: activityLabel(event.kind),
    detail: activityDetail(event),
    thumbs: drawn.map((row) => ({id: row.id, image: tokenArt(row), live: row.live})),
    missing,
    hidden: resolved.length - drawn.length,
  };
}

/** Coarse age of an event, in the largest unit that reads as a whole number. */
export function relativeTime(timestampSeconds: bigint, nowSeconds: bigint): string {
  const age = nowSeconds - timestampSeconds;
  if (age < 60n) return "just now";
  if (age < 3_600n) return `${age / 60n}m ago`;
  if (age < 86_400n) return `${age / 3_600n}h ago`;
  return `${age / 86_400n}d ago`;
}

const ACTIVITY_QUERY = `query Activity($limit: Int!, $after: String) {
  activitys(orderBy: "orderKey", orderDirection: "desc", limit: $limit, after: $after) {
    items {
      id
      blockNumber
      timestamp
      txHash
      kind
      tokenIds
      actor
      counterparty
      amountWei
      auctionId
      units
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ACTIVITY_TOKENS_QUERY = `query ActivityTokens($ids: [BigInt!]!) {
  tokens(where: { id_in: $ids }, limit: 1000) {
    items { id seed denomIndex inkGene modules isBlack live }
  }
}`;

/** Two aggregates for the stats row, from the `totalCount` Ponder's generated GraphQL reports on
 *  any connection: every `token` row ever created (minted, including burned, since rows are
 *  never deleted) and every `compose` activity row. `limit: 1` keeps each side to its count. */
const ACTIVITY_STATS_QUERY = `query ActivityStats {
  tokens(limit: 1) { totalCount }
  activitys(where: { kind: "compose" }, limit: 1) { totalCount }
}`;

interface RawActivity {
  id: string;
  blockNumber: string;
  timestamp: string;
  txHash: `0x${string}`;
  kind: string;
  tokenIds: string[] | null;
  actor: `0x${string}`;
  counterparty: `0x${string}` | null;
  amountWei: string | null;
  auctionId: string | null;
  units: string | null;
}

interface RawToken {
  id: string;
  seed: `0x${string}`;
  denomIndex: number;
  inkGene: number;
  modules: `0x${string}` | null;
  isBlack: boolean;
  live: boolean;
}

interface ActivityResponse {
  data?: {activitys?: {items: RawActivity[]; pageInfo: {hasNextPage: boolean; endCursor: string | null}}};
  errors?: {message?: string}[];
}

interface ActivityTokensResponse {
  data?: {tokens?: {items: RawToken[]}};
  errors?: {message?: string}[];
}

interface ActivityStatsResponse {
  data?: {tokens?: {totalCount: number}; activitys?: {totalCount: number}};
  errors?: {message?: string}[];
}

export interface ActivityPage {
  events: ActivityEvent[];
  tokens: ActivityToken[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** The stats row's two indexer-derived counts. */
export interface ActivityStats {
  minted: bigint;
  composed: bigint;
}

/**
 * One page of activity plus the token rows its thumbnails need: two GraphQL requests, no chain
 * reads. The second request is skipped when the page names no Shapes.
 */
export async function fetchActivityPage(
  url: string,
  fetcher: typeof fetch,
  after: string | null,
  limit = ACTIVITY_PAGE_SIZE,
  timeoutMs = INDEXER_TIMEOUT_MS,
): Promise<ActivityPage> {
  const endpoint = indexerEndpoint(url);
  const page = await queryIndexer<ActivityResponse>(
    endpoint,
    fetcher,
    ACTIVITY_QUERY,
    {limit, after},
    timeoutMs,
  );
  if (page.errors?.length || !page.data?.activitys) {
    throw new Error(page.errors?.[0]?.message ?? "Shapes indexer returned an invalid activity response");
  }

  const events: ActivityEvent[] = page.data.activitys.items.map((row) => ({
    id: row.id,
    blockNumber: BigInt(row.blockNumber),
    timestamp: BigInt(row.timestamp),
    txHash: row.txHash,
    kind: row.kind,
    tokenIds: (row.tokenIds ?? []).map((id) => BigInt(id)),
    actor: row.actor,
    counterparty: row.counterparty,
    amountWei: row.amountWei === null ? null : BigInt(row.amountWei),
    auctionId: row.auctionId === null ? null : BigInt(row.auctionId),
    units: row.units === null ? null : BigInt(row.units),
  }));

  const ids = [...new Set(events.flatMap((event) => event.tokenIds.map((id) => id.toString())))];
  let tokens: ActivityToken[] = [];
  if (ids.length > 0) {
    const rows = await queryIndexer<ActivityTokensResponse>(
      endpoint,
      fetcher,
      ACTIVITY_TOKENS_QUERY,
      {ids},
      timeoutMs,
    );
    if (rows.errors?.length || !rows.data?.tokens) {
      throw new Error(rows.errors?.[0]?.message ?? "Shapes indexer returned an invalid token response");
    }
    tokens = rows.data.tokens.items
      // A denomination index off this build's ladder cannot be drawn; drop the row rather than
      // throwing out the whole page.
      .filter((row) => row.denomIndex >= 0 && row.denomIndex < DENOMINATIONS.length)
      .map((row) => ({
        id: BigInt(row.id),
        seed: BigInt(row.seed),
        denomIndex: row.denomIndex,
        inkGene: row.inkGene,
        modules: row.modules,
        isBlack: row.isBlack,
        live: row.live,
      }));
  }

  return {
    events,
    tokens,
    endCursor: page.data.activitys.pageInfo.endCursor,
    hasNextPage: page.data.activitys.pageInfo.hasNextPage,
  };
}

/** The stats row's two counts, one request. Fetched once alongside the feed's first page and
 *  never per render. */
export async function fetchActivityStats(
  url: string,
  fetcher: typeof fetch,
  timeoutMs = INDEXER_TIMEOUT_MS,
): Promise<ActivityStats> {
  const endpoint = indexerEndpoint(url);
  const res = await queryIndexer<ActivityStatsResponse>(endpoint, fetcher, ACTIVITY_STATS_QUERY, {}, timeoutMs);
  if (res.errors?.length || !res.data?.tokens || !res.data?.activitys) {
    throw new Error(res.errors?.[0]?.message ?? "Shapes indexer returned an invalid stats response");
  }
  return {minted: BigInt(res.data.tokens.totalCount), composed: BigInt(res.data.activitys.totalCount)};
}

function Thumb({thumb, onOpenToken}: {thumb: ActivityThumb; onOpenToken: (id: bigint) => void}) {
  return (
    <button
      type="button"
      className="btn-ghost activity-thumb"
      onClick={() => onOpenToken(thumb.id)}
      title={thumb.live ? `Shape ${thumb.id}` : `Shape ${thumb.id}, no longer live`}
    >
      <span className="activity-thumb-art" style={{backgroundColor: C.art}}>
        <img src={thumb.image} alt={`Shape ${thumb.id}`} />
      </span>
      <span className="activity-thumb-id">#{thumb.id.toString()}</span>
    </button>
  );
}

function ActivityRow({
  row,
  chainId,
  nowSeconds,
  onOpenToken,
}: {
  row: ActivityRowModel;
  chainId: number;
  nowSeconds: bigint;
  onOpenToken: (id: bigint) => void;
}) {
  const {event} = row;
  return (
    <li className="activity-row">
      <div className="activity-row-head">
        <span className="activity-kind">{row.label}</span>
        {row.detail && <span className="activity-detail">{row.detail}</span>}
        <span className="activity-detail">
          <AddressName address={event.actor} />
        </span>
      </div>

      <div className="activity-thumbs">
        {row.thumbs.map((thumb) => (
          <Thumb key={thumb.id.toString()} thumb={thumb} onOpenToken={onOpenToken} />
        ))}
        {row.hidden > 0 && <span className="activity-more">+{row.hidden} more</span>}
        {row.missing > 0 && (
          <span className="activity-more">
            {row.missing} not indexed
          </span>
        )}
      </div>

      <div className="activity-row-foot">
        <a
          href={txUrl(event.txHash, chainId)}
          target="_blank"
          rel="noreferrer"
          title={`Transaction ${event.txHash} on evm.now`}
        >
          {relativeTime(event.timestamp, nowSeconds)}
        </a>
      </div>
    </li>
  );
}

/**
 * Every protocol event, newest first, drawn from the indexer's own token rows so a burned Shape
 * still appears. Renders nothing without an indexer: the chain equivalent is a full log scan.
 */
export function ActivityFeed({
  indexerUrl,
  chainId,
  onOpenToken,
  fetcher,
  totalSupply,
  redeemableBacking,
}: {
  indexerUrl: string | undefined;
  chainId: number;
  onOpenToken: (id: bigint) => void;
  /** Deterministic tests and previews; production uses the global fetch. */
  fetcher?: typeof fetch;
  /** `SiteData.supply` (`totalSupply()`), for the "Live" stat. Null until the site's own load
   *  resolves; the stats row renders empty rather than reading the chain itself. */
  totalSupply: bigint | null;
  /** `SiteData.reserve` (`redeemableBacking()`), for the "ETH held" stat. Same null-while-loading
   *  behavior as `totalSupply`. */
  redeemableBacking: bigint | null;
}) {
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [tokens, setTokens] = React.useState<Map<string, ActivityToken>>(() => new Map());
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = React.useState(false);
  const [status, setStatus] = React.useState<"loading" | "ready" | "failed">("loading");
  const [stats, setStats] = React.useState<ActivityStats | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Fixed at mount so relative times do not re-render the feed on a timer.
  const [nowSeconds] = React.useState(() => BigInt(Math.floor(Date.now() / 1000)));

  const request = fetcher ?? (typeof fetch === "function" ? fetch : undefined);

  const absorb = React.useCallback((page: ActivityPage, append: boolean) => {
    setEvents((previous) => (append ? [...previous, ...page.events] : page.events));
    setTokens((previous) => {
      const next = append ? new Map(previous) : new Map<string, ActivityToken>();
      for (const row of page.tokens) next.set(row.id.toString(), row);
      return next;
    });
    setCursor(page.endCursor);
    setHasNextPage(page.hasNextPage);
  }, []);

  React.useEffect(() => {
    if (!indexerUrl || !request) return;
    let cancelled = false;
    setStatus("loading");
    // The stats row rides the feed's first-page load: one round trip on mount, no separate
    // polling, refreshed only when the feed itself reloads.
    Promise.all([fetchActivityPage(indexerUrl, request, null), fetchActivityStats(indexerUrl, request)]).then(
      ([page, s]) => {
        if (cancelled) return;
        absorb(page, false);
        setStats(s);
        setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [indexerUrl, request, absorb]);

  if (!indexerUrl || !request) return null;

  const showMore = () => {
    if (busy || !cursor) return;
    setBusy(true);
    fetchActivityPage(indexerUrl, request, cursor)
      .then((page) => absorb(page, true))
      .catch(() => setStatus("failed"))
      .finally(() => setBusy(false));
  };

  const rows = events.map((event) => activityRowModel(event, tokens));

  return (
    <section className="launch-section launch-activity" id="activity" aria-labelledby="activity-title">
      <div className="launch-section-heading">
        <div>
          <p className="launch-kicker">Onchain</p>
          <h2 id="activity-title">Proof of work</h2>
        </div>
        <p>
          Every mint, composition, split, redemption and auction, newest first. Shapes that no
          longer exist are drawn from the record they left behind.
        </p>
      </div>

      <div className="activity-stats">
        <div className="activity-stat">
          <p className="launch-kicker">Minted</p>
          <p className="activity-stat-value">{formatStatCount(stats?.minted ?? null)}</p>
        </div>
        <div className="activity-stat">
          <p className="launch-kicker">Live</p>
          <p className="activity-stat-value">{formatStatCount(totalSupply)}</p>
        </div>
        <div className="activity-stat">
          <p className="launch-kicker">ETH held</p>
          <p className="activity-stat-value">{redeemableBacking === null ? "" : eth(redeemableBacking)}</p>
        </div>
        <div className="activity-stat">
          <p className="launch-kicker">Composed</p>
          <p className="activity-stat-value">{formatStatCount(stats?.composed ?? null)}</p>
        </div>
      </div>

      {status === "loading" && rows.length === 0 && <p className="activity-note">Reading the index…</p>}
      {status === "failed" && rows.length === 0 && (
        <p className="activity-note">The activity index is unavailable right now.</p>
      )}
      {status === "ready" && rows.length === 0 && <p className="activity-note">Nothing has happened yet.</p>}

      {rows.length > 0 && (
        <ul className="activity-list">
          {rows.map((row) => (
            <ActivityRow
              key={row.event.id}
              row={row}
              chainId={chainId}
              nowSeconds={nowSeconds}
              onOpenToken={onOpenToken}
            />
          ))}
        </ul>
      )}

      {hasNextPage && (
        <button type="button" className="activity-more-button" onClick={showMore} disabled={busy}>
          {busy ? "Loading…" : "Show more"}
        </button>
      )}
    </section>
  );
}

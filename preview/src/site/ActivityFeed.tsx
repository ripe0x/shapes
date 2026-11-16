import React from "react";
import {formatEther} from "viem";
import {DENOMINATIONS} from "../chain/abi";
import {tokenArt, type ArtToken} from "./art";
import {AddressName} from "./AddressName";
import {INDEXER_TIMEOUT_MS, indexerQuery} from "./indexerClient";
import {C} from "./theme";
import {addrUrl, short, txUrl} from "./ui";

/** Rows per page, and per "Show more". */
export const ACTIVITY_PAGE_SIZE = 20;
/** Live-poll cadence while the feed section is mounted and the document is visible. */
export const ACTIVITY_LIVE_POLL_MS = 15_000;
/** Cadence after `ACTIVITY_LIVE_POLL_BACKOFF_THRESHOLD` consecutive poll failures. */
export const ACTIVITY_LIVE_POLL_BACKOFF_MS = ACTIVITY_LIVE_POLL_MS * 4;
export const ACTIVITY_LIVE_POLL_BACKOFF_THRESHOLD = 3;
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
  packId: bigint | null;
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
  packCreated: "Pack created",
  packExtended: "Pack expanded",
  packMerged: "Packs merged",
  packUnsealed: "Pack unsealed",
  packOpened: "Pack opened",
  packRedeemed: "Pack redeemed",
  packShapesClaimed: "Shapes claimed from pack",
  packEthClaimed: "ETH claimed from pack",
  packTransferred: "Pack transferred",
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
  if (event.kind.startsWith("pack")) return event.amountWei === null ? "" : eth(event.amountWei);
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
  primary: boolean;
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
  for (const id of event.packId === null ? event.tokenIds : []) {
    const row = tokensById.get(id.toString());
    if (row) resolved.push(row);
    else missing++;
  }

  const drawn = resolved.slice(0, maxThumbs);
  return {
    event,
    label: activityLabel(event.kind),
    detail: activityDetail(event),
    thumbs: drawn.map((row) => ({id: row.id, image: tokenArt(row), live: row.live,
      primary: event.kind === "compose" && row.id === event.tokenIds[0]})),
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

const SHAPE_WORK_KINDS = ["mint", "compose", "split", "decompose", "redeem", "burnBacking"];
const PACK_WORK_KINDS = [
  "packCreated", "packExtended", "packMerged", "packUnsealed", "packOpened",
  "packRedeemed", "packShapesClaimed", "packEthClaimed",
];
const WORK_KINDS = {
  all: [...SHAPE_WORK_KINDS, ...PACK_WORK_KINDS],
  shapes: SHAPE_WORK_KINDS,
  packs: PACK_WORK_KINDS,
};
const WORK_FILTERS = [
  {key: "all", label: "All"},
  {key: "shapes", label: "Shapes"},
  {key: "packs", label: "Packs"},
] as const;
type WorkFilter = keyof typeof WORK_KINDS;

// Select outcomes before pagination. Custody, ownership and market rows remain in the index.
const ACTIVITY_QUERY = `query Activity($limit: Int!, $after: String, $kinds: [String!]!) {
  activitys(where: {kind_in: $kinds}, orderBy: "orderKey", orderDirection: "desc", limit: $limit, after: $after) {
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
      packId
      units
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const LEGACY_ACTIVITY_QUERY = ACTIVITY_QUERY.replace("      packId\n", "");

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
  packId?: string | null;
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
  filter: WorkFilter = "all",
  limit = ACTIVITY_PAGE_SIZE,
  timeoutMs = INDEXER_TIMEOUT_MS,
): Promise<ActivityPage> {
  const variables = {limit, after, kinds: WORK_KINDS[filter]};
  const page = await indexerQuery<ActivityResponse["data"]>(url, fetcher, ACTIVITY_QUERY, variables, timeoutMs)
    .catch((error: unknown) => {
      // During the indexer rollout, the old schema lacks packId. Keep the existing feed readable.
      if (!(error instanceof Error) || !error.message.includes("packId")) throw error;
      return indexerQuery<ActivityResponse["data"]>(url, fetcher, LEGACY_ACTIVITY_QUERY, variables, timeoutMs);
    });
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
    packId: row.packId == null ? null : BigInt(row.packId),
    units: row.units === null ? null : BigInt(row.units),
  }));

  const ids = [...new Set(events.flatMap((event) => event.packId === null ? event.tokenIds.map((id) => id.toString()) : []))];
  let tokens: ActivityToken[] = [];
  if (ids.length > 0) {
    const rows = await indexerQuery<ActivityTokensResponse["data"]>(
      url,
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
  const res = await indexerQuery<ActivityStatsResponse["data"]>(url, fetcher, ACTIVITY_STATS_QUERY, {}, timeoutMs);
  if (res.errors?.length || !res.data?.tokens || !res.data?.activitys) {
    throw new Error(res.errors?.[0]?.message ?? "Shapes indexer returned an invalid stats response");
  }
  return {minted: BigInt(res.data.tokens.totalCount), composed: BigInt(res.data.activitys.totalCount)};
}

/** Merges a freshly polled first page into the already-loaded events: events already present (by
 *  id) are left alone, and everything new is prepended in the page's own newest-first order.
 *  Already-loaded pages beyond the first are untouched. */
export function mergeLivePage(
  existing: ActivityEvent[],
  page: ActivityPage,
): {events: ActivityEvent[]; addedIds: string[]} {
  const known = new Set(existing.map((event) => event.id));
  const fresh = page.events.filter((event) => !known.has(event.id));
  if (fresh.length === 0) return {events: existing, addedIds: []};
  return {events: [...fresh, ...existing], addedIds: fresh.map((event) => event.id)};
}

/**
 * Runs `tick` on a timer at `intervalMs` while `isHidden()` is false, backing off to `backoffMs`
 * after `backoffThreshold` consecutive failures (`tick` resolving `false`) and recovering on the
 * next success. A tick due while hidden is skipped rather than fired late; call the returned
 * `wake` from a `visibilitychange` handler to poll immediately once the tab is visible again.
 */
export function scheduleLivePoll(
  tick: () => Promise<boolean>,
  isHidden: () => boolean,
  opts: {intervalMs?: number; backoffMs?: number; backoffThreshold?: number} = {},
): {stop: () => void; wake: () => void} {
  const {
    intervalMs = ACTIVITY_LIVE_POLL_MS,
    backoffMs = ACTIVITY_LIVE_POLL_BACKOFF_MS,
    backoffThreshold = ACTIVITY_LIVE_POLL_BACKOFF_THRESHOLD,
  } = opts;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    if (stopped || isHidden()) return; // paused; `wake` resumes on visibility
    tick().then((ok) => {
      failures = ok ? 0 : failures + 1;
      schedule();
    });
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(fire, failures >= backoffThreshold ? backoffMs : intervalMs);
  };
  const wake = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    fire();
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    wake,
  };
}

function Thumb({thumb, onOpenToken}: {thumb: ActivityThumb; onOpenToken: (id: bigint) => void}) {
  return (
    <button
      type="button"
      className={`btn-ghost activity-thumb${thumb.primary ? " activity-thumb--primary" : ""}`}
      onClick={() => onOpenToken(thumb.id)}
      title={thumb.primary ? `Composed Shape ${thumb.id}` : thumb.live ? `Shape ${thumb.id}` : `Shape ${thumb.id}, no longer live`}
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
  isNew,
}: {
  row: ActivityRowModel;
  chainId: number;
  nowSeconds: bigint;
  onOpenToken: (id: bigint) => void;
  /** Just prepended by a live poll. */
  isNew: boolean;
}) {
  const {event} = row;
  const packArtBlock = event.kind === "packUnsealed" || event.kind === "packOpened" || event.kind === "packRedeemed"
    ? (event.blockNumber - 1n).toString()
    : event.kind === "packShapesClaimed" || event.kind === "packEthClaimed" ? "exit" : event.blockNumber.toString();
  return (
    <li className={`activity-row${isNew ? " is-new" : ""}`}>
      <div className="activity-row-head">
        <span className="activity-kind">{row.label}</span>
        <span className="activity-meta">
          {row.detail && <span className="activity-detail">{row.detail}</span>}
          <span className="activity-actor">
            <a href={addrUrl(event.actor, chainId)} target="_blank" rel="noreferrer"
              aria-label={`View ${event.actor} on evm.now`}>
              <AddressName address={event.actor} />
            </a>
          </span>
        </span>
      </div>

      <div className="activity-thumbs">
        {event.packId !== null ? (
          <a className="activity-thumb activity-pack-thumb" href={`/packs/${event.packId}`} title={`Pack #${event.packId}`}>
            <span className="activity-thumb-art">
              <img src={`/api/pack-art/${event.packId}/${packArtBlock}`} alt={`Pack #${event.packId} artwork`} loading="lazy" />
            </span>
          </a>
        ) : row.thumbs.map((thumb) => (
          <Thumb key={thumb.id.toString()} thumb={thumb} onOpenToken={onOpenToken} />
        ))}
        {event.packId === null && row.hidden > 0 && <span className="activity-more">+{row.hidden} more</span>}
        {event.packId === null && row.missing > 0 && (
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
 * One row per indexed action, newest first. Pack transactions use their lifecycle event instead
 * of each constituent Shape event. Renders nothing without an indexer.
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
  const [filter, setFilter] = React.useState<WorkFilter>("all");
  const filterRef = React.useRef(filter);
  const filterEpochRef = React.useRef(0);
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
    // The stats row rides the feed's first-page load: one round trip on mount, refreshed again by
    // every live poll below.
    Promise.all([fetchActivityPage(indexerUrl, request, null, filter), fetchActivityStats(indexerUrl, request)]).then(
      ([page, s]) => {
        if (cancelled || filterRef.current !== filter) return;
        absorb(page, false);
        setStats(s);
        setStatus("ready");
      },
      () => {
        if (!cancelled && filterRef.current === filter) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [indexerUrl, request, absorb, filter]);

  // Keep the current rows available to identify which polled events are new for animation.
  const eventsRef = React.useRef(events);
  React.useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  const [newIds, setNewIds] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    // Starts only once the first page has loaded; an indexer that never comes up never polls.
    if (!indexerUrl || !request || status !== "ready") return;
    let cancelled = false;
    const tick = (): Promise<boolean> =>
      Promise.all([fetchActivityPage(indexerUrl, request, null, filter), fetchActivityStats(indexerUrl, request)]).then(
        ([page, s]) => {
          if (cancelled || filterRef.current !== filter) return true;
          const merged = mergeLivePage(eventsRef.current, page);
          if (merged.addedIds.length > 0) {
            // A "Show more" request can finish after the poll starts. Merge against the latest
            // state when React applies this update so the appended page stays in the feed.
            setEvents((previous) => mergeLivePage(previous, page).events);
            setTokens((previous) => {
              const next = new Map(previous);
              for (const row of page.tokens) next.set(row.id.toString(), row);
              return next;
            });
            setNewIds(new Set(merged.addedIds));
          }
          setStats(s);
          return true;
        },
        () => false,
      );
    const isHidden = () => typeof document !== "undefined" && document.hidden;
    const {stop, wake} = scheduleLivePoll(tick, isHidden);
    const onVisibility = () => {
      if (!isHidden()) wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [indexerUrl, request, status, filter]);

  if (!indexerUrl || !request) return null;

  const selectFilter = (next: WorkFilter) => {
    if (next === filterRef.current) return;
    filterRef.current = next;
    filterEpochRef.current++;
    setFilter(next);
    setEvents([]);
    setTokens(new Map());
    setCursor(null);
    setHasNextPage(false);
    setNewIds(new Set());
    setBusy(false);
    setStatus("loading");
  };

  const showMore = () => {
    if (busy || !cursor) return;
    const filterEpoch = filterEpochRef.current;
    setBusy(true);
    fetchActivityPage(indexerUrl, request, cursor, filter)
      .then((page) => { if (filterEpochRef.current === filterEpoch) absorb(page, true); })
      .catch(() => { if (filterEpochRef.current === filterEpoch) setStatus("failed"); })
      .finally(() => { if (filterEpochRef.current === filterEpoch) setBusy(false); });
  };

  // Pagination counts events, so every fetched event needs its own visible row.
  const rows = events.map((event) => activityRowModel(event, tokens));

  return (
    <section className="launch-section launch-activity" id="activity" aria-labelledby="activity-title">
      <div className="launch-section-heading">
        <div>
          <h2 id="activity-title">Proof of work</h2>
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

      </div>

      <div className="activity-filters" role="group" aria-label="Proof of work filter">
        {WORK_FILTERS.map(({key, label}) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => selectFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {status === "loading" && rows.length === 0 && <p className="activity-note">Reading the index…</p>}
      {status === "failed" && rows.length === 0 && (
        <p className="activity-note">The activity index is unavailable right now.</p>
      )}
      {status === "ready" && rows.length === 0 && <p className="activity-note">No work to show.</p>}

      {rows.length > 0 && (
        <ul className="activity-list">
          {rows.map((row) => (
            <ActivityRow
              key={row.event.id}
              row={row}
              chainId={chainId}
              nowSeconds={nowSeconds}
              onOpenToken={onOpenToken}
              isNew={newIds.has(row.event.id)}
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

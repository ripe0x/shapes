import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_PAGE_SIZE,
  activityDetail,
  activityLabel,
  activityRowModel,
  fetchActivityPage,
  fetchActivityStats,
  formatStatCount,
  relativeTime,
  type ActivityEvent,
  type ActivityToken,
} from "./ActivityFeed";

const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const ALICE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const BOB = "0x2222222222222222222222222222222222222222" as `0x${string}`;

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: `${TX}-1`,
    blockNumber: 100n,
    timestamp: 1_700_000_000n,
    txHash: TX,
    kind: "compose",
    tokenIds: [7n, 8n, 9n],
    actor: ALICE,
    counterparty: null,
    amountWei: null,
    auctionId: null,
    units: null,
    ...overrides,
  };
}

function token(id: bigint, overrides: Partial<ActivityToken> = {}): ActivityToken {
  return {
    id,
    seed: 0x1234n + id,
    denomIndex: 0,
    inkGene: 0,
    modules: null,
    isBlack: false,
    live: true,
    ...overrides,
  };
}

function indexOf(rows: ActivityToken[]): Map<string, ActivityToken> {
  return new Map(rows.map((row) => [row.id.toString(), row]));
}

test("every kind has a plain-word label, and an unknown kind falls back to its own name", () => {
  assert.equal(activityLabel("mint"), "Minted");
  assert.equal(activityLabel("compose"), "Composed into");
  assert.equal(activityLabel("split"), "Split into");
  assert.equal(activityLabel("decompose"), "Decomposed");
  assert.equal(activityLabel("redeem"), "Redeemed");
  assert.equal(activityLabel("burnBacking"), "Burned backing");
  assert.equal(activityLabel("ownerTokenMoved"), "Owner token moved");
  assert.equal(activityLabel("transfer"), "Transferred");
  assert.equal(activityLabel("auctionCreated"), "Auction listed");
  assert.equal(activityLabel("bid"), "Bid");
  assert.equal(activityLabel("auctionSettled"), "Settled");
  assert.equal(activityLabel("lotClaimed"), "Claimed");
  assert.equal(activityLabel("somethingNewer"), "somethingNewer");
});

test("detail states the value or counterparty each kind carries", () => {
  assert.equal(
    activityDetail(event({kind: "mint", tokenIds: [1n, 2n], amountWei: 2n * 10n ** 16n})),
    "2 Shapes, 0.02 ETH",
  );
  assert.equal(activityDetail(event({kind: "compose", tokenIds: [7n, 8n]})), "#7");
  assert.equal(activityDetail(event({kind: "split", tokenIds: [7n, 8n, 9n]})), "2 Shapes");
  assert.equal(
    activityDetail(event({kind: "redeem", tokenIds: [4n], amountWei: 10n ** 17n})),
    "0.1 ETH returned",
  );
  assert.equal(
    activityDetail(event({kind: "transfer", tokenIds: [4n], counterparty: BOB})),
    `to ${BOB.slice(0, 6)}…${BOB.slice(-4)}`,
  );
  assert.equal(
    activityDetail(event({kind: "bid", tokenIds: [], auctionId: 3n, units: 5n})),
    "0.05 ETH, auction 3",
  );
});

test("a row draws every Shape the indexer keeps a row for, live or not", () => {
  const row = activityRowModel(event(), indexOf([token(7n), token(8n, {live: false}), token(9n, {live: false})]));

  assert.deepEqual(row.thumbs.map((t) => t.id), [7n, 8n, 9n]);
  assert.deepEqual(row.thumbs.map((t) => t.live), [true, false, false]);
  assert.ok(row.thumbs.every((t) => t.image.startsWith("data:image/svg+xml;base64,")));
  assert.equal(row.missing, 0);
  assert.equal(row.hidden, 0);
});

test("ids with no token row are counted rather than drawn", () => {
  const row = activityRowModel(event(), indexOf([token(7n)]));

  assert.deepEqual(row.thumbs.map((t) => t.id), [7n]);
  assert.equal(row.missing, 2);
});

test("a wide event draws up to the thumbnail cap and counts the rest", () => {
  const ids = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];
  const row = activityRowModel(event({tokenIds: ids}), indexOf(ids.map((id) => token(id))), 6);

  assert.equal(row.thumbs.length, 6);
  assert.equal(row.hidden, 2);
  assert.equal(row.missing, 0);
});

test("materialized geometry draws a different Shape than the seed alone", () => {
  const seedDrawn = activityRowModel(event({tokenIds: [7n]}), indexOf([token(7n)]));
  // A 5x5 grid of the same module byte: valid geometry for denomination 0.
  const modules = `0x${"00".repeat(25)}` as `0x${string}`;
  const sampled = activityRowModel(event({tokenIds: [7n]}), indexOf([token(7n, {modules})]));

  assert.notEqual(seedDrawn.thumbs[0].image, sampled.thumbs[0].image);
});

test("relative time reads in the largest whole unit", () => {
  const now = 1_700_000_000n;
  assert.equal(relativeTime(now - 30n, now), "just now");
  assert.equal(relativeTime(now - 300n, now), "5m ago");
  assert.equal(relativeTime(now - 7_200n, now), "2h ago");
  assert.equal(relativeTime(now - 259_200n, now), "3d ago");
});

/** A fetch stub answering the activity query then the token query, recording every request. */
function stubIndexer(pages: {items: unknown[]; hasNextPage: boolean; endCursor: string | null}[]) {
  const calls: {query: string; variables: Record<string, unknown>}[] = [];
  let pageIndex = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push(body);
    if (body.query.includes("activitys")) {
      const page = pages[pageIndex++]!;
      return new Response(
        JSON.stringify({
          data: {activitys: {items: page.items, pageInfo: {hasNextPage: page.hasNextPage, endCursor: page.endCursor}}},
        }),
        {headers: {"content-type": "application/json"}},
      );
    }
    const ids = body.variables.ids as string[];
    return new Response(
      JSON.stringify({
        data: {
          tokens: {
            items: ids.map((id) => ({
              id,
              seed: `0x${"11".repeat(32)}`,
              denomIndex: 0,
              inkGene: 0,
              modules: null,
              isBlack: false,
              live: true,
            })),
          },
        },
      }),
      {headers: {"content-type": "application/json"}},
    );
  };
  return {fetcher, calls};
}

const rawEvent = (id: string, tokenIds: string[]) => ({
  id,
  blockNumber: "100",
  timestamp: "1700000000",
  txHash: TX,
  kind: "mint",
  tokenIds,
  actor: ALICE,
  counterparty: null,
  amountWei: "10000000000000000",
  auctionId: null,
  units: null,
});

test("a page asks for the requested size and resolves only the ids it names, once each", async () => {
  const {fetcher, calls} = stubIndexer([
    {items: [rawEvent("a", ["1", "2"]), rawEvent("b", ["2", "3"])], hasNextPage: true, endCursor: "cursor-1"},
  ]);

  const page = await fetchActivityPage("http://indexer.test/", fetcher, null);

  assert.equal(calls[0].variables.limit, ACTIVITY_PAGE_SIZE);
  assert.equal(calls[0].variables.after, null);
  // Ids are de-duplicated across the page's events before the token query.
  assert.deepEqual(calls[1].variables.ids, ["1", "2", "3"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(page.events.map((e) => e.id), ["a", "b"]);
  assert.deepEqual(page.events[0].tokenIds, [1n, 2n]);
  assert.equal(page.events[0].amountWei, 10n ** 16n);
  assert.equal(page.endCursor, "cursor-1");
  assert.equal(page.hasNextPage, true);
});

test("the next page is requested after the previous cursor", async () => {
  const {fetcher, calls} = stubIndexer([
    {items: [rawEvent("a", ["1"])], hasNextPage: true, endCursor: "cursor-1"},
    {items: [rawEvent("b", ["2"])], hasNextPage: false, endCursor: null},
  ]);

  const first = await fetchActivityPage("http://indexer.test", fetcher, null);
  const second = await fetchActivityPage("http://indexer.test", fetcher, first.endCursor);

  assert.equal(calls[2].variables.after, "cursor-1");
  assert.deepEqual(second.events.map((e) => e.id), ["b"]);
  assert.equal(second.hasNextPage, false);
  assert.equal(second.endCursor, null);
});

test("a page naming no Shapes skips the token query", async () => {
  const {fetcher, calls} = stubIndexer([
    {items: [rawEvent("a", [])], hasNextPage: false, endCursor: null},
  ]);

  const page = await fetchActivityPage("http://indexer.test", fetcher, null);

  assert.equal(calls.length, 1);
  assert.deepEqual(page.tokens, []);
});

test("a GraphQL error rejects rather than showing an empty feed", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({errors: [{message: "activity is not a table"}]}), {
      headers: {"content-type": "application/json"},
    });

  await assert.rejects(
    () => fetchActivityPage("http://indexer.test", fetcher, null),
    /activity is not a table/,
  );
});

test("the stats query filters the compose count by kind and counts every token row", async () => {
  let seenQuery = "";
  let seenVariables: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    seenQuery = body.query;
    seenVariables = body.variables;
    return new Response(
      JSON.stringify({data: {tokens: {totalCount: 42}, activitys: {totalCount: 7}}}),
      {headers: {"content-type": "application/json"}},
    );
  };

  const stats = await fetchActivityStats("http://indexer.test", fetcher);

  assert.match(seenQuery, /activitys\(where:\s*{\s*kind:\s*"compose"\s*}/);
  assert.match(seenQuery, /tokens\(limit:\s*1\)\s*{\s*totalCount\s*}/);
  assert.deepEqual(seenVariables, {});
  assert.equal(stats.minted, 42n);
  assert.equal(stats.composed, 7n);
});

test("a stats response missing either count rejects rather than showing a stale row", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({data: {tokens: {totalCount: 42}}}), {
      headers: {"content-type": "application/json"},
    });

  await assert.rejects(() => fetchActivityStats("http://indexer.test", fetcher));
});

test("stat counts get thousands separators, and a not-yet-loaded value renders empty", () => {
  assert.equal(formatStatCount(0n), "0");
  assert.equal(formatStatCount(950n), "950");
  assert.equal(formatStatCount(1_000n), "1,000");
  assert.equal(formatStatCount(1_234_567n), "1,234,567");
  assert.equal(formatStatCount(null), "");
});

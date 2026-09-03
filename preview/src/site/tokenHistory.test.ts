import {test} from "node:test";
import assert from "node:assert/strict";
import {type PublicClient} from "viem";

import {loadTokenHistory} from "./tokenHistory";
import {loadBidHistory} from "./auction";
import {DENOMINATIONS, type Deployment} from "../chain/abi";

const SHAPES = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
const HOUSE = "0x000000000000000000000000000000000000BEEF" as `0x${string}`;
const BIDDER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const TX2 = `0x${"cd".repeat(32)}` as `0x${string}`;

const dep = {
  shapes: SHAPES,
  auctionHouse: HOUSE,
  rpc: "http://localhost",
  chainId: 31337,
} as unknown as Deployment;

/** A client that only answers `getBlockNumber`: the history paths read nothing else from chain. */
function headAt(head: bigint): PublicClient {
  return {
    async getBlockNumber() {
      return head;
    },
  } as unknown as PublicClient;
}

function graphql(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: {"content-type": "application/json"},
    })) as typeof fetch;
}

const META = {status: {chain: {id: 31337, block: {number: 100}}}};

function edge(overrides: Record<string, unknown>) {
  return {
    id: `${TX}-3-0`,
    kind: "continuation",
    childId: "7",
    parentId: "4",
    parentDenomIndex: 1,
    block: "90",
    logIndex: 3,
    timestamp: "1700000000",
    txHash: TX,
    ...overrides,
  };
}

test("loadTokenHistory: a mint-born token that later absorbed two Shapes", async () => {
  const events = await loadTokenHistory(headAt(100n), dep, 4n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({
      data: {
        _meta: META,
        token: {
          id: "4",
          mintDenomIndex: 0,
          mintedAtBlock: "10",
          mintedAt: "1600000000",
          mintTxHash: TX2,
        },
        // Both edges share a transaction and log index: one compose absorbing two Shapes.
        fromParent: {items: [edge({childId: "7"}), edge({id: `${TX}-3-1`, childId: "8"})]},
        toChild: {items: []},
        activitys: {items: []},
      },
    }),
  });

  assert.ok(events);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["mint", "absorbed"],
  );
  assert.equal(events[0]!.text, `1 origin, ${DENOMINATIONS[0].label} ETH`);
  assert.equal(events[0]!.timestamp, 1_600_000_000);
  assert.equal(events[1]!.text, "Absorbed 2 Shapes and grew to a larger denomination");
});

test("loadTokenHistory: a split-born token reports its birth, not a mint", async () => {
  const events = await loadTokenHistory(headAt(100n), dep, 7n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({
      data: {
        _meta: META,
        token: {
          id: "7",
          mintDenomIndex: 2,
          mintedAtBlock: "90",
          mintedAt: "1700000000",
          mintTxHash: TX,
        },
        fromParent: {items: []},
        toChild: {items: [edge({kind: "split", childId: "7", parentId: "4"})]},
        activitys: {items: []},
      },
    }),
  });

  assert.ok(events);
  assert.deepEqual(events.map((e) => e.kind), ["bornFromSplit"]);
  assert.equal(events[0]!.text, "Created by splitting #4");
});

test("loadTokenHistory: a decompose names the denomination the survivor reverted to", async () => {
  const events = await loadTokenHistory(headAt(100n), dep, 4n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({
      data: {
        _meta: META,
        token: null,
        fromParent: {items: [edge({kind: "revival", parentDenomIndex: 3})]},
        toChild: {items: []},
        activitys: {items: []},
      },
    }),
  });

  assert.ok(events);
  assert.equal(
    events[0]!.text,
    `Released 1 Shape under their original IDs and reverted to ${DENOMINATIONS[3].label} ETH`,
  );
});

test("loadTokenHistory: no indexer, a stale one, or a failing one yields no history at all", async () => {
  const noIndexer = await loadTokenHistory(headAt(100n), dep, 4n, {fetch: graphql({})});
  assert.equal(noIndexer, null);

  const stale = await loadTokenHistory(headAt(200n), dep, 4n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({
      data: {_meta: META, token: null, fromParent: {items: []}, toChild: {items: []}, activitys: {items: []}},
    }),
  });
  assert.equal(stale, null);

  const wrongChain = await loadTokenHistory(headAt(100n), dep, 4n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({
      data: {
        _meta: {status: {chain: {id: 1, block: {number: 100}}}},
        token: null,
        fromParent: {items: []},
        toChild: {items: []},
        activitys: {items: []},
      },
    }),
  });
  assert.equal(wrongChain, null);

  const down = await loadTokenHistory(headAt(100n), dep, 4n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({}, 503),
  });
  assert.equal(down, null);
});

test("loadBidHistory: bids come from the indexer, newest first, with the cards each escrowed", async () => {
  let call = 0;
  const fetcher = (async () => {
    call++;
    const body =
      call === 1
        ? {
            data: {
              _meta: META,
              activitys: {
                items: [
                  {id: `${TX2}-1`, actor: BIDDER, units: "300", blockNumber: "95", logIndex: 1, txHash: TX2, timestamp: "1700000500"},
                  {id: `${TX}-1`, actor: BIDDER, units: "100", blockNumber: "90", logIndex: 1, txHash: TX, timestamp: "1700000000"},
                ],
              },
            },
          }
        : {
            data: {
              escrowedCards: {
                items: [
                  {id: `${TX}-9`, txHash: TX, tokenId: "9", denomIndex: 0},
                  {id: `${TX2}-4`, txHash: TX2, tokenId: "4", denomIndex: 1},
                  {id: `${TX2}-2`, txHash: TX2, tokenId: "2", denomIndex: 0},
                ],
              },
            },
          };
    return new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch;

  const entries = await loadBidHistory(headAt(100n), dep, 0n, {
    indexerUrl: "http://indexer.test",
    fetch: fetcher,
  });

  assert.ok(entries);
  assert.deepEqual(entries.map((e) => e.totalUnits), [300n, 100n]);
  assert.deepEqual(entries[0]!.cards, [{id: 2n, di: 0}, {id: 4n, di: 1}]);
  assert.deepEqual(entries[1]!.cards, [{id: 9n, di: 0}]);
  assert.equal(entries[0]!.timestamp, 1_700_000_500);
});

test("loadBidHistory: no indexer or a stale one yields no bid history at all", async () => {
  const noIndexer = await loadBidHistory(headAt(100n), dep, 0n, {fetch: graphql({})});
  assert.equal(noIndexer, null);

  const stale = await loadBidHistory(headAt(200n), dep, 0n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({data: {_meta: META, activitys: {items: []}}}),
  });
  assert.equal(stale, null);
});

const OTHER = "0x2222222222222222222222222222222222222222" as `0x${string}`;

function activityRow(overrides: Record<string, unknown>) {
  return {
    id: `${TX}-1`,
    kind: "transfer",
    blockNumber: "20",
    logIndex: 1,
    timestamp: "1600001000",
    txHash: TX,
    actor: BIDDER,
    counterparty: null,
    amountWei: null,
    ...overrides,
  };
}

test("loadTokenHistory: transfers, redemption and backing burn come from the activity rows", async () => {
  const events = await loadTokenHistory(headAt(100n), dep, 4n, {
    indexerUrl: "http://indexer.test",
    fetch: graphql({
      data: {
        _meta: META,
        token: {id: "4", mintDenomIndex: 0, mintedAtBlock: "10", mintedAt: "1600000000", mintTxHash: TX2},
        fromParent: {items: []},
        toChild: {items: []},
        activitys: {
          items: [
            activityRow({counterparty: OTHER}),
            activityRow({
              id: `${TX}-2`,
              kind: "burnBacking",
              blockNumber: "30",
              logIndex: 2,
              actor: OTHER,
              amountWei: "1000000000000000000",
            }),
            activityRow({
              id: `${TX2}-3`,
              kind: "redeem",
              blockNumber: "40",
              logIndex: 3,
              txHash: TX2,
              actor: OTHER,
              amountWei: "500000000000000000",
            }),
            // A kind the lineage edges already cover is not repeated from the activity rows.
            activityRow({id: `${TX2}-4`, kind: "compose", blockNumber: "50", logIndex: 4, txHash: TX2}),
          ],
        },
      },
    }),
  });

  assert.ok(events);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["mint", "transfer", "backingBurned", "redeemed"],
  );
  assert.equal(events[1]!.text, "From 0x1111…1111 to 0x2222…2222");
  assert.equal(events[2]!.text, "1 ETH backing burned");
  assert.equal(events[3]!.text, "0.5 ETH returned to 0x2222…2222");
});

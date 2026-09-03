import {test} from "node:test";
import assert from "node:assert/strict";
import {ContractFunctionRevertedError, encodeErrorResult, type PublicClient} from "viem";

import {loadSite, seedFee, seedMintStart, type SiteData} from "./data";
import {BLACK_FILTER, filterGalleryTokens, originsLabel} from "./GalleryView";
import {filterOwnedTokens} from "./MyShapesView";
import {DENOMINATIONS, shapesAbi, type Deployment} from "../chain/abi";
import {GENE_NAMES} from "../canonical/ink";

/** A real decodable `NoOwnerToken()` revert, as viem's readContract would throw it. */
function noOwnerTokenRevert(): ContractFunctionRevertedError {
  const data = encodeErrorResult({abi: shapesAbi, errorName: "NoOwnerToken"});
  return new ContractFunctionRevertedError({abi: shapesAbi, data, functionName: "ownerToken"});
}

const SHAPES = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}`;
const OWNER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ARTIST = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const RELEASE_HASH = `0x${"44".repeat(32)}` as `0x${string}`;
const GENESIS_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;

test("filterOwnedTokens matches wallet addresses without changing newest-first order", () => {
  const tokens = [
    {id: 3n, owner: OWNER.toUpperCase()},
    {id: 2n, owner: ARTIST},
    {id: 1n, owner: OWNER},
  ];
  assert.deepEqual(
    filterOwnedTokens(tokens, OWNER).map((token) => token.id),
    [3n, 1n],
  );
});

const dep = {
  shapes: SHAPES,
  artist: ARTIST,
  rpc: "http://localhost",
  chainId: 31337,
} as unknown as Deployment;

interface FakeToken {
  backing: bigint;
  seed: `0x${string}`;
  black: boolean;
  composeDepth: bigint;
  ink: string;
  /** Defaults to OWNER; set to simulate a transfer between loads. */
  owner?: `0x${string}`;
}

function tokenUriFor(id: bigint, t: FakeToken): string {
  const json = JSON.stringify({
    name: `Shape ${id}`,
    description: "test",
    image: `data:image/svg+xml;base64,${Buffer.from(`<svg id="${id}"/>`).toString("base64")}`,
    attributes: [{trait_type: "Ink", value: t.ink}],
  });
  return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

/**
 * Fake PublicClient over a fixed token map. Counts multicall and readContract invocations so
 * tests can assert which path loadSite took and how it chunked.
 */
function makeClient(opts: {
  minted: bigint;
  live: Map<bigint, FakeToken>;
  multicall3: boolean;
  supply?: bigint;
  attribution?: boolean;
  legacyFee?: boolean;
  headBlock?: bigint;
  ownerToken?: bigint | null;
  /** A non-revert failure on the ownerToken read, distinct from a decoded NoOwnerToken revert. */
  ownerTokenReadFails?: boolean;
  mintStart?: bigint;
  genesisHash?: `0x${string}`;
}) {
  const counts = {
    multicall: 0,
    readContract: 0,
    /** Highest number of multicalls in flight at once. 1 proves the chunks are paced, not burst. */
    peakConcurrentMulticalls: 0,
    calls: new Map<string, number>(),
  };
  let inFlight = 0;

  function resolve(functionName: string, args: readonly unknown[] | undefined): unknown {
    counts.calls.set(functionName, (counts.calls.get(functionName) ?? 0) + 1);
    const id = (args?.[0] ?? 0n) as bigint;
    const t = opts.live.get(id);
    switch (functionName) {
      case "totalMinted":
        return opts.minted;
      case "redeemableBacking":
        return 42n;
      case "totalSupply":
        return opts.supply ?? BigInt(opts.live.size);
      case "artist":
        if (opts.attribution === false) throw new Error("function selector was not recognized");
        return ARTIST;
      case "artistReleaseHash":
        if (opts.attribution === false) throw new Error("function selector was not recognized");
        return RELEASE_HASH;
      case "ownerToken":
        if (opts.ownerToken === null) throw noOwnerTokenRevert();
        if (opts.ownerToken === undefined && opts.ownerTokenReadFails) {
          throw new Error("RPC unavailable");
        }
        return opts.ownerToken ?? 0n;
      case "mintFee":
        if (opts.legacyFee) throw new Error("function selector was not recognized");
        return 1_000_000_000_000_000n;
      case "mintFeeFor":
        return (id as bigint) / 100n;
      case "mintStart":
        return opts.mintStart ?? 0n;
      case "ownerOf":
        if (!t) throw new Error("ERC721NonexistentToken");
        return t.owner ?? OWNER;
      case "backingOf":
        return t!.backing;
      case "seedOf":
        return t!.seed;
      case "isBlackShape":
        return t!.black;
      case "tokenURI":
        return tokenUriFor(id, t!);
      case "composeDepth":
        return t!.composeDepth;
      default:
        throw new Error(`unexpected read: ${functionName}`);
    }
  }

  const client = {
    chain: opts.multicall3 ? {contracts: {multicall3: {address: MULTICALL3}}} : undefined,
    async getCode({address}: {address: `0x${string}`}) {
      return address === MULTICALL3 && opts.multicall3 ? "0x600180" : undefined;
    },
    async getBlockNumber() {
      return opts.headBlock ?? 100n;
    },
    async getBlock() {
      return {hash: opts.genesisHash ?? GENESIS_HASH};
    },
    async readContract({functionName, args}: {functionName: string; args?: readonly unknown[]}) {
      counts.readContract++;
      return resolve(functionName, args);
    },
    async multicall({
      contracts,
    }: {
      contracts: {functionName: string; args?: readonly unknown[]}[];
    }) {
      counts.multicall++;
      inFlight++;
      counts.peakConcurrentMulticalls = Math.max(counts.peakConcurrentMulticalls, inFlight);
      // A real multicall resolves on a later tick; yielding here lets a caller that fires chunks
      // in parallel show up as concurrency rather than as one-at-a-time.
      await Promise.resolve();
      inFlight--;
      return contracts.map((c) => {
        try {
          return {status: "success", result: resolve(c.functionName, c.args)};
        } catch (error) {
          return {status: "failure", error};
        }
      });
    },
  };
  return {client: client as unknown as PublicClient, counts};
}

function indexerFixture(opts: {block: number; tokens: unknown[]; status?: number}): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        data: {
          _meta: {status: {chain: {id: 31337, block: {number: opts.block}}}},
          tokens: {
            items: opts.tokens,
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
      }),
      {status: opts.status ?? 200, headers: {"content-type": "application/json"}},
    )) as typeof fetch;
}

function pagedIndexerFixture(
  pages: {tokens: unknown[]; hasNextPage: boolean; endCursor: string | null}[],
): typeof fetch {
  let page = 0;
  return (async () => {
    const current = pages[Math.min(page++, pages.length - 1)]!;
    return new Response(
      JSON.stringify({
        data: {
          _meta: {status: {chain: {id: 31337, block: {number: 100}}}},
          tokens: {
            items: current.tokens,
            pageInfo: {
              hasNextPage: current.hasNextPage,
              endCursor: current.endCursor,
            },
          },
        },
      }),
      {status: 200, headers: {"content-type": "application/json"}},
    );
  }) as typeof fetch;
}

/** One indexer `token` row, as the GraphQL boundary serializes it. The defaults describe an
 *  ordinary smallest-denomination mint; overrides describe everything else. */
function indexedToken(id: bigint, overrides: Record<string, unknown> = {}) {
  return {
    id: id.toString(),
    seed: `0x${"0".repeat(63)}7`,
    denomIndex: 0,
    backingWei: DENOMINATIONS[0].wei.toString(),
    originCount: 1,
    composeDepth: 0,
    inkGene: 0,
    modules: null,
    isBlack: false,
    owner: OWNER,
    splitFromDenom: null,
    splitOriginDenom: null,
    ...overrides,
  };
}

const NORMAL: FakeToken = {
  backing: DENOMINATIONS[0].wei,
  seed: `0x${"0".repeat(63)}7`,
  black: false,
  composeDepth: 0n,
  ink: GENE_NAMES[0],
};

test("loadSite: multicall path chunks ids and reads per-token fields for live ids only", async () => {
  const live = new Map<bigint, FakeToken>([
    [2n, NORMAL],
    [5n, {...NORMAL, backing: 0n, black: true}],
    [1200n, {...NORMAL, backing: DENOMINATIONS[8].wei, seed: `0x${"0".repeat(63)}9`, composeDepth: 3n}],
  ]);
  const {client, counts} = makeClient({minted: 1203n, live, multicall3: true});

  const site = await loadSite(client, dep);

  assert.deepEqual(
    site.tokens.map((t) => t.id),
    [1200n, 5n, 2n], // newest first, including the Black Shape
  );
  const apex = site.tokens[0];
  assert.equal(apex.owner, OWNER);
  assert.equal(apex.backing, DENOMINATIONS[8].wei);
  assert.equal(apex.di, 8);
  assert.equal(apex.seed, 9n);
  assert.equal(apex.composeDepth, 3);
  assert.equal(apex.meta.name, "Shape 1200");
  assert.ok(apex.image.startsWith("data:image/svg+xml;base64,"));
  assert.equal(apex.inkGene, 0);
  const black = site.tokens.find((token) => token.id === 5n)!;
  assert.equal(black.di, -1);
  assert.equal(black.backing, 0n);
  assert.deepEqual(filterGalleryTokens(site.tokens, BLACK_FILTER).map((token) => token.id), [5n]);
  assert.equal(site.reserve, 42n);
  assert.equal(site.supply, 3n);
  assert.equal(site.fees.length, DENOMINATIONS.length);
  assert.ok(site.fees.every((fee) => fee === 1_000_000_000_000_000n));
  assert.equal(site.artist, ARTIST);
  assert.equal(site.artistAttested, true);
  assert.equal(site.artistReleaseHash, RELEASE_HASH);
  assert.equal(site.ownerToken, 0n);
  assert.equal(site.mintStart, 0n);

  // 1203 ownerOf calls in 500-call chunks = 3 multicalls, plus 1 for the per-token fields.
  assert.equal(counts.multicall, 4);
  // Chunks are paced, not fired together: a burst is what public gateways answer with HTTP 429.
  assert.equal(counts.peakConcurrentMulticalls, 1);
  // Header, the single flat-fee read, ownerToken, and mintStart go one-by-one.
  assert.equal(counts.readContract, 8);
});

test("loadSite: falls back to single reads when the chain has no Multicall3", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client, counts} = makeClient({minted: 3n, live, multicall3: false});

  const site = await loadSite(client, dep);

  assert.deepEqual(
    site.tokens.map((t) => t.id),
    [1n],
  );
  assert.equal(counts.multicall, 0);
  // Header reads (including ownerToken and mintStart), then 3 ownerOf + 5 per-token fields.
  assert.equal(counts.readContract, 8 + 3 + 5);
});

test("loadSite: incremental rescan rereads only new ids, known live ids, and their fields when needed", async () => {
  const live = new Map<bigint, FakeToken>([
    [0n, NORMAL], // stays live with the same owner and fields
    [1n, NORMAL], // will burn before the second load
  ]);
  const opts = {minted: 2n, live, multicall3: true};
  const {client, counts} = makeClient(opts);

  const first = await loadSite(client, dep);
  assert.deepEqual(first.tokens.map((t) => t.id), [1n, 0n]);
  assert.equal(first.scannedMinted, 2n);

  live.delete(1n); // burned
  live.set(2n, NORMAL); // newly minted
  opts.minted = 3n;
  counts.calls.clear();

  const second = await loadSite(client, dep, {previous: first});

  assert.deepEqual(second.tokens.map((t) => t.id), [2n, 0n]); // 1 dropped out, burned
  assert.equal(second.scannedMinted, 3n);
  // ownerOf: the one new id (2) plus every previously-live id (0 and 1), not a 0..2 rescan.
  assert.equal(counts.calls.get("ownerOf"), 3);
  // Per-token fields: only the newly-live id 2. Id 0's cached fields (unchanged owner, not
  // dirty) are reused untouched.
  assert.equal(counts.calls.get("tokenURI"), 1);
  assert.equal(counts.calls.get("backingOf"), 1);
});

test("loadSite: incremental rescan rereads a dirty id even when its owner is unchanged", async () => {
  const live = new Map<bigint, FakeToken>([[0n, NORMAL]]);
  const opts = {minted: 1n, live, multicall3: true};
  const {client, counts} = makeClient(opts);

  const first = await loadSite(client, dep);
  assert.equal(first.tokens[0]!.composeDepth, 0);

  // Same owner, but the on-chain state changed (e.g. a self-compose) in a way ownerOf can't see.
  live.set(0n, {...NORMAL, composeDepth: 1n});
  counts.calls.clear();

  const notDirty = await loadSite(client, dep, {previous: first});
  assert.equal(notDirty.tokens[0]!.composeDepth, 0); // stale cache, correctly reused
  assert.equal(counts.calls.get("tokenURI"), undefined);

  const dirtyResult = await loadSite(client, dep, {previous: first, dirtyIds: [0n]});
  assert.equal(dirtyResult.tokens[0]!.composeDepth, 1); // dirty id forced a fresh read
  assert.equal(counts.calls.get("tokenURI"), 1);
});

test("loadSite: incremental rescan rereads fields when a known id's owner changed", async () => {
  const live = new Map<bigint, FakeToken>([[0n, NORMAL]]);
  const opts = {minted: 1n, live, multicall3: true};
  const {client, counts} = makeClient(opts);

  const first = await loadSite(client, dep);
  assert.equal(first.tokens[0]!.owner, OWNER);

  live.set(0n, {...NORMAL, owner: ARTIST});
  counts.calls.clear();

  const second = await loadSite(client, dep, {previous: first});
  assert.equal(second.tokens[0]!.owner, ARTIST);
  assert.equal(counts.calls.get("tokenURI"), 1); // owner mismatch alone triggers a reread
});

test("loadSite: incremental rescan with no previous snapshot matches a full first-load scan", async () => {
  const live = new Map<bigint, FakeToken>([[2n, NORMAL], [5n, {...NORMAL, black: true}]]);
  const {client: clientA, counts: countsA} = makeClient({minted: 6n, live, multicall3: true});
  const {client: clientB, counts: countsB} = makeClient({minted: 6n, live, multicall3: true});

  const plain = await loadSite(clientA, dep);
  const explicit = await loadSite(clientB, dep, {previous: null});

  assert.deepEqual(plain.tokens.map((t) => t.id), explicit.tokens.map((t) => t.id));
  assert.equal(countsA.calls.get("ownerOf"), countsB.calls.get("ownerOf"));
  assert.equal(countsA.calls.get("tokenURI"), countsB.calls.get("tokenURI"));
});

test("loadSite: a chain reset (smaller totalMinted) is detected and falls back to a full scan", async () => {
  const firstLive = new Map<bigint, FakeToken>([
    [0n, NORMAL],
    [1n, NORMAL],
    [2n, NORMAL],
    [3n, NORMAL],
    [4n, NORMAL],
  ]);
  const {client: firstClient} = makeClient({minted: 5n, live: firstLive, multicall3: true});
  const first = await loadSite(firstClient, dep);
  assert.equal(first.scannedMinted, 5n);

  // The chain came back from block 0: fewer tokens overall, and id 0 has a different seed even
  // though the id itself still exists.
  const resetLive = new Map<bigint, FakeToken>([
    [0n, {...NORMAL, seed: `0x${"0".repeat(63)}5`}],
    [1n, NORMAL],
  ]);
  const {client: resetClient, counts} = makeClient({minted: 2n, live: resetLive, multicall3: true});

  const second = await loadSite(resetClient, dep, {previous: first});

  assert.equal(second.scannedMinted, 2n);
  assert.deepEqual(second.tokens.map((t) => t.id).sort(), [0n, 1n]);
  assert.equal(second.tokens.find((t) => t.id === 0n)!.seed, 5n); // reread, not the stale cache
  // Full scan: only the 2 ids on the new chain, not new-ids-since-5 plus the 5 previously live.
  assert.equal(counts.calls.get("ownerOf"), 2);
});

test("loadSite: a changed deployment address is detected and falls back to a full scan", async () => {
  const live = new Map<bigint, FakeToken>([[0n, NORMAL], [1n, NORMAL]]);
  const {client: firstClient} = makeClient({minted: 2n, live, multicall3: true});
  const first = await loadSite(firstClient, dep);

  const otherDep = {...dep, shapes: "0x0000000000000000000000000000000000beef" as `0x${string}`};
  const otherLive = new Map<bigint, FakeToken>([
    [0n, {...NORMAL, seed: `0x${"0".repeat(63)}6`}],
    [1n, NORMAL],
    [2n, NORMAL],
  ]);
  const {client: otherClient, counts} = makeClient({minted: 3n, live: otherLive, multicall3: true});

  const second = await loadSite(otherClient, otherDep, {previous: first});

  assert.equal(second.tokens.find((t) => t.id === 0n)!.seed, 6n); // reread, not the stale cache
  // Full scan: all 3 ids on the new deployment, not 1 new id plus the 2 previously live.
  assert.equal(counts.calls.get("ownerOf"), 3);
});

test("loadSite: a differing genesis block hash (same chainId/address) falls back to a full scan", async () => {
  const live = new Map<bigint, FakeToken>([[0n, NORMAL], [1n, NORMAL]]);
  const {client: firstClient} = makeClient({minted: 2n, live, multicall3: true});
  const first = await loadSite(firstClient, dep);

  // Same chainId and contract address, but a reset chain: totalMinted happens to be at least as
  // large as before, so scannedMinted/chainId/shapes all match; only the genesis hash differs.
  const resetLive = new Map<bigint, FakeToken>([
    [0n, {...NORMAL, seed: `0x${"0".repeat(63)}7`}],
    [1n, NORMAL],
  ]);
  const {client: resetClient, counts} = makeClient({
    minted: 2n,
    live: resetLive,
    multicall3: true,
    genesisHash: `0x${"bb".repeat(32)}` as `0x${string}`,
  });

  const second = await loadSite(resetClient, dep, {previous: first});

  assert.equal(second.tokens.find((t) => t.id === 0n)!.seed, 7n); // reread, not the stale cache
  assert.equal(counts.calls.get("ownerOf"), 2); // full scan, not an incremental no-op
});

test("loadSite: superseded percentage-fee Sepolia remains readable until redeployment", async () => {
  const {client} = makeClient({
    minted: 0n,
    live: new Map(),
    multicall3: false,
    legacyFee: true,
  });

  const site = await loadSite(client, dep);

  assert.deepEqual(
    site.fees,
    DENOMINATIONS.map((denomination) => denomination.wei / 100n),
  );
});

test("loadSite: pre-attribution deployments still load", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const legacyDep = {...dep, artist: undefined};
  const {client} = makeClient({
    minted: 2n,
    live,
    multicall3: false,
    attribution: false,
  });

  const site = await loadSite(client, legacyDep);

  assert.deepEqual(site.tokens.map((t) => t.id), [1n]);
  assert.equal(site.artist, null);
  assert.equal(site.artistReleaseHash, null);
  assert.equal(site.artistAttested, false);
});

test("loadSite: a NoOwnerToken revert reads as no collection owner", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true, ownerToken: null});

  const site = await loadSite(client, dep);

  assert.equal(site.ownerToken, null);
});

test("loadSite: a non-revert ownerToken failure rejects the load instead of hiding as null", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true, ownerTokenReadFails: true});

  await assert.rejects(loadSite(client, dep), /RPC unavailable/);
});

test("loadSite: a fresh indexer supplies every token field with no per-token chain read", async () => {
  const live = new Map<bigint, FakeToken>();
  const {client, counts} = makeClient({minted: 1203n, live, multicall3: true, headBlock: 100n, supply: 3n});
  const metrics: {source: string; indexerRequests: number}[] = [];

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: indexerFixture({
      block: 99,
      tokens: [
        indexedToken(1200n, {
          denomIndex: 8,
          backingWei: DENOMINATIONS[8].wei.toString(),
          seed: `0x${"0".repeat(63)}9`,
          composeDepth: 3,
          originCount: 4,
          inkGene: 2,
        }),
        indexedToken(5n, {isBlack: true, backingWei: "0"}),
        indexedToken(2n, {owner: ARTIST}),
      ],
    }),
    onMetrics: (metric) => metrics.push(metric),
  });

  assert.deepEqual(site.tokens.map((t) => t.id), [1200n, 5n, 2n]);
  const apex = site.tokens[0]!;
  assert.equal(apex.seed, 9n); // bytes32 rows are normalized to the bigint SiteToken promises
  assert.equal(apex.composeDepth, 3);
  assert.equal(apex.di, 8);
  assert.equal(apex.backing, DENOMINATIONS[8].wei);
  assert.equal(apex.originCount, 4);
  assert.equal(apex.inkGene, 2);
  assert.equal(apex.owner, OWNER);
  assert.equal(apex.meta.name, "Shape 1200");
  assert.ok(apex.image.startsWith("data:image/svg+xml;base64,"));
  assert.equal(
    apex.meta.attributes.find((a) => a.trait_type === "Ink")?.value,
    GENE_NAMES[2],
  );
  assert.equal(
    apex.meta.attributes.find((a) => a.trait_type === "Independent Origins")?.value,
    "4",
  );
  assert.equal(site.tokens[1]!.di, -1); // Black remains live and visible
  assert.equal(site.tokens[1]!.backing, 0n);
  assert.equal(site.tokens[2]!.owner, ARTIST);

  assert.equal(counts.multicall, 0); // no per-token chain read at all
  assert.equal(counts.readContract, 7); // live header, one flat-fee read, ownerToken, mintStart
  assert.deepEqual(metrics, [{source: "indexer", indexerRequests: 1}]);
});

test("loadSite: the owner token's own name and description come from the header's ownerToken", async () => {
  const {client} = makeClient({
    minted: 3n,
    live: new Map(),
    multicall3: true,
    headBlock: 100n,
    supply: 2n,
    ownerToken: 2n,
  });

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: indexerFixture({block: 100, tokens: [indexedToken(2n), indexedToken(1n)]}),
  });

  const ownerToken = site.tokens.find((t) => t.id === 2n)!;
  assert.equal(ownerToken.meta.name, "Shape 2, Contract Owner");
  assert.ok(ownerToken.meta.attributes.some((a) => a.trait_type === undefined && a.value === "Contract Owner"));
  const ordinary = site.tokens.find((t) => t.id === 1n)!;
  assert.equal(ordinary.meta.name, "Shape 1");
  assert.ok(!ordinary.meta.attributes.some((a) => a.value === "Contract Owner"));
});

test("loadSite: on the indexer path only the ids the wallet just acted on are read from the chain", async () => {
  // The indexer is one block behind on id 2: its row still shows the pre-compose state, and it
  // has not yet seen that id 5 burned.
  const live = new Map<bigint, FakeToken>([
    [2n, {...NORMAL, composeDepth: 5n, owner: ARTIST}],
  ]);
  const {client, counts} = makeClient({minted: 6n, live, multicall3: true, headBlock: 100n, supply: 2n});

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: indexerFixture({block: 99, tokens: [indexedToken(5n), indexedToken(2n)]}),
    dirtyIds: [2n, 5n],
  });

  assert.deepEqual(site.tokens.map((t) => t.id), [2n]); // 5 burned since the checkpoint
  assert.equal(site.tokens[0]!.composeDepth, 5); // the chain read won over the stale row
  assert.equal(site.tokens[0]!.owner, ARTIST);
  // One aggregate covering both dirty ids, and nothing for the rest of the gallery.
  assert.equal(counts.multicall, 1);
  assert.equal(counts.calls.get("ownerOf"), 2); // the two dirty ids, not the six minted ones
});

test("loadSite: an indexer row the renderer rejects falls back to the chain", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client, counts} = makeClient({minted: 2n, live, multicall3: true, headBlock: 100n});
  const metrics: {source: string; indexerRequests: number}[] = [];

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: indexerFixture({block: 100, tokens: [indexedToken(1n, {denomIndex: 99})]}),
    onMetrics: (metric) => metrics.push(metric),
  });

  assert.deepEqual(site.tokens.map((t) => t.id), [1n]);
  assert.deepEqual(metrics, [{source: "chain", indexerRequests: 0}]);
  assert.equal(counts.calls.get("tokenURI"), 1); // rebuilt from the chain, not the bad row
});

test("loadSite: dep.indexerUrl alone (no options override) drives the indexer path, as SiteApp calls it", async () => {
  // SiteApp.refresh calls loadSite(publicClient, dep) with no options object at all: the
  // deployment record fetched client-side is the only source of indexerUrl in production. A
  // fixture that only ever exercises options.indexerUrl would miss a regression that drops
  // indexerUrl before it reaches this call, or that fails on the "http://" scheme a local
  // dev indexer uses (deployment.local.json, gitignored, hand-edited to add indexerUrl since
  // no script currently writes it there).
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true, headBlock: 100n});
  const metrics: {source: string; indexerRequests: number}[] = [];
  const depWithIndexer: Deployment = {...dep, indexerUrl: "http://localhost:42069"};

  const site = await loadSite(client, depWithIndexer, {
    fetch: indexerFixture({block: 100, tokens: [indexedToken(1n)]}),
    onMetrics: (metric) => metrics.push(metric),
  });

  assert.deepEqual(site.tokens.map((t) => t.id), [1n]);
  assert.deepEqual(metrics, [{source: "indexer", indexerRequests: 1}]);
});

test("loadSite: stale or unhealthy indexer deterministically falls back to the chain", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  for (const fetcher of [
    indexerFixture({block: 97, tokens: [indexedToken(1n)]}), // 3 blocks behind a 100 head
    indexerFixture({block: 100, tokens: [], status: 503}),
  ]) {
    const {client, counts} = makeClient({minted: 3n, live, multicall3: true, headBlock: 100n});
    const metrics: {source: string; indexerRequests: number}[] = [];
    const site = await loadSite(client, dep, {
      indexerUrl: "http://indexer.test",
      fetch: fetcher,
      onMetrics: (metric) => metrics.push(metric),
    });

    assert.deepEqual(site.tokens.map((t) => t.id), [1n]);
    assert.equal(counts.multicall, 2); // 3 ownerOf calls, then one live-token field batch
    assert.deepEqual(metrics, [{source: "chain", indexerRequests: 0}]);
  }
});

test("loadSite: a stalled indexer is aborted and falls back to the chain", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true});
  let aborted = false;
  const stalled = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: stalled,
    indexerTimeoutMs: 5,
  });

  assert.equal(aborted, true);
  assert.deepEqual(site.tokens.map((token) => token.id), [1n]);
});

test("loadSite: oversized indexer pages fall back before accumulation", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true, supply: 1_000n});
  const oversized = Array.from({length: 501}, (_, id) => indexedToken(BigInt(id)));

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: pagedIndexerFixture([{tokens: oversized, hasNextPage: false, endCursor: null}]),
  });

  assert.deepEqual(site.tokens.map((token) => token.id), [1n]);
});

test("loadSite: repeated indexer cursors fall back instead of looping", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true, supply: 1_000n});
  const first = Array.from({length: 500}, (_, id) => indexedToken(BigInt(id)));
  const second = Array.from({length: 500}, (_, id) => indexedToken(BigInt(id + 500)));

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: pagedIndexerFixture([
      {tokens: first, hasNextPage: true, endCursor: "same"},
      {tokens: second, hasNextPage: true, endCursor: "same"},
    ]),
  });

  assert.deepEqual(site.tokens.map((token) => token.id), [1n]);
});

test("loadSite: oversized indexer response bodies fall back", async () => {
  const live = new Map<bigint, FakeToken>([[1n, NORMAL]]);
  const {client} = makeClient({minted: 2n, live, multicall3: true});
  const oversizedBody = (async () =>
    new Response("{}", {
      status: 200,
      headers: {"content-length": String(256 * 1024 + 1)},
    })) as typeof fetch;

  const site = await loadSite(client, dep, {
    indexerUrl: "http://indexer.test",
    fetch: oversizedBody,
  });

  assert.deepEqual(site.tokens.map((token) => token.id), [1n]);
});

test("seedFee: no data yet seeds from the deployment record", () => {
  assert.equal(seedFee({mintFeeWei: "500"}, null, 0), 500n);
});

test("seedFee: no data yet and no recorded fee is unknown, not zero", () => {
  assert.equal(seedFee({mintFeeWei: undefined}, null, 0), null);
  assert.equal(seedFee(undefined, null, 0), null);
});

test("seedFee: chain data overrides the seeded record value", () => {
  const data: Pick<SiteData, "fees"> = {fees: [1n, 2n, 3n]};
  assert.equal(seedFee({mintFeeWei: "500"}, data, 1), 2n);
});

test("seedMintStart: no data yet seeds from the deployment record, defaulting open", () => {
  assert.equal(seedMintStart({mintStart: "1000"}, null), 1000n);
  assert.equal(seedMintStart(undefined, null), 0n);
});

test("seedMintStart: chain data overrides the seeded record value", () => {
  const data: Pick<SiteData, "mintStart"> = {mintStart: 42n};
  assert.equal(seedMintStart({mintStart: "1000"}, data), 42n);
});

test("originsLabel counts mint origins and flags Complete", () => {
  const meta = (attrs: {trait_type: string; value: string}[]) => ({name: "", description: "", attributes: attrs});
  assert.equal(originsLabel({originCount: 1, meta: meta([])}), "1 origin");
  assert.equal(originsLabel({originCount: 6, meta: meta([{trait_type: "Complete", value: "false"}])}), "6 origins");
  assert.equal(
    originsLabel({originCount: 10_000, meta: meta([{trait_type: "Complete", value: "true"}])}),
    "10,000 origins, Complete",
  );
});

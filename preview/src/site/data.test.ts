import {test} from "node:test";
import assert from "node:assert/strict";
import type {PublicClient} from "viem";

import {loadSite} from "./data";
import {DENOMINATIONS, type Deployment} from "../chain/abi";
import {GENE_NAMES} from "../canonical/ink";

const SHAPES = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}`;
const OWNER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ARTIST = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const ATTRIBUTION = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const RELEASE_HASH = `0x${"44".repeat(32)}` as `0x${string}`;

const dep = {
  shapes: SHAPES,
  artist: ARTIST,
  artistAttribution: ATTRIBUTION,
  rpc: "http://localhost",
  chainId: 31337,
} as unknown as Deployment;

interface FakeToken {
  backing: bigint;
  seed: bigint;
  black: boolean;
  composeDepth: bigint;
  ink: string;
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
function makeClient(opts: {minted: bigint; live: Map<bigint, FakeToken>; multicall3: boolean}) {
  const counts = {multicall: 0, readContract: 0};

  function resolve(functionName: string, args: readonly unknown[] | undefined): unknown {
    const id = (args?.[0] ?? 0n) as bigint;
    const t = opts.live.get(id);
    switch (functionName) {
      case "totalMinted":
        return opts.minted;
      case "redeemableBacking":
        return 42n;
      case "totalSupply":
        return BigInt(opts.live.size);
      case "artist":
        return ARTIST;
      case "artistAttribution":
        return ATTRIBUTION;
      case "attested":
        return true;
      case "releaseHash":
        return RELEASE_HASH;
      case "mintFeeFor":
        return (id as bigint) / 100n; // arg is the denomination wei
      case "ownerOf":
        if (!t) throw new Error("ERC721NonexistentToken");
        return OWNER;
      case "backingOf":
        return t!.backing;
      case "seedOf":
        return t!.seed;
      case "isBlack":
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

const NORMAL: FakeToken = {
  backing: DENOMINATIONS[0].wei,
  seed: 7n,
  black: false,
  composeDepth: 0n,
  ink: GENE_NAMES[0],
};

test("loadSite: multicall path chunks ids and reads per-token fields for live ids only", async () => {
  const live = new Map<bigint, FakeToken>([
    [2n, NORMAL],
    [5n, {...NORMAL, black: true}],
    [1200n, {...NORMAL, backing: DENOMINATIONS[8].wei, seed: 9n, composeDepth: 3n}],
  ]);
  const {client, counts} = makeClient({minted: 1203n, live, multicall3: true});

  const site = await loadSite(client, dep);

  assert.deepEqual(
    site.tokens.map((t) => t.id),
    [1200n, 2n], // newest first, black id 5 skipped
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
  assert.equal(site.reserve, 42n);
  assert.equal(site.supply, 3n);
  assert.equal(site.fees.length, DENOMINATIONS.length);
  assert.equal(site.artist, ARTIST);
  assert.equal(site.artistAttribution, ATTRIBUTION);
  assert.equal(site.artistAttested, true);
  assert.equal(site.artistReleaseHash, RELEASE_HASH);

  // 1203 ownerOf calls in 500-call chunks = 3 multicalls, plus 1 for the per-token fields.
  assert.equal(counts.multicall, 4);
  // Header, attribution, and fee reads go one-by-one.
  assert.equal(counts.readContract, 7 + DENOMINATIONS.length);
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
  // Header + attribution reads, then 3 ownerOf + 5 per-token fields.
  assert.equal(counts.readContract, 7 + DENOMINATIONS.length + 3 + 5);
});

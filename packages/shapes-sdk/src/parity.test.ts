/**
 * Live parity check: renders ten mainnet tokens from the deployed indexer's own rows and
 * compares the result byte-for-byte against `Shapes.svg(tokenId)` on the live mainnet contract.
 * This is the guarantee the whole SHAPES-API packet rests on ("Rendering is pure computation
 * from the row, no RPC" in the API request path) — if the indexer's stored row ever fails to
 * reproduce what the contract itself renders, this is the test that catches it.
 *
 * Network-dependent by nature (a live indexer and a live RPC), unlike every other test in this
 * package. Skips rather than fails when either is unreachable, so a sandboxed or offline run of
 * `npm test` does not block on infrastructure this package does not control.
 *
 * `SHAPES_PARITY_INDEXER_URL` and `SHAPES_PARITY_RPC_URL` override the indexer and RPC endpoint,
 * for running this against Sepolia instead (pair with `deployments/11155111.json`'s `shapes`
 * address by also passing `SHAPES_PARITY_CHAIN_ID=11155111`). `SHAPES_INDEXER_TOKEN` or
 * `INDEXER_TOKEN` authenticates the query if the target indexer's `/graphql` is bearer-gated.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, http } from "viem";
import { renderShapeSvg } from "./render/fromRow.ts";
import { deploymentFor } from "./deployments.ts";

const DEFAULT_CHAIN_ID = 1;
const DEFAULT_INDEXER_URL = "https://shapes-indexer-mainnet.fly.dev";
const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";

const CHAIN_ID = Number(process.env.SHAPES_PARITY_CHAIN_ID ?? DEFAULT_CHAIN_ID);
const INDEXER_URL = (process.env.SHAPES_PARITY_INDEXER_URL ?? DEFAULT_INDEXER_URL).replace(/\/$/, "");
const RPC_URL = process.env.SHAPES_PARITY_RPC_URL ?? DEFAULT_RPC_URL;

const SAMPLE_SIZE = 10;
const FETCH_TIMEOUT_MS = 10_000;

const SVG_ABI = [
  {
    type: "function",
    name: "svg",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
] as const;

interface IndexedTokenRow {
  id: string;
  seed: `0x${string}`;
  denomIndex: number;
  inkGene: number;
  modules: `0x${string}` | null;
  isBlack: boolean;
}

// The deployed indexer's /graphql sits behind an optional bearer gate (indexer/README.md
// "Access"); the mainnet app carries a token as a Fly secret. Neither env var is required — an
// unset one just means an unauthenticated request, which the deployed app answers with 401 and
// this test turns into a skip, the same as any other unreachable-infrastructure case.
const INDEXER_TOKEN = process.env.SHAPES_INDEXER_TOKEN ?? process.env.INDEXER_TOKEN;

async function fetchIndexedTokens(): Promise<IndexedTokenRow[]> {
  const query = `query { tokens(where: { live: true }, orderBy: "id", limit: ${SAMPLE_SIZE}) {
    items { id seed denomIndex inkGene modules isBlack } } }`;
  const res = await fetch(`${INDEXER_URL}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(INDEXER_TOKEN ? { authorization: `Bearer ${INDEXER_TOKEN}` } : {}),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`indexer GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { tokens?: { items: IndexedTokenRow[] } }; errors?: unknown };
  if (!body.data?.tokens) throw new Error(`indexer GraphQL: ${JSON.stringify(body.errors ?? body)}`);
  return body.data.tokens.items;
}

test("ten indexed tokens render byte-identical to Shapes.svg on chain", async (t) => {
  let rows: IndexedTokenRow[];
  try {
    rows = await fetchIndexedTokens();
  } catch (err) {
    t.skip(`indexer at ${INDEXER_URL} unreachable from this environment: ${(err as Error).message}`);
    return;
  }
  if (rows.length === 0) {
    t.skip(`indexer at ${INDEXER_URL} returned no live tokens`);
    return;
  }

  const client = createPublicClient({ transport: http(RPC_URL, { timeout: FETCH_TIMEOUT_MS }) });
  try {
    await client.getChainId();
  } catch (err) {
    t.skip(`RPC at ${RPC_URL} unreachable from this environment: ${(err as Error).message}`);
    return;
  }

  const shapes = deploymentFor(CHAIN_ID).shapes;

  for (const row of rows) {
    const expected = await client.readContract({
      address: shapes,
      abi: SVG_ABI,
      functionName: "svg",
      args: [BigInt(row.id)],
    });
    const actual = renderShapeSvg({
      tokenId: BigInt(row.id),
      seed: row.seed,
      denomIndex: row.denomIndex,
      inkGene: row.inkGene,
      modules: row.modules,
      isBlack: row.isBlack,
    });
    assert.equal(actual, expected, `token ${row.id} diverges from the indexed row`);
  }
});

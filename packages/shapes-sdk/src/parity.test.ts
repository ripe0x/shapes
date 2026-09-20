/**
 * Live parity check: renders ten Sepolia tokens from the deployed indexer's own rows and
 * compares the result byte-for-byte against `Shapes.svg(tokenId)` on the pinned Sepolia
 * contract. This is the guarantee the whole SHAPES-API packet rests on ("Rendering is pure
 * computation from the row, no RPC" in the API request path) — if the indexer's stored row ever
 * fails to reproduce what the contract itself renders, this is the test that catches it.
 *
 * Network-dependent by nature (a live indexer and a live RPC), unlike every other test in this
 * package. Skips rather than fails when either is unreachable, so a sandboxed or offline run of
 * `npm test` does not block on infrastructure this package does not control.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, http } from "viem";
import { renderShapeSvg } from "./render/fromRow.ts";
import { deploymentFor } from "./deployments.ts";

const SEPOLIA_CHAIN_ID = 11155111;
const SAMPLE_SIZE = 10;
const FETCH_TIMEOUT_MS = 10_000;

// gateway.tenderly.co serves both recent and archive Sepolia state with no key; publicnode is a
// fallback for recent state (see the standing RPC guidance this repo follows).
const RPC_CANDIDATES = [
  "https://gateway.tenderly.co/public/sepolia",
  "https://ethereum-sepolia-rpc.publicnode.com",
];

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

async function fetchIndexedTokens(indexerUrl: string): Promise<IndexedTokenRow[]> {
  const query = `query { tokens(where: { live: true }, orderBy: "id", limit: ${SAMPLE_SIZE}) {
    items { id seed denomIndex inkGene modules isBlack } } }`;
  const res = await fetch(`${indexerUrl.replace(/\/$/, "")}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`indexer GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { tokens?: { items: IndexedTokenRow[] } }; errors?: unknown };
  if (!body.data?.tokens) throw new Error(`indexer GraphQL: ${JSON.stringify(body.errors ?? body)}`);
  return body.data.tokens.items;
}

async function firstWorkingRpc(): Promise<string | null> {
  for (const url of RPC_CANDIDATES) {
    try {
      const client = createPublicClient({ transport: http(url, { timeout: FETCH_TIMEOUT_MS }) });
      await client.getChainId();
      return url;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

test("ten indexed Sepolia tokens render byte-identical to Shapes.svg on chain", async (t) => {
  const indexerUrl = deploymentFor(SEPOLIA_CHAIN_ID).indexerUrl;
  if (!indexerUrl) {
    t.skip("no indexerUrl recorded for Sepolia in deployments/11155111.json");
    return;
  }

  let rows: IndexedTokenRow[];
  try {
    rows = await fetchIndexedTokens(indexerUrl);
  } catch (err) {
    t.skip(`Sepolia indexer unreachable from this environment: ${(err as Error).message}`);
    return;
  }
  if (rows.length === 0) {
    t.skip("Sepolia indexer returned no live tokens");
    return;
  }

  const rpcUrl = await firstWorkingRpc();
  if (!rpcUrl) {
    t.skip("no Sepolia RPC reachable from this environment");
    return;
  }

  const shapes = deploymentFor(SEPOLIA_CHAIN_ID).shapes;
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: FETCH_TIMEOUT_MS }) });

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

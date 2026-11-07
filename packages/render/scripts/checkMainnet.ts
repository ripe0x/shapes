/**
 * Live parity against Ethereum mainnet. Read-only; sends no transactions.
 *
 *   npm run check:mainnet --workspace shapes-render
 *
 * 1. Every live Shape: `renderShape` / `renderSampledShape` must equal `Shapes.svg(tokenId)`.
 * 2. Every `ShapeMinted` event: `inkGeneAtMint(seed, amountWei)` must equal the `InkGene` event
 *    the same mint emitted.
 * 3. Every live Pack: `packTokenURI` must equal `Packs.tokenURI(packId)`.
 * 4. Every fan size, 0 to 12 cards: `renderPack` must equal the live Packs renderer's `image`.
 *
 * `RPC_URL` overrides the default endpoint. Exits 1 on any mismatch.
 */

import { createPublicClient, http, parseAbi, parseAbiItem, hexToBytes, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { renderShape } from "../src/render";
import { renderSampledShape } from "../src/sampling";
import { inkGeneAtMint } from "../src/ink";
import { packTokenURI, renderPack, type PackCard } from "../src/pack";
import { CANONICAL } from "../src/params";

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.gateway.tenderly.co";
const SHAPES = "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0";
const PACKS = "0xBa48517Cb5Fa86430582898FD07B7E9D80cD1815";
// Shapes deployment block, from deployments/1.json.
const SHAPES_FROM_BLOCK = 25_898_721n;
const LOG_CHUNK = 50_000n;

const SHAPE_STATE =
  "(bytes32 seed, uint8 denominationIndex, uint32 originCount, uint8 inkGene, bool isBlack, uint8 formation, uint256 faceValueWei, uint256 redeemableValueWei, bytes modules)";
const shapesAbi = parseAbi([
  "function totalMinted() view returns (uint256)",
  "function exists(uint256) view returns (bool)",
  `function shapeState(uint256) view returns (${SHAPE_STATE})`,
  "function svg(uint256) view returns (string)",
  "function unit() view returns (uint256)",
  "function denominationCount() view returns (uint8)",
  "function denominationAt(uint8) view returns (uint256)",
]);
const packsAbi = parseAbi([
  "function totalMinted() view returns (uint256)",
  "function exists(uint256) view returns (bool)",
  "function packState(uint256) view returns ((uint256[] shapeIds, uint32[] counts, uint256 valueWei, uint256 mintedCount, address creator))",
  "function previewCardLimit() view returns (uint256)",
  "function tokenNamePrefix() view returns (string)",
  "function description() view returns (string)",
  "function tokenURI(uint256) view returns (string)",
  "function renderer() view returns (address)",
]);
const packRendererAbi = parseAbi([
  "struct ShapeState { bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bool isBlack; uint8 formation; uint256 faceValueWei; uint256 redeemableValueWei; bytes modules; }",
  "struct PackRenderInput { uint256 packId; uint256 shapeCount; uint256 valueWei; uint256 unitWei; uint32[] counts; uint256[] denominations; uint256 mintedCount; address creator; ShapeState[] topCards; string tokenNamePrefix; string description; }",
  "function image(PackRenderInput input) view returns (string)",
]);
const shapeMinted = parseAbiItem(
  "event ShapeMinted(uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount)",
);
const inkGeneEvent = parseAbiItem("event InkGene(uint256 indexed tokenId, uint8 gene)");

// Public gateways rate-limit bursts: concurrent reads share one multicall, and limit errors retry.
const client = createPublicClient({
  chain: mainnet,
  batch: { multicall: true },
  transport: http(RPC_URL, { retryCount: 8, retryDelay: 1_000 }),
});
let failures = 0;

function fail(what: string, expected: string, actual: string): void {
  failures++;
  let i = 0;
  while (i < expected.length && expected[i] === actual[i]) i++;
  console.error(`MISMATCH ${what} at char ${i}`);
  console.error(`  chain: ...${expected.slice(Math.max(0, i - 40), i + 80)}`);
  console.error(`  ts:    ...${actual.slice(Math.max(0, i - 40), i + 80)}`);
}

/** Runs `fn` over `items`, `width` at a time, keeping RPC load polite. */
async function inChunks<T, R>(items: readonly T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) out.push(...(await Promise.all(items.slice(i, i + width).map(fn))));
  return out;
}

async function liveIds(address: Hex, abi: typeof shapesAbi | typeof packsAbi, first: bigint, end: bigint) {
  const ids: bigint[] = [];
  for (let id = first; id < end; id++) ids.push(id);
  const live = await inChunks(ids, 16, (id) =>
    client.readContract({ address, abi: abi as typeof shapesAbi, functionName: "exists", args: [id] }),
  );
  return ids.filter((_, i) => live[i]);
}

function cardOf(s: { seed: Hex; isBlack: boolean; inkGene: number; faceValueWei: bigint; modules: Hex }): PackCard {
  return { seed: BigInt(s.seed), isBlack: s.isBlack, inkGene: s.inkGene, faceValueWei: s.faceValueWei, modules: hexToBytes(s.modules) };
}

const shapeState = (id: bigint) =>
  client.readContract({ address: SHAPES, abi: shapesAbi, functionName: "shapeState", args: [id] });

async function checkShapes(): Promise<bigint[]> {
  const totalMinted = await client.readContract({ address: SHAPES, abi: shapesAbi, functionName: "totalMinted" });
  const ids = await liveIds(SHAPES, shapesAbi, 0n, totalMinted);
  let sampled = 0;
  await inChunks(ids, 4, async (id) => {
    const [s, chainSvg] = await Promise.all([
      shapeState(id),
      client.readContract({ address: SHAPES, abi: shapesAbi, functionName: "svg", args: [id] }),
    ]);
    const modules = hexToBytes(s.modules);
    if (modules.length) sampled++;
    const ts = modules.length
      ? renderSampledShape(modules, s.denominationIndex, id, s.inkGene, CANONICAL, s.isBlack)
      : renderShape(BigInt(s.seed), s.faceValueWei, id, s.inkGene, CANONICAL, s.isBlack);
    if (ts !== chainSvg) fail(`Shapes.svg(${id})`, chainSvg, ts);
  });
  console.log(`svg: ${ids.length} live of ${totalMinted} minted (${sampled} sampled) checked`);
  return ids;
}

async function getLogsChunked<E extends typeof shapeMinted | typeof inkGeneEvent>(event: E, toBlock: bigint) {
  const logs = [];
  for (let from = SHAPES_FROM_BLOCK; from <= toBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < toBlock ? from + LOG_CHUNK - 1n : toBlock;
    logs.push(...(await client.getLogs({ address: SHAPES, event, fromBlock: from, toBlock: to, strict: true })));
  }
  return logs;
}

async function checkMintGenes(): Promise<void> {
  const head = await client.getBlockNumber();
  const [mints, genes] = await Promise.all([getLogsChunked(shapeMinted, head), getLogsChunked(inkGeneEvent, head)]);
  // Mint emits InkGene right after ShapeMinted, in the same transaction, for the same token.
  const geneAt = new Map(genes.map((g) => [`${g.transactionHash}:${g.args.tokenId}`, g.args.gene]));
  for (const m of mints) {
    const { tokenId, amountWei, seed } = m.args;
    const expected = geneAt.get(`${m.transactionHash}:${tokenId}`);
    const actual = inkGeneAtMint(seed, amountWei);
    if (expected !== actual) fail(`inkGeneAtMint for token ${tokenId}`, String(expected), String(actual));
  }
  console.log(`ink gene at mint: ${mints.length} ShapeMinted events checked`);
}

async function checkPacks(): Promise<void> {
  const read = <F extends "totalMinted" | "previewCardLimit" | "tokenNamePrefix" | "description">(functionName: F) =>
    client.readContract({ address: PACKS, abi: packsAbi, functionName });
  const [totalMinted, limit, tokenNamePrefix, description, unitWei, count] = await Promise.all([
    read("totalMinted"),
    read("previewCardLimit"),
    read("tokenNamePrefix"),
    read("description"),
    client.readContract({ address: SHAPES, abi: shapesAbi, functionName: "unit" }),
    client.readContract({ address: SHAPES, abi: shapesAbi, functionName: "denominationCount" }),
  ]);
  const denominations = await Promise.all(
    Array.from({ length: count }, (_, d) =>
      client.readContract({ address: SHAPES, abi: shapesAbi, functionName: "denominationAt", args: [d] }),
    ),
  );
  // Pack ids start at 1.
  const ids = await liveIds(PACKS, packsAbi, 1n, totalMinted + 1n);
  for (const packId of ids) {
    const [p, chainUri] = await Promise.all([
      client.readContract({ address: PACKS, abi: packsAbi, functionName: "packState", args: [packId] }),
      client.readContract({ address: PACKS, abi: packsAbi, functionName: "tokenURI", args: [packId] }),
    ]);
    const states = await inChunks(p.shapeIds, 8, shapeState);
    // ShapePacks._previewOrder: highest face value first, then lowest token id.
    const top = p.shapeIds
      .map((id, i) => ({ id, s: states[i] }))
      .sort((a, b) => (a.s.faceValueWei === b.s.faceValueWei ? (a.id < b.id ? -1 : 1) : a.s.faceValueWei > b.s.faceValueWei ? -1 : 1))
      .slice(0, Number(limit));
    const ts = packTokenURI({
      packId,
      shapeCount: BigInt(p.shapeIds.length),
      valueWei: p.valueWei,
      unitWei,
      counts: p.counts,
      denominations,
      mintedCount: p.mintedCount,
      creator: p.creator,
      topCards: top.map((t) => cardOf(t.s)),
      tokenNamePrefix,
      description,
    });
    if (ts !== chainUri) {
      const decode = (u: string) => Buffer.from(u.split(",")[1], "base64").toString("utf8");
      fail(`Packs.tokenURI(${packId})`, decode(chainUri), decode(ts));
    }
  }
  console.log(`packs: ${ids.length} live of ${totalMinted} minted checked`);
}

/** Live packs cover only some fan sizes, so feed the live renderer every size directly. */
async function checkPackFans(shapeIds: readonly bigint[]): Promise<void> {
  const renderer = await client.readContract({ address: PACKS, abi: packsAbi, functionName: "renderer" });
  const states = await inChunks(shapeIds, 8, shapeState);
  // Sampled faces first, so the larger fans draw both render paths.
  const order = states.map((_, i) => i).sort((a, b) => Number(states[b].modules.length > 2) - Number(states[a].modules.length > 2));
  const cards = order.slice(0, 12).map((i) => states[i]);
  for (let n = 0; n <= cards.length; n++) {
    const top = cards.slice(0, n);
    const chainSvg = await client.readContract({
      address: renderer,
      abi: packRendererAbi,
      functionName: "image",
      args: [{ packId: 0n, shapeCount: 0n, valueWei: 0n, unitWei: 1n, counts: [], denominations: [], mintedCount: 0n,
        creator: "0x0000000000000000000000000000000000000000", topCards: top, tokenNamePrefix: "", description: "" }],
    });
    const ts = renderPack(top.map(cardOf));
    if (ts !== chainSvg) fail(`pack image with ${n} cards`, chainSvg, ts);
  }
  console.log(`pack fans: 0 to ${cards.length} cards checked against renderer ${renderer}`);
}

const shapeIds = await checkShapes();
await checkMintGenes();
await checkPacks();
await checkPackFans(shapeIds);
if (failures) {
  console.error(`${failures} mismatch(es)`);
  process.exit(1);
}
console.log("mainnet parity: all byte-identical");

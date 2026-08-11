/**
 * Generate the parity fixture corpus.
 *
 * The TypeScript canonical renderer is the specification; these fixtures are its output.
 * The Foundry suite renders the same (seed, amount, tokenId) triples through
 * src/ShapeRenderer.sol and asserts byte-identical strings.
 *
 *   npm run fixtures
 *
 * Written columnar rather than as an array of objects so Foundry can read whole columns
 * with vm.parseJsonStringArray, which is far cheaper than decoding 70 structs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  composeShape,
  moduleSequence,
  renderShape,
  tokenMetadataJson,
} from "../src/canonical/render";
import { fmt } from "../src/canonical/wad";
import { DENOMINATIONS, LABELS } from "../src/canonical/denominations";
import { CANONICAL, paramsEqualCanonical } from "../src/canonical/params";
import { productionSeed } from "../src/seeds";

if (!paramsEqualCanonical(CANONICAL)) {
  throw new Error("refusing to generate fixtures from non-canonical params");
}

const MAX_U256 = (1n << 256n) - 1n;
const UNIT = 10_000_000_000_000_000n; // 0.01 ETH

interface Case {
  seed: bigint;
  amountWei: bigint;
  tokenId: bigint;
  originCount: bigint;
  inverted: boolean;
  why: string;
}

const cases: Case[] = [];

// Six production seeds per denomination — the main corpus. The origin count is varied across
// the six samples to exercise Direct / Composed / Complete formations and the density formatter.
for (let di = 0; di < DENOMINATIONS.length; di++) {
  const units = DENOMINATIONS[di] / UNIT;
  const cap = (x: bigint) => (x < 1n ? 1n : x > units ? units : x);
  const pattern = [1n, units, cap(2n), cap(3n), units, cap(units - 1n)];
  for (let i = 0; i < 6; i++) {
    const tokenId = BigInt(di * 6 + i + 1);
    cases.push({
      seed: productionSeed(BigInt(di * 1000 + i)),
      amountWei: DENOMINATIONS[di],
      tokenId,
      originCount: pattern[i],
      inverted: false,
      why: `${LABELS[di]} ETH sample ${i}`,
    });
  }
}

// Edge cases that exercise the formatter, the stream and the id rendering. Where not otherwise
// interesting, originCount defaults to 1 (Direct) and inverted to false.
const edges: Case[] = [
  { seed: 0n, amountWei: DENOMINATIONS[0], tokenId: 1n, originCount: 1n, inverted: false, why: "seed zero, densest grid" },
  { seed: 0n, amountWei: DENOMINATIONS[8], tokenId: 1n, originCount: 1n, inverted: false, why: "seed zero, single module" },
  { seed: MAX_U256, amountWei: DENOMINATIONS[8], tokenId: 1n, originCount: 1n, inverted: false, why: "seed all ones" },
  { seed: MAX_U256, amountWei: DENOMINATIONS[0], tokenId: 1n, originCount: 1n, inverted: false, why: "seed all ones, 5x5" },
  {
    // low 32 bits zero, high bits set: proves only the low word reaches the stream
    seed: MAX_U256 ^ 0xffffffffn,
    amountWei: DENOMINATIONS[4],
    tokenId: 7n,
    originCount: 1n,
    inverted: false,
    why: "stream seed zero, high bits set",
  },
  { seed: 0xffffffffn, amountWei: DENOMINATIONS[4], tokenId: 7n, originCount: 1n, inverted: false, why: "stream seed max" },
  { seed: productionSeed(31337n), amountWei: DENOMINATIONS[7], tokenId: 999_999n, originCount: 1n, inverted: false, why: "long token id" },
  {
    seed: productionSeed(4242n),
    amountWei: DENOMINATIONS[3],
    tokenId: MAX_U256,
    originCount: 1n,
    inverted: false,
    why: "maximal token id string",
  },
  { seed: productionSeed(1n), amountWei: DENOMINATIONS[6], tokenId: 10n, originCount: 1n, inverted: false, why: "10 ETH, 2x2" },
  { seed: productionSeed(2n), amountWei: DENOMINATIONS[5], tokenId: 11n, originCount: 1n, inverted: false, why: "5 ETH, 2x3" },
  { seed: productionSeed(3n), amountWei: DENOMINATIONS[1], tokenId: 12n, originCount: 1n, inverted: false, why: "0.05 ETH, 4x5" },
  { seed: productionSeed(4n), amountWei: DENOMINATIONS[2], tokenId: 13n, originCount: 1n, inverted: false, why: "0.1 ETH, 4x4" },

  // Provenance: formation labels.
  { seed: productionSeed(5n), amountWei: DENOMINATIONS[4], tokenId: 14n, originCount: 100n, inverted: false, why: "Complete 1 ETH (100 origins)" },
  { seed: productionSeed(6n), amountWei: DENOMINATIONS[4], tokenId: 15n, originCount: 50n, inverted: false, why: "Composed 1 ETH (50 origins)" },
  { seed: productionSeed(7n), amountWei: DENOMINATIONS[1], tokenId: 16n, originCount: 5n, inverted: false, why: "Complete 0.05 (5 origins)" },

  // Provenance: density formatter branches (hundredths of a percent).
  { seed: productionSeed(8n), amountWei: DENOMINATIONS[8], tokenId: 17n, originCount: 1n, inverted: false, why: "density 0.01% (two decimals)" },
  { seed: productionSeed(9n), amountWei: DENOMINATIONS[8], tokenId: 18n, originCount: 7n, inverted: false, why: "density 0.07% (leading zero)" },
  { seed: productionSeed(10n), amountWei: DENOMINATIONS[8], tokenId: 19n, originCount: 12n, inverted: false, why: "density 0.12% (two decimals)" },
  { seed: productionSeed(11n), amountWei: DENOMINATIONS[8], tokenId: 20n, originCount: 25n, inverted: false, why: "density 0.25% (two decimals)" },
  { seed: productionSeed(12n), amountWei: DENOMINATIONS[5], tokenId: 21n, originCount: 1n, inverted: false, why: "density 0.2% (one decimal)" },
  { seed: productionSeed(13n), amountWei: DENOMINATIONS[5], tokenId: 22n, originCount: 3n, inverted: false, why: "density 0.6% (one decimal)" },

  // Black: apex Complete rendered inverted.
  { seed: productionSeed(14n), amountWei: DENOMINATIONS[8], tokenId: 23n, originCount: 10000n, inverted: true, why: "Black apex (inverted, 10000 origins)" },
  { seed: 0n, amountWei: DENOMINATIONS[0], tokenId: 24n, originCount: 1n, inverted: true, why: "inverted densest grid" },
];
cases.push(...edges);

const hex32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

const out = {
  _comment:
    "Generated by preview/scripts/genFixtures.ts from the canonical TypeScript renderer. " +
    "Do not hand-edit. Regenerate with `npm run fixtures` in preview/.",
  count: cases.length,
  why: cases.map((c) => c.why),
  tokenId: cases.map((c) => c.tokenId.toString()),
  seed: cases.map((c) => hex32(c.seed)),
  amountWei: cases.map((c) => c.amountWei.toString()),
  amountLabel: cases.map((c) => LABELS[composeShape(c.seed, c.amountWei).denomIndex] + " ETH"),
  cols: cases.map((c) => composeShape(c.seed, c.amountWei).cols.toString()),
  rows: cases.map((c) => composeShape(c.seed, c.amountWei).rows.toString()),
  cell: cases.map((c) => fmt(composeShape(c.seed, c.amountWei).cell)),
  fill: cases.map((c) => fmt(composeShape(c.seed, c.amountWei).fill)),
  wRatio: cases.map((c) => fmt(composeShape(c.seed, c.amountWei).wRatio)),
  target: cases.map((c) => fmt(composeShape(c.seed, c.amountWei).target)),
  modules: cases.map((c) => moduleSequence(composeShape(c.seed, c.amountWei))),
  originCount: cases.map((c) => c.originCount.toString()),
  inverted: cases.map((c) => (c.inverted ? "true" : "false")),
  svg: cases.map((c) => renderShape(c.seed, c.amountWei, c.tokenId, CANONICAL, c.inverted)), // tokenId unused: no type
  metadata: cases.map((c) => tokenMetadataJson(c.seed, c.amountWei, c.tokenId, c.originCount, c.inverted)),
};

const target = resolve(import.meta.dirname, "../../test/fixtures/fixtures.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");

const bytes = out.svg.reduce((a, s) => a + s.length, 0);
console.log(`wrote ${cases.length} fixtures to ${target}`);
console.log(`  svg bytes: min ${Math.min(...out.svg.map((s) => s.length))}, max ${Math.max(
  ...out.svg.map((s) => s.length),
)}, mean ${Math.round(bytes / cases.length)}`);

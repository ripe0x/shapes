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
import { DENOMINATIONS, LABELS, denominationIndex } from "../src/canonical/denominations";
import { CANONICAL, paramsEqualCanonical } from "../src/canonical/params";
import { productionSeed } from "../src/seeds";
import { splitChildSeed } from "../src/splitSeed";
import {
  GENE_COUNT,
  GENE_NAMES,
  GENE_PROBABILITY,
  geneAtCompose,
  geneAtMint,
  centerGene,
} from "../src/canonical/ink";

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
  /** Defaults to the gene a real mint of this seed at this denomination would draw. */
  gene?: number;
  /**
   * Reversible-compose stack depth, surfaced as the `Compose Depth` trait. Contract state, not
   * seed-derived, so it defaults to 0 (a token that has never been composed into).
   */
  composeDepth?: bigint;
}

/** The gene a real mint of `seed` at `amountWei`'s denomination draws, unless overridden. */
function geneOf(c: Case): number {
  return c.gene ?? geneAtMint(c.seed, denominationIndex(c.amountWei));
}

/** `composeDepth`, defaulting to 0 (never composed into). */
function depthOf(c: Case): bigint {
  return c.composeDepth ?? 0n;
}

/**
 * Scan production seeds `0, 1, 2, ...` for the first one that mints each gene in `wanted` at
 * `denomIndex`. Used to freeze a small, concrete vector table (impl spec §5 test 2) rather than
 * relying on a fuzzer to happen across every gene.
 */
function findMintVectors(
  denomIndex: number,
  wanted: readonly number[],
): {seed: bigint; denomIndex: number; gene: number}[] {
  const found = new Map<number, bigint>();
  for (let i = 0n; found.size < wanted.length; i++) {
    const seed = productionSeed(i);
    const g = geneAtMint(seed, denomIndex);
    if (wanted.includes(g) && !found.has(g)) found.set(g, seed);
  }
  return wanted.map((g) => ({seed: found.get(g)!, denomIndex, gene: g}));
}

interface SurvivorChoiceCase {
  seeds: bigint[];
  genes: number[];
  survivorA: number;
  survivorB: number;
  geneA: number;
  geneB: number;
}

/**
 * Find five dust seeds where composing into 0.05 (T = 1) with one member as survivor yields a
 * different resulting gene than composing the identical five-member multiset with a different
 * member as survivor (impl spec §5 test 6). `best`, `worst` and `center` are pool statistics
 * over the whole multiset and so are identical either way; what differs is the compose
 * randomizer `R` (keyed on the chosen survivor's seed and the fold of the other four) and the
 * chosen survivor's own starting gene.
 */
function findSurvivorChoiceCase(): SurvivorChoiceCase {
  const oldIndex = 0;
  const newIndex = 1;
  for (let start = 0n; ; start += 5n) {
    const seeds = Array.from({length: 5}, (_, i) => productionSeed(start + BigInt(i)));
    const genes = seeds.map((s) => geneAtMint(s, 0));
    const sumW = genes.reduce((a, g) => a + BigInt(g), 0n); // units = 1 each
    const U = 5n;
    const center = centerGene(sumW, U);
    const best = Math.max(...genes);
    const worst = Math.min(...genes);
    const foldExcluding = (excl: number) =>
      seeds.reduce((acc, s, i) => (i === excl ? acc : acc ^ s), 0n);

    for (let a = 0; a < 5; a++) {
      for (let b = 0; b < 5; b++) {
        if (a === b) continue;
        const geneA = geneAtCompose(
          seeds[a], foldExcluding(a), genes[a], oldIndex, newIndex, best, worst, center,
        );
        const geneB = geneAtCompose(
          seeds[b], foldExcluding(b), genes[b], oldIndex, newIndex, best, worst, center,
        );
        if (geneA !== geneB) {
          return {seeds, genes, survivorA: a, survivorB: b, geneA, geneB};
        }
      }
    }
  }
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
  { seed: productionSeed(15n), amountWei: DENOMINATIONS[7], tokenId: 25n, originCount: 0n, inverted: false, why: "Fragment 50 ETH (0 origins, split remainder)" },

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

  // Compose Depth: contract state, not seed-derived. Most cases default to 0 (never composed
  // into); these exercise the non-zero rendering of the trait.
  { seed: productionSeed(16n), amountWei: DENOMINATIONS[1], tokenId: 26n, originCount: 5n, inverted: false, why: "Compose Depth 1 (one reversible compose)", composeDepth: 1n },
  { seed: productionSeed(17n), amountWei: DENOMINATIONS[4], tokenId: 27n, originCount: 100n, inverted: false, why: "Compose Depth 3 (stacked reversible composes)", composeDepth: 3n },
];
cases.push(...edges);

const hex32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

// Deterministic split child-seed derivation: childSeed = keccak256(abi.encodePacked(parent, i)).
// Computed by the same TS helper the frontend preview uses; test/Parity.t.sol recomputes the
// Solidity derivation and asserts it matches these byte for byte. Indices span the small values a
// real split uses and larger ones to exercise the packing.
const childParents = [productionSeed(1n), 0n, MAX_U256, productionSeed(9999n)];
const childIndices = [0, 1, 2, 9, 255, 10000];
const childCases: {parent: bigint; index: number; child: bigint}[] = [];
for (const parent of childParents) {
  for (const index of childIndices) {
    childCases.push({parent, index, child: splitChildSeed(parent, index)});
  }
}

const out = {
  _comment:
    "Generated by preview/scripts/genFixtures.ts from the canonical TypeScript renderer. " +
    "Do not hand-edit. Regenerate with `npm run fixtures` in preview/.",
  count: cases.length,
  why: cases.map((c) => c.why),
  tokenId: cases.map((c) => c.tokenId.toString()),
  seed: cases.map((c) => hex32(c.seed)),
  amountWei: cases.map((c) => c.amountWei.toString()),
  amountLabel: cases.map((c) => LABELS[composeShape(c.seed, c.amountWei, geneOf(c)).denomIndex] + " ETH"),
  cols: cases.map((c) => composeShape(c.seed, c.amountWei, geneOf(c)).cols.toString()),
  rows: cases.map((c) => composeShape(c.seed, c.amountWei, geneOf(c)).rows.toString()),
  cell: cases.map((c) => fmt(composeShape(c.seed, c.amountWei, geneOf(c)).cell)),
  fill: cases.map((c) => fmt(composeShape(c.seed, c.amountWei, geneOf(c)).fill)),
  wRatio: cases.map((c) => fmt(composeShape(c.seed, c.amountWei, geneOf(c)).wRatio)),
  target: cases.map((c) => fmt(composeShape(c.seed, c.amountWei, geneOf(c)).target)),
  modules: cases.map((c) => moduleSequence(composeShape(c.seed, c.amountWei, geneOf(c)))),
  originCount: cases.map((c) => c.originCount.toString()),
  inverted: cases.map((c) => (c.inverted ? "true" : "false")),
  inkGene: cases.map((c) => geneOf(c).toString()),
  composeDepth: cases.map((c) => depthOf(c).toString()),
  svg: cases.map((c) => renderShape(c.seed, c.amountWei, c.tokenId, geneOf(c), CANONICAL, c.inverted)), // tokenId unused: no type
  metadata: cases.map((c) =>
    tokenMetadataJson(
      c.seed,
      c.amountWei,
      c.tokenId,
      c.originCount,
      c.inverted,
      geneOf(c),
      depthOf(c),
    ),
  ),
  childParent: childCases.map((c) => hex32(c.parent)),
  childIndex: childCases.map((c) => c.index.toString()),
  childSeed: childCases.map((c) => hex32(c.child)),

  // ---------------------------------------------------------------------------------------
  // Ink Genes (INK_GENES_IMPL_SPEC.md)
  // ---------------------------------------------------------------------------------------

  // The constant tables. Parity-tested against InkGenes.sol the same way the denomination
  // table is: Solidity recomputes its own table and this is compared byte for byte.
  geneCount: GENE_COUNT.toString(),
  geneNames: GENE_NAMES,
  geneProbability: GENE_PROBABILITY.map((w) => fmt(w)),

  // Mint gene vectors: fixed seeds -> expected gene, found by scanning production seeds.
  // Dust (denomIndex 0) covers all seven genes; a non-dust tier covers its narrow
  // {Sparse, Murk, Dense} band. Frozen here so test/InkGenes.t.sol needs no search of its own.
  ...(() => {
    const dust = findMintVectors(0, [0, 1, 2, 3, 4, 5, 6]);
    const nonDust = findMintVectors(4, [2, 3, 4]); // 1 ETH
    const vectors = [...dust, ...nonDust];
    return {
      inkMintSeed: vectors.map((v) => hex32(v.seed)),
      inkMintDenomIndex: vectors.map((v) => v.denomIndex.toString()),
      inkMintGene: vectors.map((v) => v.gene.toString()),
    };
  })(),

  // Survivor choice: a concrete 5-dust-into-0.05 candidate set where composing with one
  // token as survivor yields a different gene than composing the identical multiset with
  // another token as survivor. Found by search; test/InkGenes.t.sol re-derives best/worst/
  // center/fold from just the five seeds and the two survivor indices, and checks the two
  // outcomes match these AND differ from each other.
  ...(() => {
    const found = findSurvivorChoiceCase();
    return {
      inkSurvivorSeeds: found.seeds.map(hex32),
      inkSurvivorGenes: found.genes.map((g) => g.toString()),
      inkSurvivorIndexA: found.survivorA.toString(),
      inkSurvivorIndexB: found.survivorB.toString(),
      inkSurvivorGeneA: found.geneA.toString(),
      inkSurvivorGeneB: found.geneB.toString(),
    };
  })(),

  // Compose-walk vectors across every tier span T = 1..8 with heterogeneous pool statistics, so
  // InkGenes.geneAtCompose is pinned to the TS canonical for multi-tier walks and not only the
  // T = 1 survivor case above. Survivor seed and burn fold are derived deterministically from a
  // counter (splitmix over 256 bits), so the corpus regenerates byte-identically.
  ...(() => {
    const MASK = (1n << 256n) - 1n;
    const mix = (x: bigint): bigint => {
      let v = (x * 0x9e3779b97f4a7c15n + 0x243f6a8885a308d3n) & MASK;
      v ^= v >> 29n;
      v = (v * 0xbf58476d1ce4e5b9n) & MASK;
      v ^= v >> 32n;
      v = (v * 0x94d049bb133111ebn) & MASK;
      v ^= v >> 31n;
      return v & MASK;
    };
    // [survivorGene, best, worst, center] spanning the low/high/mixed/homogeneous cases.
    const combos: [number, number, number, number][] = [
      [0, 6, 0, 3],
      [6, 6, 0, 3],
      [3, 5, 1, 4],
      [2, 6, 2, 5],
      [4, 4, 4, 4],
    ];
    const seed: string[] = [], fold: string[] = [], sg: string[] = [];
    const oldI: string[] = [], newI: string[] = [], bst: string[] = [];
    const wst: string[] = [], ctr: string[] = [], exp: string[] = [];
    let n = 0;
    for (let T = 1; T <= 8; T++) {
      for (const [g0, b, w, c] of combos) {
        const s = mix(BigInt(n) * 2n + 1n);
        const f = mix(BigInt(n) * 2n + 2n);
        const g = geneAtCompose(s, f, g0, 0, T, b, w, c);
        seed.push(hex32(s));
        fold.push(f.toString());
        sg.push(g0.toString());
        oldI.push("0");
        newI.push(T.toString());
        bst.push(b.toString());
        wst.push(w.toString());
        ctr.push(c.toString());
        exp.push(g.toString());
        n++;
      }
    }
    return {
      inkWalkSurvivorSeed: seed,
      inkWalkBurnFold: fold,
      inkWalkSurvivorGene: sg,
      inkWalkOldIndex: oldI,
      inkWalkNewIndex: newI,
      inkWalkBest: bst,
      inkWalkWorst: wst,
      inkWalkCenter: ctr,
      inkWalkExpectedGene: exp,
    };
  })(),
};

const target = resolve(import.meta.dirname, "../../test/fixtures/fixtures.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");

const bytes = out.svg.reduce((a, s) => a + s.length, 0);
console.log(`wrote ${cases.length} fixtures to ${target}`);
console.log(`  svg bytes: min ${Math.min(...out.svg.map((s) => s.length))}, max ${Math.max(
  ...out.svg.map((s) => s.length),
)}, mean ${Math.round(bytes / cases.length)}`);

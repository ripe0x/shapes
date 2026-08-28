/**
 * Ink-gene difficulty simulator (SPEC.md D17 / INK_GENES_DRAFT.md §8).
 *
 * Answers the headline tuning question: what does it cost a rational player to grind a target
 * gene at a target denomination — the flagship being a **Solid 100**? Cost is measured in three
 * currencies:
 *
 *   - dust mints:  total 0.01-ETH mints the player must make (the "hunting")
 *   - parked ETH:  peak simultaneous redeemable backing the strategy ties up
 *   - fees:        1% of every mint's backing (the only non-refundable spend, ex-gas)
 *
 * The mechanic that dominates the answer: a compose crossing one tier rolls once —
 * 70% toward the units-weighted center, 20% toward best, 10% toward worst. A lone Solid
 * survivor in a mixed pool is therefore dragged back down by the 70% center branch, so a pool
 * only *outputs* Solid reliably when it is (near-)homogeneous Solid at a single rung. Solid genes
 * enter only through dust mints (3% each, committed knob), but a player can repeatedly retain
 * Dense/Rich intermediates and search survivor choices while climbing. The simulator therefore
 * reports both the safe homogeneous upper bound and one measured lower-cost factory policy.
 *
 * This script does NOT import the committed thresholds from ink.ts (those are the very knobs
 * under test); it reimplements the identical keccak roll structure with the thresholds exposed
 * as parameters, and asserts the committed parameterisation reproduces ink.ts on sample vectors.
 *
 * Run: npm run ink:tune        (writes curve data to scripts/out/ink-tuning.json)
 */

import { keccak256, encodePacked } from "viem";
import {
  geneAtMint as committedGeneAtMint,
  geneAtCompose as committedGeneAtCompose,
  GENE_NAMES,
  SOLID,
} from "../src/canonical/ink";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GENES = 7; // Void..Solid = 0..6

// The nine denominations as unit multiples of 0.01 ETH, and the tier ratios between them.
const UNITS = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000];
const RATIOS = UNITS.slice(1).map((u, i) => u / UNITS[i]); // [5,2,5,2,5,2,5,2]
const DENOM_LABEL = ["0.01", "0.05", "0.1", "0.5", "1", "5", "10", "50", "100"];

// ---------------------------------------------------------------------------
// Tunable knobs (the ⚙ constants). Committed values are the defaults.
// ---------------------------------------------------------------------------

interface Knobs {
  /** Dust (0.01) mint distribution over the seven genes, percentages summing to 100. */
  dustDist: number[]; // [Void,Faint,Sparse,Murk,Dense,Rich,Solid]
  /** Non-dust mint distribution over {Sparse,Murk,Dense} only, percentages summing to 100. */
  bandDist: [number, number, number];
  /** Per-tier walk odds: [towardCenter, towardBest] (towardWorst = 100 - the two). */
  walk: [number, number];
}

const COMMITTED: Knobs = {
  dustDist: [3, 7, 15, 50, 15, 7, 3],
  bandDist: [20, 60, 20],
  walk: [70, 20],
};

// ---------------------------------------------------------------------------
// Deterministic PRNG for reproducible seed streams (no Date/Math.random in the roll path).
// ---------------------------------------------------------------------------

function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randSeed(rng: () => number): bigint {
  // 256-bit seed from four 32-bit draws.
  let v = 0n;
  for (let i = 0; i < 4; i++) v = (v << 64n) | BigInt(Math.floor(rng() * 2 ** 32)) << 32n | BigInt(Math.floor(rng() * 2 ** 32));
  return v & ((1n << 256n) - 1n);
}

function seedHex(v: bigint): `0x${string}` {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

// ---------------------------------------------------------------------------
// Parametric roll structure — identical keccak derivation to ink.ts, thresholds exposed.
// ---------------------------------------------------------------------------

function mintRoll(seed: bigint): number {
  return Number(BigInt(keccak256(encodePacked(["string", "bytes32"], ["ink:mint", seedHex(seed)]))) % 100n);
}

function geneAtMintP(seed: bigint, denomIndex: number, k: Knobs): number {
  const r = mintRoll(seed);
  if (denomIndex === 0) {
    let acc = 0;
    for (let g = 0; g < GENES; g++) {
      acc += k.dustDist[g];
      if (r < acc) return g;
    }
    return SOLID;
  }
  const [sp, mu] = k.bandDist;
  if (r < sp) return 2; // Sparse
  if (r < sp + mu) return 3; // Murk
  return 4; // Dense
}

function walkStep(R: bigint, k: number, g: number, best: number, worst: number, center: number, kn: Knobs): number {
  const roll = Number(BigInt(keccak256(encodePacked(["bytes32", "uint256"], [seedHex(R), BigInt(k)]))) % 100n);
  const [c, b] = kn.walk;
  const target = roll < c ? center : roll < c + b ? best : worst;
  if (g < target) return g + 1;
  if (g > target) return g - 1;
  return g;
}

/** One compose across (newIndex-oldIndex) tiers. Mirrors InkGenes.geneAtCompose with tunable walk. */
function composeGene(
  survivorSeed: bigint,
  burnSeedFold: bigint,
  survivorGene: number,
  oldIndex: number,
  newIndex: number,
  best: number,
  worst: number,
  center: number,
  kn: Knobs,
): number {
  const R = BigInt(
    keccak256(encodePacked(["string", "bytes32", "uint256", "uint8"], ["ink:compose", seedHex(survivorSeed), burnSeedFold, newIndex])),
  );
  let g = survivorGene;
  const T = newIndex - oldIndex;
  for (let step = 1; step <= T; step++) g = walkStep(R, step, g, best, worst, center, kn);
  return g;
}

// ---------------------------------------------------------------------------
// Self-check: the committed knobs must reproduce ink.ts exactly.
// ---------------------------------------------------------------------------

function assertMatchesCommitted() {
  const rng = makeRng(1);
  for (let i = 0; i < 2000; i++) {
    const seed = randSeed(rng);
    const di = i % 9;
    if (geneAtMintP(seed, di, COMMITTED) !== committedGeneAtMint(seed, di)) {
      throw new Error(`geneAtMint diverged from ink.ts at seed ${seed} di ${di}`);
    }
  }
  // compose walk: random pool statistics, both tiers.
  for (let i = 0; i < 2000; i++) {
    const s = randSeed(rng);
    const fold = randSeed(rng);
    const g = i % 7;
    const oldI = i % 8;
    const newI = oldI + 1 + (i % (8 - oldI));
    const best = (i * 3) % 7;
    const worst = (i * 5) % 7;
    const center = (i * 7) % 7;
    const mine = composeGene(s, fold, g, oldI, newI, best, worst, center, COMMITTED);
    const theirs = committedGeneAtCompose(s, fold, g, oldI, newI, best, worst, center);
    if (mine !== theirs) throw new Error(`geneAtCompose diverged from ink.ts at i=${i}`);
  }
  console.log("  self-check: parametric roll structure reproduces ink.ts on 4000 vectors ✓");
}

// ---------------------------------------------------------------------------
// Part 1 — homogeneous baseline (exact, no simulation).
// The guaranteed-Solid strategy: assemble the target's whole backing from Solid dust and
// compose bottom-up. Every pool is homogeneous Solid, a walk fixed point, so the output is
// Solid with certainty. Dust needed = product of ratios = target units. Dust minted to obtain
// that many Solid dust = units / P(dust rolls Solid).
// ---------------------------------------------------------------------------

function homogeneousBaseline(k: Knobs) {
  const pSolidDust = k.dustDist[SOLID] / 100;
  const rows = UNITS.map((units, di) => {
    const solidDustNeeded = units; // homogeneous: whole backing is Solid dust
    const dustMints = pSolidDust > 0 ? solidDustNeeded / pSolidDust : Infinity;
    const parkedEth = units * 0.01; // the assembled backing (Solid dust redeemed as it climbs → peak ~= target)
    const feesEth = dustMints * 0.01 * 0.01; // 1% of each 0.01 mint
    return { denom: DENOM_LABEL[di], units, dustMints, parkedEth, feesEth };
  });
  return { pSolidDust, rows };
}

// ---------------------------------------------------------------------------
// Part 2 — rescue discount, measured. How reliably does ONE group of `ratio` children compose
// UP to Solid, given the group already contains a Solid `best` but a non-Solid center? This
// demonstrates how far a player can substitute cheap fillers for Solid dust and still climb.
// ---------------------------------------------------------------------------

/** Units-weighted center over a group of (gene, units) pairs, half-up (mirrors InkGenes.center). */
function centerOf(group: { gene: number; units: number }[]): number {
  let sumW = 0, u = 0;
  for (const c of group) { sumW += c.gene * c.units; u += c.units; }
  return Math.floor((2 * sumW + u) / (2 * u));
}

/**
 * P(a single group of `ratio` children, `solids` of them Solid and the rest `filler`, composes
 * to Solid in one tier) — best over the `ratio` survivor choices, Monte-Carlo over seeds. This is the
 * per-attempt success rate; a player with S searchable groups reaches 1-(1-p)^S.
 */
function pGroupToSolid(ratio: number, solids: number, filler: number, oldIndex: number, kn: Knobs, trials: number, rng: () => number): number {
  let wins = 0;
  const unitsPerChild = UNITS[oldIndex];
  for (let t = 0; t < trials; t++) {
    const genes: number[] = [];
    for (let i = 0; i < solids; i++) genes.push(SOLID);
    for (let i = solids; i < ratio; i++) genes.push(filler);
    const seeds = genes.map(() => randSeed(rng));
    const best = Math.max(...genes);
    const worst = Math.min(...genes);
    // Try each of the `ratio` children as survivor; keep the best result gene.
    let bestResult = 0;
    for (let s = 0; s < ratio; s++) {
      const survivorGene = genes[s];
      let fold = 0n;
      const group: { gene: number; units: number }[] = [];
      for (let i = 0; i < ratio; i++) {
        group.push({ gene: genes[i], units: unitsPerChild });
        if (i !== s) fold ^= seeds[i];
      }
      const center = centerOf(group);
      const g = composeGene(seeds[s], fold, survivorGene, oldIndex, oldIndex + 1, best, worst, center, kn);
      if (g > bestResult) bestResult = g;
    }
    if (bestResult === SOLID) wins++;
  }
  return wins / trials;
}

// ---------------------------------------------------------------------------
// Part 2b — direct end-to-end factory. Measures one retained-gene heuristic (vs the homogeneous
// upper bound): a patient player who mints dust, redeems anything below a keep-threshold, and
// composes only retained high-gene tokens upward with survivor search until a Solid emerges at
// the target denomination. This is not an optimizer or a claim about the globally cheapest
// strategy. Pools track retained `{gene, seed}` tokens. A selected survivor keeps its actual
// onchain seed through every rung, and each candidate's burn fold is the XOR of its actual peers.
// ---------------------------------------------------------------------------

interface FactoryOutcome {
  dustMints: number;
  peakRetainedEth: number;
}

interface FactoryToken {
  gene: number;
  seed: bigint;
}

function factoryDustToSolid(targetLevel: number, keepThreshold: number, kn: Knobs, rng: () => number, maxDust: number): FactoryOutcome | null {
  const pools: FactoryToken[][][] = Array.from(
    { length: targetLevel + 1 },
    () => Array.from({ length: GENES }, () => []),
  );
  let dust = 0;
  let peakRetainedUnits = 0;

  const retainedUnits = () => pools.reduce(
    (total, byGene, level) => total + byGene.reduce((sum, tokens) => sum + tokens.length * UNITS[level], 0),
    0,
  );

  const recordPeak = () => { peakRetainedUnits = Math.max(peakRetainedUnits, retainedUnits()); };

  const highestGroup = (lvl: number, r: number): FactoryToken[] | null => {
    // Pick the r highest-gene retained tokens at this level. Within a gene bucket, LIFO is an
    // explicit deterministic heuristic, not a claim that every seed grouping was optimized.
    const picked: FactoryToken[] = [];
    for (let g = GENES - 1; g >= keepThreshold && picked.length < r; g--) {
      const bucket = pools[lvl][g];
      while (bucket.length !== 0 && picked.length < r) picked.push(bucket.pop()!);
    }
    if (picked.length === r) return picked;
    // Restore a partial pick on the impossible path, preserving exact pool state.
    for (const token of picked) pools[lvl][token.gene].push(token);
    return null;
  };

  const cascade = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let lvl = 0; lvl < targetLevel; lvl++) {
        const r = RATIOS[lvl];
        let grp = highestGroup(lvl, r);
        while (grp) {
          const genes = grp.map((token) => token.gene);
          const best = Math.max(...genes);
          const worst = Math.min(...genes);
          const unitsPerChild = UNITS[lvl];
          let bestResult = 0;
          let chosenSurvivor = grp[0];
          for (let s = 0; s < r; s++) {
            let fold = 0n;
            let sumW = 0, u = 0;
            for (let i = 0; i < r; i++) {
              sumW += grp[i].gene * unitsPerChild;
              u += unitsPerChild;
              if (i !== s) fold ^= grp[i].seed;
            }
            const center = Math.floor((2 * sumW + u) / (2 * u));
            const res = composeGene(grp[s].seed, fold, grp[s].gene, lvl, lvl + 1, best, worst, center, kn);
            if (res > bestResult) {
              bestResult = res;
              chosenSurvivor = grp[s];
            }
          }
          pools[lvl + 1][bestResult].push({ gene: bestResult, seed: chosenSurvivor.seed });
          changed = true;
          grp = highestGroup(lvl, r);
        }
      }
    }
  };

  while (dust < maxDust) {
    if (pools[targetLevel][SOLID].length >= 1) return { dustMints: dust, peakRetainedEth: peakRetainedUnits * 0.01 };
    // mint a small batch, then cascade.
    for (let i = 0; i < 64; i++) {
      const seed = randSeed(rng);
      const gene = geneAtMintP(seed, 0, kn);
      if (gene >= keepThreshold) {
        pools[0][gene].push({ gene, seed });
        recordPeak();
      }
      dust++;
    }
    cascade();
  }
  return pools[targetLevel][SOLID].length >= 1 ? { dustMints: dust, peakRetainedEth: peakRetainedUnits * 0.01 } : null;
}

// ---------------------------------------------------------------------------
// Part 3 — headline + knob sweeps.
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (!isFinite(n)) return "∞";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(n < 10 ? 2 : 0);
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
  const se = Math.sqrt(variance / samples.length);
  return {
    n: samples.length,
    mean,
    min: sorted[0],
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
    max: sorted[sorted.length - 1],
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
  };
}

function main() {
  console.log("Ink-gene difficulty simulator\n");
  assertMatchesCommitted();

  const rng = makeRng(12345);
  const out: Record<string, unknown> = {};

  // --- Homogeneous baseline at the committed knobs ---
  console.log("\n1. Homogeneous 'guaranteed-Solid' baseline (committed knobs: dust Solid = 3%)");
  console.log("   Assemble the whole backing from Solid dust; every compose is a fixed point.\n");
  const base = homogeneousBaseline(COMMITTED);
  console.log("   denom   units    dust mints   parked ETH   fees ETH");
  for (const r of base.rows) {
    console.log(
      `   ${r.denom.padStart(5)}  ${String(r.units).padStart(6)}   ${fmt(r.dustMints).padStart(9)}    ${r.parkedEth.toFixed(2).padStart(8)}   ${r.feesEth.toFixed(2).padStart(7)}`,
    );
  }
  out.homogeneousCommitted = base.rows;

  // --- Per-attempt rescue success at tier 0->1 (dust -> 0.05, ratio 5) ---
  console.log("\n2. Rescue reality — P(one group composes UP to Solid) at tier 0.01→0.05 (ratio 5)");
  console.log("   'k Solid + (5-k) filler' children, best over the 5 survivor choices.\n");
  console.log("   filler\\solids     1        2        3        4        5");
  const rescueTable: Record<string, number[]> = {};
  for (const filler of [3 /*Murk*/, 4 /*Dense*/, 5 /*Rich*/]) {
    const rowP: number[] = [];
    let line = `   ${GENE_NAMES[filler].padEnd(6)}       `;
    for (let solids = 1; solids <= 5; solids++) {
      const p = pGroupToSolid(5, solids, filler, 0, COMMITTED, 20000, rng);
      rowP.push(p);
      line += `  ${(p * 100).toFixed(1).padStart(5)}%`;
    }
    console.log(line);
    rescueTable[GENE_NAMES[filler]] = rowP;
  }
  out.rescueTierP = rescueTable;

  // --- Direct factory: measured retained-gene heuristic vs the homogeneous upper bound ---
  console.log("\n2b. Direct factory — dust actually minted to reach a Solid at the target denom");
  console.log("    One retained-gene heuristic, not a global optimizer. Redeems below threshold; searches survivors.\n");
  console.log("    target   keep≥     avg dust    homog. baseline   discount");
  const factoryRows: { level: number; denom: string; keep: string; avgDust: number; baseline: number; stats?: ReturnType<typeof summarize>; peakRetainedEth?: ReturnType<typeof summarize> }[] = [];
  // Two policies across every composable denomination, plus the fuller 1 ETH sweep. The default
  // of 64 independent outcomes gives the Solid-100 mean a 95% confidence interval rather than
  // treating a handful of illustrative runs as a tuning result. Set INK_FACTORY_TRIALS to trade
  // runtime for precision while retaining the same deterministic seed stream.
  const factoryTrials = Number.parseInt(process.env.INK_FACTORY_TRIALS ?? "64", 10);
  if (!Number.isInteger(factoryTrials) || factoryTrials < 2) throw new Error("INK_FACTORY_TRIALS must be an integer ≥ 2");
  const factoryPlan: [number, number[]][] = [
    [1, [4, 5]], [2, [4, 5]], [3, [4, 5]], [4, [3, 4, 5, 6]],
    [5, [4, 5]], [6, [4, 5]], [7, [4, 5]], [8, [4, 5]],
  ];
  for (const [level, keeps] of factoryPlan) {
    const baseline = UNITS[level] / (COMMITTED.dustDist[SOLID] / 100);
    for (const keep of keeps) {
      const trials = factoryTrials;
      // Cap dust at 3x the homogeneous bound: a keep-threshold that cannot climb to Solid caps
      // out fast and is reported as unreachable rather than spinning to millions of mints.
      const cap = Math.ceil(baseline * 3);
      const samples: number[] = [];
      const peakRetainedEthSamples: number[] = [];
      for (let t = 0; t < trials; t++) {
        const d = factoryDustToSolid(level, keep, COMMITTED, rng, cap);
        if (d !== null) {
          samples.push(d.dustMints);
          peakRetainedEthSamples.push(d.peakRetainedEth);
        }
      }
      const stats = samples.length ? summarize(samples) : undefined;
      const peakRetainedEth = peakRetainedEthSamples.length ? summarize(peakRetainedEthSamples) : undefined;
      const avg = stats?.mean ?? Infinity;
      const reach = samples.length === trials ? "" : samples.length === 0 ? "  (never reached Solid ≤3× bound)" : `  (${samples.length}/${trials} reached)`;
      factoryRows.push({ level, denom: DENOM_LABEL[level], keep: GENE_NAMES[keep], avgDust: avg, baseline, stats, peakRetainedEth });
      console.log(
        `    ${DENOM_LABEL[level].padStart(4)} ETH  ${GENE_NAMES[keep].padEnd(6)}  ${fmt(avg).padStart(8)}    ${fmt(baseline).padStart(9)}         ${(avg / baseline).toFixed(2)}×${reach}`,
      );
    }
  }
  out.factory = factoryRows;
  // Lowest observed Solid-100 mean among the measured retained-gene policies.
  const top = factoryRows.filter((r) => r.level === 8);
  const bestMeasuredTop = top.reduce((a, b) => (b.avgDust < a.avgDust ? b : a));
  const discTop = bestMeasuredTop.avgDust / bestMeasuredTop.baseline;
  const topStats = bestMeasuredTop.stats!;
  const topPeak = bestMeasuredTop.peakRetainedEth!;
  console.log(`\n    Solid 100 retained-gene heuristic (n=${topStats.n}, keep≥${bestMeasuredTop.keep}): ≈ ${fmt(bestMeasuredTop.avgDust)} dust mints,`);
  console.log(`      95% CI ${fmt(topStats.ci95[0])}–${fmt(topStats.ci95[1])}; p50 ${fmt(topStats.p50)}, p95 ${fmt(topStats.p95)}.`);
  console.log(`      ${discTop.toFixed(2)}× the 333k homogeneous bound, ~${(bestMeasuredTop.avgDust * 0.0001).toFixed(0)} ETH fees,`);
  console.log(`      retained backing mean ${topPeak.mean.toFixed(2)} ETH, p95 ${topPeak.p95.toFixed(2)} ETH.`);
  out.solidHundredHeuristic = { dustMints: bestMeasuredTop.avgDust, keep: bestMeasuredTop.keep, feesEth: bestMeasuredTop.avgDust * 0.0001, stats: topStats, peakRetainedEth: topPeak };

  // --- Headline: Solid 100 dust-mint cost vs the two dominant knobs ---
  console.log("\n3. Headline sweep — dust mints to a Solid 100 (homogeneous baseline)");
  console.log("   vs dust-Solid% (the dominant lever). Parked ≈ 100 ETH, fees = mints × 0.0001 ETH.\n");
  console.log("   dust Solid%   dust mints   fees ETH");
  const solidSweep: { dustSolidPct: number; dustMints: number; feesEth: number }[] = [];
  for (const pct of [1, 2, 3, 5, 8, 12]) {
    const dm = 10000 / (pct / 100);
    solidSweep.push({ dustSolidPct: pct, dustMints: dm, feesEth: dm * 0.0001 });
    console.log(`   ${String(pct).padStart(8)}%   ${fmt(dm).padStart(9)}    ${(dm * 0.0001).toFixed(2).padStart(6)}`);
  }
  out.solidHundredSweep = solidSweep;

  // --- Walk-odds sensitivity of the rescue discount ---
  console.log("\n4. Walk-odds sensitivity — P(one group→Solid) at tier 0.01→0.05, 4 Solid + 1 Murk");
  console.log("   as 'toward best' widens (center shrinks). Higher = rescue cheaper.\n");
  console.log("   center/best/worst    P(group→Solid)");
  const walkSweep: { walk: number[]; p: number }[] = [];
  for (const [c, b] of [[70, 20], [60, 30], [50, 40], [40, 40]] as [number, number][]) {
    const kn: Knobs = { ...COMMITTED, walk: [c, b] };
    const p = pGroupToSolid(5, 4, 3, 0, kn, 30000, rng);
    walkSweep.push({ walk: [c, b, 100 - c - b], p });
    console.log(`   ${`${c}/${b}/${100 - c - b}`.padStart(11)}          ${(p * 100).toFixed(1).padStart(5)}%`);
  }
  out.walkSweep = walkSweep;

  // --- Difficulty surface: cheapest gene reachable per denom under homogeneous strategy ---
  console.log("\n5. What each summit costs (homogeneous, committed 3% dust-Solid)");
  console.log("   Rich/Solid only enter via dust; interior genes are cheap by lineage.\n");
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "ink-tuning.json"), JSON.stringify(out, null, 2));
  console.log(`\n   curve data → scripts/out/ink-tuning.json`);
  console.log("\nNotes:");
  console.log("  - 'parked ETH' assumes non-Solid dust is redeemed as you climb, so peak ≈ the target.");
  console.log("  - rescue (Part 2) is local to one pool. Across a full ladder, retained Dense/Rich");
  console.log("    intermediates can still search into Solid; this reports a policy result, not an optimum.");
}

main();

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
 * only *outputs* Solid reliably when it is (near-)homogeneous Solid. Solid genes enter only
 * through dust mints (3% each, committed knob), so the honest cost of a Solid 100 is dominated
 * by minting enough Solid dust to assemble the whole 100 ETH of backing from it.
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
// bounds how far a player can substitute cheap fillers for Solid dust and still climb, i.e. how
// much cheaper than the homogeneous baseline the real optimum is.
// ---------------------------------------------------------------------------

/** Units-weighted center over a group of (gene, units) pairs, half-up (mirrors InkGenes.center). */
function centerOf(group: { gene: number; units: number }[]): number {
  let sumW = 0, u = 0;
  for (const c of group) { sumW += c.gene * c.units; u += c.units; }
  return Math.floor((2 * sumW + u) / (2 * u));
}

/**
 * P(a single group of `ratio` children, `solids` of them Solid and the rest `filler`, composes
 * to Solid in one tier) — best over survivor choice, Monte-Carlo over seeds. This is the
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
    // try each child as survivor (the n+1 shots); keep the best result gene.
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
// Part 2b — direct end-to-end factory. Measures the REAL optimum (vs the homogeneous upper
// bound): a patient player who mints dust, redeems anything below a keep-threshold, and composes
// only the highest-gene tokens upward with survivor search, until a Solid emerges at the target
// denomination. Reports dust actually minted. Pools tracked as counts[level][gene] with fresh
// random seeds per compose (seeds are uniform anyway), so a whole trial is cheap.
// ---------------------------------------------------------------------------

function factoryDustToSolid(targetLevel: number, keepThreshold: number, kn: Knobs, rng: () => number, maxDust: number): number | null {
  const counts: number[][] = Array.from({ length: targetLevel + 1 }, () => new Array(GENES).fill(0));
  let dust = 0;

  const highestGroup = (lvl: number, r: number): number[] | null => {
    // pick the r highest-gene tokens at lvl that are all >= keepThreshold; else null.
    const picked: number[] = [];
    for (let g = GENES - 1; g >= keepThreshold && picked.length < r; g--) {
      let avail = counts[lvl][g];
      while (avail-- > 0 && picked.length < r) picked.push(g);
    }
    return picked.length === r ? picked : null;
  };

  const cascade = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let lvl = 0; lvl < targetLevel; lvl++) {
        const r = RATIOS[lvl];
        let grp = highestGroup(lvl, r);
        while (grp) {
          for (const g of grp) counts[lvl][g]--;
          const seeds = grp.map(() => randSeed(rng));
          const best = Math.max(...grp);
          const worst = Math.min(...grp);
          const unitsPerChild = UNITS[lvl];
          let bestResult = 0;
          for (let s = 0; s < r; s++) {
            let fold = 0n;
            let sumW = 0, u = 0;
            for (let i = 0; i < r; i++) { sumW += grp[i] * unitsPerChild; u += unitsPerChild; if (i !== s) fold ^= seeds[i]; }
            const center = Math.floor((2 * sumW + u) / (2 * u));
            const res = composeGene(seeds[s], fold, grp[s], lvl, lvl + 1, best, worst, center, kn);
            if (res > bestResult) bestResult = res;
          }
          counts[lvl + 1][bestResult]++;
          changed = true;
          grp = highestGroup(lvl, r);
        }
      }
    }
  };

  while (dust < maxDust) {
    if (counts[targetLevel][SOLID] >= 1) return dust;
    // mint a small batch, then cascade.
    for (let i = 0; i < 64; i++) { counts[0][geneAtMintP(randSeed(rng), 0, kn)]++; dust++; }
    cascade();
  }
  return counts[targetLevel][SOLID] >= 1 ? dust : null;
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

  // --- Direct factory: real optimum vs the homogeneous upper bound ---
  console.log("\n2b. Direct factory — dust actually minted to reach a Solid at the target denom");
  console.log("    Player redeems tokens below the keep-threshold; composes the rest up with search.\n");
  console.log("    target   keep≥     avg dust    homog. baseline   discount");
  const factoryRows: { level: number; denom: string; keep: string; avgDust: number; baseline: number }[] = [];
  // (level, keep-thresholds to try, trials) — fewer trials at the expensive top tiers.
  const factoryPlan: [number, number[], number][] = [
    [4, [3, 4, 5, 6], 16], // 1 ETH — sweep keep-threshold to find the optimum
    [6, [4, 5], 12],       // 10 ETH
    [8, [4, 5], 8],        // 100 ETH — the headline, measured directly
  ];
  for (const [level, keeps, trialsN] of factoryPlan) {
    const baseline = UNITS[level] / (COMMITTED.dustDist[SOLID] / 100);
    for (const keep of keeps) {
      const trials = trialsN;
      // Cap dust at 3x the homogeneous bound: a keep-threshold that cannot climb to Solid caps
      // out fast and is reported as unreachable rather than spinning to millions of mints.
      const cap = Math.ceil(baseline * 3);
      let sum = 0, ok = 0;
      for (let t = 0; t < trials; t++) {
        const d = factoryDustToSolid(level, keep, COMMITTED, rng, cap);
        if (d !== null) { sum += d; ok++; }
      }
      const avg = ok ? sum / ok : Infinity;
      const reach = ok === trials ? "" : ok === 0 ? "  (never reached Solid ≤3× bound)" : `  (${ok}/${trials} reached)`;
      factoryRows.push({ level, denom: DENOM_LABEL[level], keep: GENE_NAMES[keep], avgDust: avg, baseline });
      console.log(
        `    ${DENOM_LABEL[level].padStart(4)} ETH  ${GENE_NAMES[keep].padEnd(6)}  ${fmt(avg).padStart(8)}    ${fmt(baseline).padStart(9)}         ${(avg / baseline).toFixed(2)}×${reach}`,
      );
    }
  }
  out.factory = factoryRows;
  // Directly-measured Solid-100 optimum (level 8, best keep-threshold).
  const top = factoryRows.filter((r) => r.level === 8);
  const bestTop = top.reduce((a, b) => (b.avgDust < a.avgDust ? b : a));
  const discTop = bestTop.avgDust / bestTop.baseline;
  console.log(`\n    Solid 100 real optimum (measured): ≈ ${fmt(bestTop.avgDust)} dust mints (keep≥${bestTop.keep}),`);
  console.log(`      ${discTop.toFixed(2)}× the 333k homogeneous bound, ~${(bestTop.avgDust * 0.0001).toFixed(0)} ETH fees, ~100 ETH parked.`);
  out.solidHundredOptimum = { dustMints: bestTop.avgDust, keep: bestTop.keep, feesEth: bestTop.avgDust * 0.0001 };

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
  console.log("  - rescue (Part 2) shows a lone Solid in a mixed pool rarely survives: the honest");
  console.log("    cost stays close to the homogeneous baseline, so dust-Solid% is the master knob.");
}

main();

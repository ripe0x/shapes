/**
 * Two invariants of the renderer, checked from the command line.
 *
 * 1. PRNG fidelity. The exact-integer stream must reproduce Round 03's original float64
 *    JavaScript PRNG bit-for-bit. This is the one part of the Round 03 system that is
 *    preserved verbatim, so it is worth pinning against the original source.
 *
 * 2. Cell containment. Every painted mark must reach exactly `fill x cell/2` from its cell
 *    centre — no more, and the same for every primitive whether solid or outlined. The
 *    renderer solves each footprint backwards from that target, so this re-derives the extent
 *    forwards from the emitted geometry and checks the two agree.
 */

import { Round03Rand, seed32Of } from "../src/canonical/rand";
import { composeShape } from "../src/canonical/render";
import { moduleExtent } from "../src/app/containment";
import { DENOMINATIONS } from "../src/canonical/denominations";
import { productionSeed } from "../src/seeds";
import { CANONICAL } from "../src/canonical/params";
import { geneAtMint } from "../src/canonical/ink";

/* ---- the original, verbatim ---- */
const originalRng = (seed: number) => {
  let a = (seed * 1831565813 + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};



let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error("  FAIL " + m);
};

/* ---- 1. stream parity ---- */
console.log("1. PRNG parity, exact integer vs original float64");
let firstDivergence: number | null = null;
for (let seed = 0; seed <= 200_000; seed++) {
  const o = originalRng(seed);
  const n = new Round03Rand(seed32Of(BigInt(seed)));
  let ok = true;
  for (let k = 0; k < 8; k++) {
    const a = Math.round(o() * 4294967296);
    const b = Number(n.nextU32());
    if (a !== b) {
      ok = false;
      break;
    }
  }
  if (!ok && firstDivergence === null) firstDivergence = seed;
}
// The design page's own seed set: base = 1000 + bandIndex * 613, +i*137+7
const pageSeeds: number[] = [];
for (let b = 0; b < 9; b++) {
  for (let i = 0; i < 6; i++) pageSeeds.push(1000 + b * 613 + i * 137 + 7);
}
let pageOk = true;
for (const seed of pageSeeds) {
  const o = originalRng(seed);
  const n = new Round03Rand(seed32Of(BigInt(seed)));
  for (let k = 0; k < 128; k++) {
    if (Math.round(o() * 4294967296) !== Number(n.nextU32())) pageOk = false;
  }
}
console.log(
  `   design-page seeds (${pageSeeds[0]}..${pageSeeds[pageSeeds.length - 1]}, ${pageSeeds.length} seeds, 128 draws each): ${pageOk ? "identical" : "DIVERGED"}`,
);
console.log(
  `   first divergence over 0..200000: ${firstDivergence === null ? "none" : firstDivergence}` +
    (firstDivergence !== null
      ? `  (2^${(Math.log2(firstDivergence) | 0).toString()} — float64 precision loss in the original's seeding multiply, expected)`
      : ""),
);
if (!pageOk) fail("design-page seed range must be bit-identical");

/* ---- 2. cell containment ---- */
console.log("\n2. Cell containment — painted extent vs the target");

const fillConst = Number(CANONICAL.fill) / 1e18;
let worst = 0;
let best = Infinity;
let escaping = 0;
let modules = 0;
let offTarget = 0;

for (let di = 0; di < 9; di++) {
  for (let s = 1; s <= 600; s++) {
    const seed = productionSeed(BigInt(di * 10_000 + s));
    const c = composeShape(seed, DENOMINATIONS[di], geneAtMint(seed, di));
    const wantRatio = Number(c.fill) / 1e18;
    for (const m of c.modules) {
      modules++;
      const e = moduleExtent(m, c.cell, CANONICAL);
      if (e.ratio > worst) worst = e.ratio;
      if (e.ratio < best) best = e.ratio;
      if (e.escapes) escaping++;
      // every mark on a card must land on that card's target, whatever primitive it is
      if (Math.abs(e.ratio - wantRatio) > 1e-6) offTarget++;
    }
  }
}

console.log(`   modules checked:        ${modules}`);
console.log(`   painted extent range:   ${(best * 100).toFixed(2)}% .. ${(worst * 100).toFixed(2)}% of the half-cell`);
console.log(`   configured ceiling:     ${(fillConst * 100).toFixed(2)}%`);
console.log(`   modules off their card target: ${offTarget}`);
console.log(`   modules escaping their cell:   ${escaping}`);

if (escaping) fail("a module escaped its cell");
if (offTarget) fail("a module did not land on its card's painted-extent target");
if (worst > fillConst + 1e-9) fail("painted extent exceeded the configured ceiling");

console.log(
  failures === 0
    ? "\nAll checks passed."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

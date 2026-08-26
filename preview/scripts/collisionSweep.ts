/**
 * 500-sample exact-geometry collision sweep across all nine denominations,
 * plus the distribution readout. This is the gate the design has to pass before
 * the renderer is frozen.
 *
 *   npm run sweep              -- 500 samples per denomination, canonical params
 *   npm run sweep -- 2000      -- larger sample
 */

import {
  DENOMINATIONS,
  GRIDS,
  LABELS,
} from "../src/canonical/denominations";
import { CANONICAL } from "../src/canonical/params";
import { ROT_COUNT } from "../src/canonical/render";
import { buildBatch, analyseBatch } from "../src/analysis";

const N = Number(process.argv[2] ?? 500);
const MODE = (process.argv[3] ?? "production") as "production" | "raw";
const SEED_START = 1n;

console.log(`Exact geometry collision sweep — ${N} samples per denomination`);
console.log(`params: canonical (cell fill ${Number(CANONICAL.fill)/1e18}, 6-decimal output), seeds: ${MODE}\n`);

const head =
  "  band     grid   mods  distinct  coll  ●solid  ○outline  allS allO   circle square   tri   half";
console.log(head);
console.log("  " + "-".repeat(head.length - 2));

let totalCollisions = 0;
const detail: string[] = [];

for (let i = 0; i < DENOMINATIONS.length; i++) {
  const amount = DENOMINATIONS[i];
  const [c, r] = GRIDS[i];
  const cards = buildBatch(amount, SEED_START, N, CANONICAL, MODE);
  const st = analyseBatch(cards, amount);

  const colls = st.collisionPairs.reduce((a, p) => a + p.members.length - 1, 0);
  totalCollisions += colls;

  const pct = (n: number) =>
    ((n / st.moduleTotal) * 100).toFixed(1).padStart(5) + "%";

  console.log(
    `  ${(LABELS[i] + " ETH").padEnd(9)}${(c + "x" + r).padEnd(7)}` +
      `${String(c * r).padStart(4)}  ${String(st.distinct).padStart(8)}  ` +
      `${String(colls).padStart(4)}  ${pct(st.solid)}  ${pct(st.outline)}  ` +
      `${String(st.pureSolidCards).padStart(4)} ${String(st.pureOutlineCards).padStart(4)}   ` +
      `${pct(st.kindCounts.circle)} ${pct(st.kindCounts.square)} ` +
      `${pct(st.kindCounts.triangle)} ${pct(st.kindCounts.half)}`,
  );

  if (st.collisionPairs.length) {
    detail.push(`\n  ${LABELS[i]} ETH — ${st.collisionPairs.length} colliding group(s):`);
    for (const p of st.collisionPairs.slice(0, 10)) {
      detail.push(`    ${p.hash}  seeds ${p.members.join(", ")}`);
    }
    if (st.collisionPairs.length > 10) {
      detail.push(`    ... and ${st.collisionPairs.length - 10} more`);
    }
  }
}

// Rotation zero is also the forced value for invariant kinds. Remove those modules so this
// distribution covers exactly the active vocabulary entries with two or four orientations.
console.log("\nRotation distribution over all rotatable primitives, all bands pooled:");
const rot: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
let rotTotal = 0;
for (let i = 0; i < DENOMINATIONS.length; i++) {
  const cards = buildBatch(DENOMINATIONS[i], SEED_START, N, CANONICAL, MODE);
  const st = analyseBatch(cards, DENOMINATIONS[i]);
  let rotatable = 0;
  for (const kind of CANONICAL.kinds) {
    if (ROT_COUNT[kind] > 1) rotatable += st.kindCounts[kind];
  }
  rotTotal += rotatable;
  // rotationCounts includes the forced zero of rotation-invariant kinds; subtract them.
  rot[0] += st.rotationCounts[0] - (st.moduleTotal - rotatable);
  rot[90] += st.rotationCounts[90];
  rot[180] += st.rotationCounts[180];
  rot[270] += st.rotationCounts[270];
}
const countedRotations = Object.values(rot).reduce((sum, count) => sum + count, 0);
if (Object.values(rot).some((count) => count < 0) || countedRotations !== rotTotal) {
  throw new Error(`rotation accounting mismatch: counted ${countedRotations}, expected ${rotTotal}`);
}
for (const deg of [0, 90, 180, 270]) {
  console.log(
    `  ${String(deg).padStart(3)}°  ${String(rot[deg]).padStart(7)}  ` +
      `${((rot[deg] / rotTotal) * 100).toFixed(2)}%`,
  );
}

if (detail.length) {
  console.log("\nCOLLISION DETAIL");
  console.log(detail.join("\n"));
}

console.log(
  `\nTotal exact geometry collisions across ${N * 9} cards: ${totalCollisions}`,
);
process.exit(0);

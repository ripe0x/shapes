/**
 * Prototype page for the proposed "history sets the ink" rule: origin density scales the
 * seed's fill draw, so how solid a card renders reflects how much real minting is condensed
 * inside it. Generates pre-rendered frames from the canonical renderer into a static page
 * served by the dev server at /ink-demo.html. A prototype, not a committed rule.
 */
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {renderShape, composeShape, DENOMINATIONS, WAD} from "../src/canonical/render";

const here = dirname(fileURLToPath(import.meta.url));
const ONE = DENOMINATIONS[4]; // 1 ETH, 3x3
const HUNDRED = DENOMINATIONS[8]; // 100 ETH, 1x1

/** Find a seed whose card-level fill draw matches a fate at 1 ETH. */
function findSeed(want: "outline" | "band" | "solid", startAt: bigint): bigint {
  for (let s = startAt; ; s += 1n) {
    const sp = composeShape(s, ONE).solidProbability;
    if (want === "outline" && sp === 0n) return s;
    if (want === "solid" && sp === WAD) return s;
    if (want === "band" && sp >= (WAD * 55n) / 100n && sp <= (WAD * 75n) / 100n) return s;
  }
}

const STEPS = 20; // density slider: 0..20 -> 0%..100%
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

function frames(seed: bigint, wei: bigint): string[] {
  const out: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const density = (WAD * BigInt(i)) / BigInt(STEPS);
    out.push(uri(renderShape(seed, wei, 0n, undefined, false, density)));
  }
  return out;
}

const bandSeed = findSeed("band", 300n);
const outlineSeed = findSeed("outline", 300n);
const solidSeed = findSeed("solid", 300n);

const hero = frames(bandSeed, ONE);
const fateOutline = frames(outlineSeed, ONE);
const fateBand = frames(bandSeed, ONE);
const fateSolid = frames(solidSeed, ONE);

// Two 100 ETH with the SAME seed: only their history differs.
const apexSeed = findSeed("solid", 9000n);
const apexGhost = uri(renderShape(apexSeed, HUNDRED, 0n, undefined, false, WAD / 10000n)); // 1 origin
const apexFull = uri(renderShape(apexSeed, HUNDRED, 0n, undefined, false, WAD)); // 10,000 origins

// The dilution strip: a Complete 5 merged with a direct 5 -> a 10 at ~50% density.
const dilSeed = findSeed("solid", 5000n);
const dilA = uri(renderShape(dilSeed, DENOMINATIONS[5], 0n, undefined, false, WAD)); // Complete 5
const dilB = uri(renderShape(findSeed("band", 7000n), DENOMINATIONS[5], 0n, undefined, false, WAD / 500n)); // direct 5
const dilOut = uri(renderShape(dilSeed, DENOMINATIONS[6], 0n, undefined, false, (WAD * 501n) / 1000n)); // the 10

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shapes — ink prototype</title>
<style>
  html, body { margin: 0; background: #0d0d0c; color: #e6e4dd;
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 980px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 15px; letter-spacing: .14em; font-weight: 500; }
  p { font-size: 13px; line-height: 1.7; color: #a5a59e; max-width: 60ch; }
  .muted { color: #71716b; font-size: 11px; }
  section { margin-top: 56px; border-top: 1px solid #262622; padding-top: 32px; }
  .card { background: #000; }
  .card img { display: block; width: 100%; height: auto; }
  .row { display: flex; gap: 28px; flex-wrap: wrap; align-items: flex-start; }
  input[type=range] { width: 100%; accent-color: #e6e4dd; }
  .big { font-size: 28px; }
  figure { margin: 0; }
  figcaption { margin-top: 8px; font-size: 11px; color: #71716b; line-height: 1.5; }
</style>
<main>
  <h1>HISTORY SETS THE INK — PROTOTYPE</h1>
  <p>Same seed, same marks, same everything. The slider is the only variable: how much real
     minting is condensed inside the token. Solid marks are ink; ink is history.</p>

  <section>
    <div class="row">
      <figure style="flex:0 0 300px">
        <div class="card" style="width:300px"><img id="hero"></div>
        <figcaption>1 ETH · seed fixed at birth</figcaption>
      </figure>
      <div style="flex:1 1 320px; min-width:280px">
        <div class="big" id="label">100% condensed</div>
        <p id="sublabel">100 origins / 100 units — built entirely from 0.01 mints.</p>
        <input type="range" id="density" min="0" max="${STEPS}" value="${STEPS}">
        <div class="muted" style="display:flex;justify-content:space-between">
          <span>direct mint (ghost)</span><span>fully condensed (Complete)</span>
        </div>
      </div>
    </div>
  </section>

  <section>
    <p>Three tokens born with different fill luck, all reacting to the same history. The seed
       sets the ceiling; history spends it. A pure-outline seed never inks. An all-solid card
       needs both the lucky seed and the full history.</p>
    <div class="row">
      <figure style="flex:0 0 200px"><div class="card" style="width:200px"><img id="f0"></div>
        <figcaption>born pure-outline (5% of seeds)</figcaption></figure>
      <figure style="flex:0 0 200px"><div class="card" style="width:200px"><img id="f1"></div>
        <figcaption>born mid-band (most seeds)</figcaption></figure>
      <figure style="flex:0 0 200px"><div class="card" style="width:200px"><img id="f2"></div>
        <figcaption>born pure-solid (5% of seeds)</figcaption></figure>
    </div>
  </section>

  <section>
    <p>Two 100 ETH Shapes with the <b>same seed</b>. Left: minted directly — one origin, still
       almost just ETH. Right: condensed from ten thousand 0.01 mints. Same identity, opposite
       biographies.</p>
    <div class="row">
      <figure style="flex:0 0 260px"><div class="card" style="width:260px"><img src="${apexGhost}"></div>
        <figcaption>direct mint · density 0.01% · ghost</figcaption></figure>
      <figure style="flex:0 0 260px"><div class="card" style="width:260px"><img src="${apexFull}"></div>
        <figcaption>fully condensed · density 100% · maximum ink</figcaption></figure>
    </div>
  </section>

  <section>
    <p>Dilution is visible. A fully condensed 5 ETH merged with a direct-minted 5 ETH gives a
       10 ETH at half density: the merge is honest about what went in.</p>
    <div class="row">
      <figure style="flex:0 0 180px"><div class="card" style="width:180px"><img src="${dilA}"></div>
        <figcaption>5 ETH · Complete · 100%</figcaption></figure>
      <figure style="flex:0 0 180px"><div class="card" style="width:180px"><img src="${dilB}"></div>
        <figcaption>5 ETH · direct mint · 0.2%</figcaption></figure>
      <figure style="flex:0 0 180px"><div class="card" style="width:180px"><img src="${dilOut}"></div>
        <figcaption>the 10 ETH result · 50.1%</figcaption></figure>
    </div>
  </section>
</main>
<script>
  const hero = ${JSON.stringify(hero)};
  const f0 = ${JSON.stringify(fateOutline)};
  const f1 = ${JSON.stringify(fateBand)};
  const f2 = ${JSON.stringify(fateSolid)};
  const slider = document.getElementById("density");
  const set = () => {
    const i = Number(slider.value);
    document.getElementById("hero").src = hero[i];
    document.getElementById("f0").src = f0[i];
    document.getElementById("f1").src = f1[i];
    document.getElementById("f2").src = f2[i];
    const pct = Math.round((i / ${STEPS}) * 100);
    document.getElementById("label").textContent = pct + "% condensed";
    document.getElementById("sublabel").textContent =
      pct === 0 ? "0 extra history — a fresh direct mint. Ink cannot exceed it."
      : pct + " origins / 100 units — the seed's fill draw, scaled by " + pct + "%.";
  };
  slider.addEventListener("input", set);
  set();
</script>
`;

writeFileSync(join(here, "../public/ink-demo.html"), html);
console.log(
  `wrote public/ink-demo.html — seeds: band ${bandSeed}, outline ${outlineSeed}, solid ${solidSeed}, apex ${apexSeed}`,
);

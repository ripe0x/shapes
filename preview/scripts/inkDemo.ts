/**
 * Prototype page for the proposed "history sets the ink" rule: origin density scales the
 * seed's fill draw, so how solid a card renders reflects how much real minting is condensed
 * inside it. Generates pre-rendered frames from the canonical renderer into a static page
 * served by the dev server at /ink-demo.html. A prototype, not a committed rule.
 */
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {renderShape, composeShape, DENOMINATIONS, LABELS, GRIDS, WAD} from "../src/canonical/render";

const here = dirname(fileURLToPath(import.meta.url));
const UNIT = 10_000_000_000_000_000n; // 0.01 ETH

/** A seed whose card-level fill draw is pure solid at this denomination, so ink differences
 *  read at full contrast: with 100% history the card is fully solid; without it, outlines. */
function solidSeed(wei: bigint, startAt: bigint): bigint {
  for (let s = startAt; ; s += 1n) {
    if (composeShape(s, wei).solidProbability === WAD) return s;
  }
}

const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const card = (seed: bigint, wei: bigint, density: bigint) =>
  uri(renderShape(seed, wei, 0n, undefined, false, density));

// One row per denomination, same seed on both sides. Left: fully condensed from 0.01 mints
// (density 100%). Right: minted directly at this size (density = 1 origin / units).
const rows = DENOMINATIONS.map((wei, i) => {
  const seed = solidSeed(wei, 400n + BigInt(i) * 1000n);
  const units = wei / UNIT;
  const mints = units.toString();
  const directDensity = WAD / units; // 1 origin
  const [c, r] = GRIDS[i];
  return {
    label: LABELS[i],
    grid: `${c}×${r}`,
    mints,
    directPct: units === 1n ? "100" : Number((10000n * 100n) / units / 10000n) < 1 ? (100 / Number(units)).toFixed(Number(units) > 100 ? 2 : 1) : (100 / Number(units)).toFixed(0),
    built: card(seed, wei, WAD),
    direct: card(seed, wei, directDensity),
  };
});

// Slider playground, kept at the bottom: one 1 ETH card, density 0..100%.
const STEPS = 20;
const heroSeed = solidSeed(DENOMINATIONS[4], 300n);
const hero: string[] = [];
for (let i = 0; i <= STEPS; i++) {
  hero.push(card(heroSeed, DENOMINATIONS[4], (WAD * BigInt(i)) / BigInt(STEPS)));
}

const rowHtml = rows
  .map(
    (r) => `
  <div class="rung">
    <div class="denom"><div class="big">${r.label} ETH</div><div class="muted">${r.grid}</div></div>
    <figure><div class="card"><img src="${r.built}"></div>
      <figcaption>built up from ${r.mints === "1" ? "a 0.01 mint" : `${r.mints} × 0.01 mints`}<br>100% history → full ink</figcaption></figure>
    <figure><div class="card"><img src="${r.direct}"></div>
      <figcaption>minted directly at ${r.label} ETH<br>${r.directPct}% history → ${r.mints === "1" ? "full ink" : "outlines"}</figcaption></figure>
  </div>`,
  )
  .join("\n");

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shapes — ink prototype</title>
<style>
  html, body { margin: 0; background: #0d0d0c; color: #e6e4dd;
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 15px; letter-spacing: .14em; font-weight: 500; }
  p { font-size: 13px; line-height: 1.7; color: #a5a59e; max-width: 62ch; }
  .muted { color: #71716b; font-size: 11px; }
  .big { font-size: 22px; }
  .card { background: #000; width: 190px; }
  .card img { display: block; width: 100%; height: auto; }
  figure { margin: 0; }
  figcaption { margin-top: 8px; font-size: 11px; color: #71716b; line-height: 1.6; }
  .rung { display: flex; gap: 36px; align-items: center; padding: 26px 0;
          border-top: 1px solid #1c1c19; }
  .denom { width: 110px; flex: 0 0 110px; }
  .head { display: flex; gap: 36px; padding: 8px 0; font-size: 11px; letter-spacing: .14em;
          color: #71716b; }
  .head span:first-child { width: 110px; flex: 0 0 110px; }
  .head span { width: 190px; }
  section { margin-top: 64px; border-top: 1px solid #262622; padding-top: 32px; }
  input[type=range] { width: 100%; max-width: 420px; accent-color: #e6e4dd; }
</style>
<main>
  <h1>HISTORY SETS THE INK — THE LADDER</h1>
  <p>Every rung, same seed on both cards in a row — identical marks. The only difference is how
     the token got there. Built up from real 0.01 mints: solid. Minted directly with one
     transaction: outlines. The higher you go, the more history a solid card proves.</p>

  <div class="head"><span></span><span>THE EARNED PATH</span><span>THE BOUGHT PATH</span></div>
  ${rowHtml}

  <section>
    <p>Playground: one 1 ETH card. The slider is how much of its backing traces to real 0.01
       mints. Everything between the two columns above exists on this dial.</p>
    <div style="display:flex; gap:32px; align-items:flex-start; flex-wrap:wrap">
      <div class="card" style="width:230px"><img id="hero"></div>
      <div style="flex:1 1 300px">
        <div class="big" id="label"></div>
        <input type="range" id="density" min="0" max="${STEPS}" value="${STEPS}">
        <div class="muted" style="display:flex; justify-content:space-between; max-width:420px">
          <span>direct mint</span><span>fully built</span>
        </div>
      </div>
    </div>
  </section>
</main>
<script>
  const hero = ${JSON.stringify(hero)};
  const slider = document.getElementById("density");
  const set = () => {
    const i = Number(slider.value);
    document.getElementById("hero").src = hero[i];
    document.getElementById("label").textContent = Math.round((i / ${STEPS}) * 100) + "% built from mints";
  };
  slider.addEventListener("input", set);
  set();
</script>
`;

writeFileSync(join(here, "../public/ink-demo.html"), html);
console.log("wrote public/ink-demo.html");

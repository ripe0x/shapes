/**
 * Prototype page for the proposed inherited-ink rule ("model B"): a 0.01 mint's ink is its
 * seed's fill draw — the base tier is a lottery — and a composed token's ink is the average
 * of its inputs' inks. Purity is curated, not lucky. Generates pre-rendered cards from the
 * canonical renderer into a static page served by the dev server at /ink-demo.html.
 * A prototype, not a committed rule.
 */
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {renderShape, composeShape, DENOMINATIONS, LABELS, WAD} from "../src/canonical/render";

const here = dirname(fileURLToPath(import.meta.url));
const DUST = DENOMINATIONS[0];

const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** A seed whose card-level fill draw is pure solid at this denomination. Rendering it with
 *  inkScale = p paints exactly p of its marks solid, so it can display any inherited ink. */
function solidSeed(wei: bigint, startAt: bigint): bigint {
  for (let s = startAt; ; s += 1n) {
    if (composeShape(s, wei).solidProbability === WAD) return s;
  }
}

/** A dust seed whose own fill draw lands near the wanted ink, WAD basis points of slack. */
function dustSeedNear(want: bigint, startAt: bigint): bigint {
  for (let s = startAt; ; s += 1n) {
    const sp = composeShape(s, DUST).solidProbability;
    const d = sp > want ? sp - want : want - sp;
    if (d <= WAD / 25n) return s;
  }
}

const asCard = (seed: bigint, wei: bigint, ink?: bigint) =>
  uri(renderShape(seed, wei, 0n, undefined, false, ink));

const pct = (w: bigint) => `${Number((w * 1000n) / WAD) / 10}%`;

// The mixed hand: five dust mints straight from the lottery.
const mixedInks = [0n, (WAD * 40n) / 100n, (WAD * 60n) / 100n, (WAD * 80n) / 100n, WAD];
const mixedSeeds = mixedInks.map((w, i) => dustSeedNear(w, 500n + BigInt(i) * 400n));
const mixedActual = mixedSeeds.map((s) => composeShape(s, DUST).solidProbability);
const mixedAvg = mixedActual.reduce((a, b) => a + b, 0n) / BigInt(mixedActual.length);

// The curated hand: five pure-solid dust mints.
const pureSeeds = [0, 1, 2, 3, 4].map((i) => solidSeed(DUST, 3000n + BigInt(i) * 700n));

const card = (src: string, w: number, cap: string) =>
  `<figure style="flex:0 0 ${w}px"><div class="card" style="width:${w}px"><img src="${src}"></div><figcaption>${cap}</figcaption></figure>`;

const mixedRow = mixedSeeds
  .map((s, i) => card(asCard(s, DUST), 108, `ink ${pct(mixedActual[i])}`))
  .join("");
const pureRow = pureSeeds.map((s) => card(asCard(s, DUST), 108, "ink 100%")).join("");

const arrow = `<div style="flex:0 0 40px; text-align:center; color:#4f4f4a; font-size:20px; align-self:center">→</div>`;

const mixedResult = card(
  asCard(solidSeed(DENOMINATIONS[1], 8000n), DENOMINATIONS[1], mixedAvg),
  150,
  `0.05 ETH · inherited ink ${pct(mixedAvg)}<br>the average of what went in`,
);
const pureResult = card(
  asCard(solidSeed(DENOMINATIONS[1], 9500n), DENOMINATIONS[1], WAD),
  150,
  "0.05 ETH · inherited ink 100%<br>pure in, pure out",
);

// Purity climbing the ladder: keep feeding pure inputs, stay pure to the top.
const climb = [2, 4, 6, 8]
  .map((di, i) =>
    card(
      asCard(solidSeed(DENOMINATIONS[di], 12000n + BigInt(i) * 900n), DENOMINATIONS[di], WAD),
      140,
      `${LABELS[di]} ETH · 100%`,
    ),
  )
  .join("");

// Murk propagates too: compose two murky 0.05s and the 0.1 carries the same ink.
const murkCarry = card(
  asCard(solidSeed(DENOMINATIONS[2], 16000n), DENOMINATIONS[2], mixedAvg),
  140,
  `0.1 ETH from two murky 0.05s · still ${pct(mixedAvg)}`,
);

// The bought path: a direct mint above dust has no ancestors and no ink.
const bought = card(
  asCard(solidSeed(DENOMINATIONS[4], 18000n), DENOMINATIONS[4], 0n),
  140,
  "1 ETH minted directly · no history, no ink",
);

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shapes — inherited ink prototype</title>
<style>
  html, body { margin: 0; background: #0d0d0c; color: #e6e4dd;
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 940px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 15px; letter-spacing: .14em; font-weight: 500; }
  h2 { font-size: 11px; letter-spacing: .14em; color: #71716b; font-weight: 500;
       margin: 0 0 18px; }
  p { font-size: 13px; line-height: 1.7; color: #a5a59e; max-width: 64ch; }
  .card { background: #000; }
  .card img { display: block; width: 100%; height: auto; }
  figure { margin: 0; }
  figcaption { margin-top: 7px; font-size: 10px; color: #71716b; line-height: 1.6; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
  section { margin-top: 56px; border-top: 1px solid #262622; padding-top: 30px; }
</style>
<main>
  <h1>INHERITED INK — PROTOTYPE</h1>
  <p>0.01 mints are a lottery: each one's ink is drawn at birth, outline to solid. Composing
     averages the ink of what you feed in. Purity is curated, not lucky.</p>

  <section>
    <h2>FIVE DUST MINTS, STRAIGHT FROM THE LOTTERY → ONE 0.05</h2>
    <div class="row">${mixedRow}${arrow}${mixedResult}</div>
  </section>

  <section>
    <h2>FIVE CURATED SOLID DUST MINTS → ONE 0.05</h2>
    <div class="row">${pureRow}${arrow}${pureResult}</div>
  </section>

  <section>
    <h2>KEEP FEEDING PURE, STAY PURE TO THE TOP</h2>
    <div class="row">${climb}</div>
    <p>A solid 100 ETH means every branch of its tree was curated — ten thousand solid-leaning
       dust mints, hunted and condensed. It cannot be bought in one transaction.</p>
  </section>

  <section>
    <h2>MURK IS HONEST TOO</h2>
    <div class="row">${murkCarry}${bought}</div>
    <p>Averages carry: murky inputs make murky parents forever, unless diluted with cleaner
       ones. And a direct mint above 0.01 starts with no ancestors at all — no history,
       no ink.</p>
  </section>
</main>
`;

writeFileSync(join(here, "../public/ink-demo.html"), html);
console.log(`wrote public/ink-demo.html — mixed hand average ${pct(mixedAvg)}`);

/**
 * Render a PNG contact sheet from the command line, for visual review without
 * opening the browser harness.
 *
 *   npx tsx scripts/sheet.ts ladder out.png            -- nine-band ladder, 6 seeds each
 *   npx tsx scripts/sheet.ts band 8 out.png 40         -- 40 cards of the 100 ETH band
 *   npx tsx scripts/sheet.ts compare out.png           -- insetAll on vs off, 50 + 100 ETH
 */

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { renderShape } from "../src/canonical/render";
import { DENOMINATIONS, GRIDS, LABELS } from "../src/canonical/denominations";
import { CANONICAL, type Params } from "../src/canonical/params";
import { WAD } from "../src/canonical/wad";
import { productionSeed } from "../src/seeds";
import { geneAtMint } from "../src/canonical/ink";

const CARD_W = 210;

function card(svg: string, cap: string) {
  return `<div class="c"><div class="a">${svg.replace(
    /(<svg[^>]*?) width="[^"]*" height="[^"]*"/,
    '$1 width="100%" height="100%" style="display:block"',
  )}</div><div class="cap">${cap}</div></div>`;
}

function page(body: string, width: number) {
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#f0efec;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;padding:40px;width:${width}px}
    .row{margin-bottom:34px}
    .h{display:flex;align-items:baseline;gap:14px;border-top:1px solid #111;padding-top:9px;margin-bottom:12px}
    .den{font-size:15px;letter-spacing:.12em;font-weight:500}
    .note{font-family:ui-monospace,monospace;font-size:10.5px;color:#999;letter-spacing:.06em}
    .grid{display:flex;gap:14px}
    .c{width:${CARD_W}px}
    .a{aspect-ratio:2.5/3.5;background:#000;border-radius:5px;overflow:hidden;line-height:0}
    .cap{font-family:ui-monospace,monospace;font-size:9px;color:#aaa;text-align:center;margin-top:6px;letter-spacing:.06em}
    h1{font-size:26px;letter-spacing:.2em;font-weight:500;margin:0 0 26px}
  </style>${body}`;
}

async function shoot(html: string, out: string) {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const p = await browser.newPage({ deviceScaleFactor: 2 });
  await p.setContent(html, { waitUntil: "load" });
  const buf = await p.screenshot({ fullPage: true });
  await browser.close();
  writeFileSync(out, buf);
  console.log(`wrote ${out}`);
}

function ladderBody(perRow: number, params: Params = CANONICAL, title = "SHAPES — LADDER") {
  let body = `<h1>${title}</h1>`;
  for (let di = 0; di < 9; di++) {
    const [c, r] = GRIDS[di];
    let cards = "";
    for (let i = 0; i < perRow; i++) {
      const seed = productionSeed(BigInt(di * 100 + i + 1));
      const tokenId = BigInt(di * 100 + i + 1);
      cards += card(renderShape(seed, DENOMINATIONS[di], tokenId, geneAtMint(seed, di), params), "#" + tokenId);
    }
    body +=
      `<div class="row"><div class="h"><span class="den">${LABELS[di]} ETH</span>` +
      `<span class="note">${c}×${r} · ${c * r} ${c * r === 1 ? "module" : "modules"}</span></div>` +
      `<div class="grid">${cards}</div></div>`;
  }
  return body;
}

const mode = process.argv[2] ?? "ladder";

if (mode === "ladder") {
  const out = process.argv[3] ?? "ladder.png";
  const perRow = Number(process.argv[4] ?? 6);
  await shoot(page(ladderBody(perRow), perRow * (CARD_W + 14) + 80), out);
} else if (mode === "band") {
  const di = Number(process.argv[3]);
  const out = process.argv[4] ?? "band.png";
  const n = Number(process.argv[5] ?? 40);
  const cols = 8;
  let cards = "";
  for (let i = 0; i < n; i++) {
    const seed = productionSeed(BigInt(i + 1));
    cards += card(renderShape(seed, DENOMINATIONS[di], BigInt(i + 1), geneAtMint(seed, di), CANONICAL), "#" + (i + 1));
  }
  const body =
    `<h1>${LABELS[di]} ETH — ${n} cards</h1>` +
    `<div class="grid" style="flex-wrap:wrap">${cards}</div>`;
  await shoot(page(body, cols * (CARD_W + 14) + 80), out);
} else if (mode === "notext") {
  const out = process.argv[3] ?? "notext.png";
  const sets: [string, Params][] = [
    ["committed — with type, field centre 169", CANONICAL],
    ["no type, field unmoved at 169", { ...CANONICAL, showText: false }],
    ["no type, field recentred to 175", { ...CANONICAL, showText: false, fieldCy: 175n * 10n ** 18n }],
  ];
  let body = `<h1>CARD TYPE — with and without</h1>`;
  for (const di of [0, 3, 6, 8]) {
    for (const [label, p] of sets) {
      let cards = "";
      for (let i = 0; i < 6; i++) {
        const seed = productionSeed(BigInt(di * 100 + i + 1));
        cards += card(renderShape(seed, DENOMINATIONS[di], BigInt(i + 1), geneAtMint(seed, di), p), "#" + (i + 1));
      }
      body +=
        `<div class="row"><div class="h"><span class="den">${LABELS[di]} ETH</span>` +
        `<span class="note">${label}</span></div><div class="grid">${cards}</div></div>`;
    }
  }
  await shoot(page(body, 6 * (CARD_W + 14) + 80), out);
} else if (mode === "vocab") {
  const out = process.argv[3] ?? "vocab.png";
  const K = ["circle", "square", "triangle", "half"] as const;
  const sets: [string, Params][] = [
    ["committed — circle, square, triangle, half circle", CANONICAL],
    ["+ quarter circle", { ...CANONICAL, kinds: [...K, "quarter"] as Params["kinds"] }],
    ["+ diamond", { ...CANONICAL, kinds: [...K, "diamond"] as Params["kinds"] }],
    ["+ both", { ...CANONICAL, kinds: [...K, "quarter", "diamond"] as Params["kinds"] }],
  ];
  let body = `<h1>VOCABULARY CANDIDATES</h1>`;
  for (const di of [0, 3, 6, 8]) {
    for (const [label, p] of sets) {
      let cards = "";
      for (let i = 0; i < 6; i++) {
        const seed = productionSeed(BigInt(di * 100 + i + 1));
        cards += card(renderShape(seed, DENOMINATIONS[di], BigInt(i + 1), geneAtMint(seed, di), p), "#" + (i + 1));
      }
      body +=
        `<div class="row"><div class="h"><span class="den">${LABELS[di]} ETH</span>` +
        `<span class="note">${label}</span></div><div class="grid">${cards}</div></div>`;
    }
  }
  await shoot(page(body, 6 * (CARD_W + 14) + 80), out);
} else if (mode === "compare") {
  const out = process.argv[3] ?? "compare.png";
  const fills: [string, Params][] = [0.8, 0.92, 1.0].map((f) => [
    `cell fill ${f.toFixed(2)}${f === 0.92 ? " (committed)" : ""}`,
    { ...CANONICAL, fillMax: BigInt(Math.round(f * 1e9)) * 10n ** 9n },
  ]);
  void WAD;
  let body = `<h1>CELL FILL — how close the ink gets to the cell boundary</h1>`;
  for (const di of [0, 4, 6, 8]) {
    for (const [label, p] of fills) {
      let cards = "";
      for (let i = 0; i < 6; i++) {
        const seed = productionSeed(BigInt(di * 100 + i + 1));
        cards += card(renderShape(seed, DENOMINATIONS[di], BigInt(i + 1), geneAtMint(seed, di), p), "#" + (i + 1));
      }
      body +=
        `<div class="row"><div class="h"><span class="den">${LABELS[di]} ETH</span>` +
        `<span class="note">${label}</span></div><div class="grid">${cards}</div></div>`;
    }
  }
  await shoot(page(body, 6 * (CARD_W + 14) + 80), out);
} else {
  console.error("unknown mode");
  process.exit(1);
}

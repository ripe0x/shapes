/**
 * End-to-end check of the animation export, driven through the real standalone build.
 *
 *   npm run standalone && npm run gif:e2e
 *
 * Selects frames in a real browser, clicks export, captures the download and prints where it
 * landed so a decoder can be pointed at it. Verifies the parts a unit test cannot: canvas
 * rasterisation, the selection UI, and the download path.
 */
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gif-"));
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => m.type() === "error" && errs.push(m.text()));

await p.goto("file:///home/claude/shapes/preview/shapes-preview.html", { waitUntil: "load" });
await p.waitForTimeout(800);

await p.getByTitle(/Click cards to add them/).click();

const cards = p.locator("[data-card]");
const total = await cards.count();
console.log(`cards on page: ${total}`);

const N = 9;
for (let i = 0; i < N; i++) await cards.nth(i * 6).click();
await p.waitForTimeout(300);

const selected = await p.locator('[data-selected="true"]').count();
console.log(`selected: ${selected}`);

// deselect one, then reselect, to exercise toggling
await cards.nth(0).click();
await p.waitForTimeout(150);
console.log(`after toggle off: ${await p.locator('[data-selected="true"]').count()}`);
await cards.nth(0).click();
await p.waitForTimeout(150);

const [download] = await Promise.all([
  p.waitForEvent("download", { timeout: 120000 }),
  p.getByRole("button", { name: "export gif" }).click(),
]);
const out = join(dir, download.suggestedFilename());
await download.saveAs(out);
await p.waitForTimeout(500);
const status = await p.locator("text=/frames · /").first().textContent().catch(() => null);

console.log(`downloaded: ${download.suggestedFilename()}`);
console.log(`saved to:   ${out}`);
console.log(`status:     ${status}`);
console.log(`errors:     ${errs.length ? errs.slice(0, 3) : "none"}`);
console.log(`GIFPATH=${out}`);
await b.close();

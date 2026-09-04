/**
 * The browser end-to-end walkthrough: mint, compose, decompose, split and redeem driven through
 * the real site in Chromium, with every step checked against the chain.
 *
 * Started by `web/e2e/run.sh`, which owns the chain, the deploy and the server. Reads its targets
 * from the environment:
 *
 *   E2E_BASE_URL         origin the site is served from
 *   E2E_RPC_URL          the chain the site and this script both read
 *   E2E_DEPLOYMENT_FILE  the deployment record the site was pointed at
 *   E2E_OUT_DIR          directory for the per-step screenshots
 *
 * The chain assertions use their own minimal ABI rather than the site's, so a wrong ABI in the
 * app cannot agree with itself.
 */
import {chromium} from "playwright";
import {createPublicClient, formatEther, http, parseAbi, parseEther} from "viem";
import assert from "node:assert/strict";
import {mkdirSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {installTestWallet, TEST_WALLET_NAME} from "./wallet.mjs";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3190";
const RPC_URL = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8590";
const OUT_DIR = process.env.E2E_OUT_DIR ?? new URL("out", import.meta.url).pathname;
const deployment = JSON.parse(readFileSync(process.env.E2E_DEPLOYMENT_FILE, "utf8"));

const abi = parseAbi([
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function composeDepth(uint256 survivorId) view returns (uint256)",
  "function redeemableBacking() view returns (uint256)",
]);

const UNIT = parseEther("0.01");
const RUNG = parseEther("0.05");

const chain = {
  id: deployment.chainId,
  name: "Shapes dev chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [RPC_URL]}},
};
const publicClient = createPublicClient({chain, transport: http(RPC_URL)});
const read = (functionName, args = []) =>
  publicClient.readContract({address: deployment.shapes, abi, functionName, args});

/** Resolves to the token's owner, or null when the id is not live. */
async function ownerOrNull(tokenId) {
  try {
    return await read("ownerOf", [tokenId]);
  } catch {
    return null;
  }
}

/** The lowest live id `owner` holds at exactly `backing` wei, or null when it holds none. */
async function ownedTokenOfBacking(owner, backing) {
  const minted = await read("totalMinted");
  for (let id = 1n; id <= minted; id += 1n) {
    if ((await ownerOrNull(id)) !== owner) continue;
    if ((await read("backingOf", [id])) === backing) return id;
  }
  return null;
}

// Console noise this run accepts. Empty: the walkthrough produces none, so every console error
// and every page error fails the step it happened in.
const ALLOWED_CONSOLE = [];

let consoleErrors = [];
let stepIndex = 0;
const results = [];

/**
 * Runs one named step: screenshots it, times it, and fails it on any console or page error the
 * step produced. A failure is recorded and the walkthrough continues, so one broken step reports
 * itself without hiding the ones after it. Every step reloads the page it needs, so a step that
 * left the site crashed does not carry that state forward.
 */
async function step(page, name, body) {
  stepIndex += 1;
  const label = `${String(stepIndex).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  consoleErrors = [];
  const started = Date.now();
  try {
    await body();
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(" | ")}`);
    const ms = Date.now() - started;
    results.push({name, ms, ok: true});
    console.log(`PASS  ${name}  ${ms}ms`);
    await page.screenshot({path: join(OUT_DIR, `${label}.png`), fullPage: true});
    return true;
  } catch (error) {
    const ms = Date.now() - started;
    const noise = consoleErrors.length > 0 ? `\n      page errors: ${consoleErrors.join(" | ")}` : "";
    results.push({name, ms, ok: false, error: `${error?.message ?? error}${noise}`});
    console.log(`FAIL  ${name}  ${ms}ms\n      ${error?.message ?? error}${noise}`);
    await page.screenshot({path: join(OUT_DIR, `${label}-FAILED.png`), fullPage: true}).catch(() => {});
    return false;
  }
}

/** Loads a page and waits for the chain snapshot behind it. The footer's reserve line is rendered
 *  only once that snapshot exists, and the mint and manage actions need it. */
async function gotoApp(page, path) {
  await page.goto(`${BASE_URL}${path}`, {waitUntil: "domcontentloaded"});
  await page.getByText(/The contract holds .* ETH backing/i).first().waitFor({timeout: 60_000});
}

/** Waits for the token grid to hold exactly `expected` cards. */
function cardCount(page, expected) {
  return page.waitForFunction(
    (n) => document.querySelectorAll(".shape-token-grid .gallery-card").length === n,
    expected,
    {timeout: 60_000},
  );
}

/** Fails the step when a transaction the page submitted reverted, with the reason the chain gives
 *  for the same call. The site itself reports a reverted write as a completed one, so without this
 *  the run would only see the missing effect much later. */
async function expectSuccess(hash, operation) {
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status === "success") return receipt;
  const tx = await publicClient.getTransaction({hash});
  let reason = "no reason reported";
  try {
    await publicClient.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber: receipt.blockNumber - 1n,
    });
  } catch (error) {
    reason = error.shortMessage ?? error.message;
  }
  throw new Error(
    `the ${operation} transaction ${hash} reverted: ${reason} (gas limit ${tx.gas}, used ${receipt.gasUsed})`,
  );
}

/** The value a later step needs from an earlier one, or a failure naming what did not run. */
function required(value, description) {
  assert.ok(value !== undefined, `this step needs ${description}, which an earlier step did not produce`);
  return value;
}

/** Polls the chain until `condition` holds. Every write is submitted from the page, so a step
 *  waits for the effect on chain rather than for a UI signal the routed host may replace. */
async function untilChain(condition, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Connects the injected wallet through the site's own connect control and modal. */
async function connect(page) {
  await page.locator("button.site-connect-btn", {hasText: "CONNECT"}).click();
  await page.getByRole("button", {name: new RegExp(`${TEST_WALLET_NAME}|Injected`, "i")}).first().click();
  await page.locator("button.site-connect-btn", {hasText: /0x/}).waitFor({timeout: 20_000});
}

/** Selects `count` selectable cards in the compose workspace and opens the review screen. */
async function selectComposeSet(page, count) {
  // Clicking a selected card deselects it, so each pass takes the first card still unselected.
  const unselected = page.locator("button.compose-select-card:not([disabled]):not(.selected)");
  for (let i = 0; i < count; i += 1) {
    await unselected.first().click();
    await page.locator("button.compose-select-card.selected").nth(i).waitFor({timeout: 10_000});
  }
  await page.getByRole("button", {name: "REVIEW COMPOSITION"}).click();
}

/** Runs the review screen: picks the first candidate as survivor, submits, and returns its id. */
async function submitCompose(page) {
  const survivorCard = page.locator("button.compose-survivor-card").first();
  await survivorCard.click();
  const survivorLabel = await survivorCard.textContent();
  const survivorId = BigInt(/#(\d+)/.exec(survivorLabel)[1]);
  // The submit button stays disabled until the exact-result preview read lands; the click waits.
  await page.getByRole("button", {name: new RegExp(`COMPOSE .* SHAPE #${survivorId}`, "i")}).click();
  await untilChain(
    async () => (await read("backingOf", [survivorId])) === RUNG,
    `Shape #${survivorId} to reach 0.05 ETH`,
  );
  await page.waitForURL(new RegExp(`/shape/${survivorId}$`), {timeout: 60_000});
  return survivorId;
}

/** Opens one of the confirmation modals on a manage flow and presses its confirm button. */
async function confirmModal(page, label) {
  await page.getByRole("button", {name: label}).first().click();
  const modal = page.locator(".modal-panel");
  await modal.waitFor({timeout: 30_000});
  await modal.getByRole("button", {name: label}).click();
}

/** Opens one action on a Shape's manage page. */
async function openManageAction(page, tokenId, protocolLabel) {
  await gotoApp(page, `/shape/${tokenId}/manage`);
  const card = page.locator("button.manage-action-card:not([disabled])", {hasText: protocolLabel});
  await card.waitFor({timeout: 60_000});
  await card.click();
}

async function main() {
  rmSync(OUT_DIR, {recursive: true, force: true});
  mkdirSync(OUT_DIR, {recursive: true});

  const browser = await chromium.launch({args: ["--no-sandbox", "--disable-dev-shm-usage"]});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}});
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ALLOWED_CONSOLE.some((allowed) => allowed.test(text))) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const wallet = await installTestWallet(page, {rpcUrl: RPC_URL, chainId: deployment.chainId});
  let survivorId;
  let inputIds;
  let splitChildIds;

  try {
    await step(page, "home and connect", async () => {
      await gotoApp(page, "/");
      const header = page.locator("header.site-header").first();
      await header.waitFor({timeout: 60_000});
      const nav = (await header.locator("nav.site-nav").innerText()).split("\n").map((s) => s.trim());
      assert.deepEqual(nav, ["MINT", "GALLERY"], `header nav is ${JSON.stringify(nav)}`);
      const headerText = await header.innerText();
      assert.ok(!/CONTRACTS/.test(headerText), "header still offers CONTRACTS");
      assert.ok(!/HOW IT WORKS/.test(headerText), "header still offers HOW IT WORKS");
      await page.getByRole("button", {name: "Contracts"}).first().waitFor({timeout: 30_000});
      await connect(page);
      assert.equal(await read("balanceOf", [wallet.address]), 0n, "wallet already owns Shapes");
    });

    await step(page, "mint five", async () => {
      const supplyBefore = await read("totalSupply");
      const quantity = page.locator("input.qty-input");
      await quantity.fill("5");
      await quantity.blur();
      const mintButton = page.getByRole("button", {name: "Mint 5"});
      await mintButton.click();
      await untilChain(async () => wallet.sent.length > 0, "the mint transaction to be signed", 30_000);
      await expectSuccess(wallet.lastTransaction(), "mint");
      await page.getByText(/^5 Shapes, #\d+–#\d+$/).waitFor({timeout: 120_000});
      const minted = await page.getByText(/^5 Shapes, #\d+–#\d+$/).innerText();
      const [, first, last] = /#(\d+)–#(\d+)/.exec(minted);
      inputIds = [];
      for (let id = BigInt(first); id <= BigInt(last); id += 1n) inputIds.push(id);
      assert.equal(inputIds.length, 5, `minted ids ${first}..${last}`);
      assert.equal(await read("totalSupply"), supplyBefore + 5n, "totalSupply did not rise by 5");
      assert.equal(await read("balanceOf", [wallet.address]), 5n, "wallet does not hold 5 Shapes");
      for (const id of inputIds) {
        assert.equal(await read("backingOf", [id]), UNIT, `Shape ${id} is not backed by 0.01 ETH`);
      }
    });

    await step(page, "gallery my shapes filter", async () => {
      const supply = Number(await read("totalSupply"));
      assert.ok(supply > 5, `the chain holds ${supply} Shapes, so the owner filter proves nothing`);
      await page.locator("header.site-header nav.site-nav").getByText("GALLERY").click();
      await page.waitForURL(/\/gallery$/, {timeout: 30_000});
      await cardCount(page, supply);
      const chip = page.getByRole("button", {name: "My Shapes"});
      await chip.waitFor({timeout: 30_000});
      await chip.click();
      await cardCount(page, 5);
      const shown = await page.locator(".shape-token-grid .gallery-card").allTextContents();
      for (const id of required(inputIds, "the minted Shape ids")) {
        assert.ok(shown.some((text) => text.includes(`#${id}`)), `Shape #${id} is missing from My Shapes`);
      }
    });

    await step(page, "compose five into one", async () => {
      const redeemableBefore = await read("redeemableBacking");
      await gotoApp(page, "/my-shapes");
      await page.getByRole("button", {name: "COMPOSE"}).click();
      await selectComposeSet(page, 5);
      survivorId = await submitCompose(page);

      assert.equal(await read("backingOf", [survivorId]), RUNG, "survivor is not backed by 0.05 ETH");
      assert.equal(await read("composeDepth", [survivorId]), 1n, "survivor composeDepth is not 1");
      assert.equal(await read("balanceOf", [wallet.address]), 1n, "wallet does not hold exactly the survivor");
      for (const id of required(inputIds, "the minted Shape ids").filter((id) => id !== survivorId)) {
        assert.equal(await ownerOrNull(id), null, `absorbed Shape ${id} is still live`);
      }
      assert.equal(await read("redeemableBacking"), redeemableBefore, "compose moved redeemable backing");
    });

    await step(page, "decompose the survivor", async () => {
      required(survivorId, "the composed survivor");
      await openManageAction(page, survivorId, "Undo the last grow");
      await page.getByRole("button", {name: new RegExp(`Restore #${survivorId} and 4 absorbed`, "i")}).click();
      await untilChain(
        async () => (await read("composeDepth", [survivorId])) === 0n,
        `Shape #${survivorId} to record no compose`,
      );

      assert.equal(await read("backingOf", [survivorId]), UNIT, "survivor is not back to 0.01 ETH");
      assert.equal(await read("composeDepth", [survivorId]), 0n, "survivor still records a compose");
      for (const id of inputIds) {
        assert.equal(await ownerOrNull(id), wallet.address, `Shape ${id} did not return to the wallet`);
      }
      assert.equal(await read("balanceOf", [wallet.address]), 5n, "wallet does not hold the five inputs again");
    });

    await step(page, "compose again and split", async () => {
      // Composes a fresh 0.05 parent unless the wallet still holds one, which it does when the
      // decompose step above did not run its undo.
      let parentId = await ownedTokenOfBacking(wallet.address, RUNG);
      if (parentId === null) {
        await gotoApp(page, "/my-shapes");
        await page.getByRole("button", {name: "COMPOSE"}).click();
        await selectComposeSet(page, 5);
        parentId = await submitCompose(page);
      }
      assert.equal(await read("backingOf", [parentId]), RUNG, "the parent is not backed by 0.05 ETH");

      await openManageAction(page, parentId, "Break into smaller Shapes");
      await confirmModal(page, `Split #${parentId} into 5 new Shapes`);
      await untilChain(
        async () => (await ownerOrNull(parentId)) === null,
        `Shape #${parentId} to be burned by the split`,
      );
      await page.waitForURL(/\/gallery$/, {timeout: 60_000});

      assert.equal(await ownerOrNull(parentId), null, `the split parent ${parentId} is still live`);
      assert.equal(await read("balanceOf", [wallet.address]), 5n, "the split did not leave five children");
      const minted = await read("totalMinted");
      splitChildIds = [];
      for (let id = minted; splitChildIds.length < 5 && id > 0n; id -= 1n) {
        if ((await ownerOrNull(id)) === wallet.address) splitChildIds.unshift(id);
      }
      assert.equal(splitChildIds.length, 5, "could not find the five children on chain");
      let total = 0n;
      for (const id of splitChildIds) total += await read("backingOf", [id]);
      assert.equal(total, RUNG, `children sum to ${formatEther(total)} ETH, not 0.05`);
    });

    await step(page, "redeem one Shape", async () => {
      const tokenId = required(splitChildIds, "the Shapes the split produced")[0];
      const balanceBefore = await publicClient.getBalance({address: wallet.address});
      await openManageAction(page, tokenId, "Redeem its ETH");
      await confirmModal(page, `Redeem #${tokenId}`);
      await untilChain(
        async () => (await ownerOrNull(tokenId)) === null,
        `Shape #${tokenId} to be burned by the redeem`,
      );
      await page.waitForURL(new RegExp(`/shape/${tokenId}$`), {timeout: 60_000});

      const receipt = await publicClient.getTransactionReceipt({hash: wallet.lastTransaction()});
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const balanceAfter = await publicClient.getBalance({address: wallet.address});
      assert.equal(balanceAfter - balanceBefore, UNIT - gas, "the wallet did not gain 0.01 ETH less gas");
      assert.equal(await ownerOrNull(tokenId), null, `redeemed Shape ${tokenId} is still live`);
      assert.equal(await read("balanceOf", [wallet.address]), 4n, "the wallet does not hold the four Shapes left");
    });

    await step(page, "contracts page read", async () => {
      await gotoApp(page, "/contracts");
      const search = page.getByPlaceholder("Search functions…");
      await search.waitFor({timeout: 60_000});
      await search.fill("symbol");
      const call = page.getByRole("button", {name: "CALL"}).first();
      await call.click();
      const result = page.locator("pre", {hasText: "SHAPE"}).first();
      await result.waitFor({timeout: 30_000});
      assert.match(await result.innerText(), /SHAPE/, "symbol() did not read back SHAPE");
      assert.equal(await read("symbol"), "SHAPE", "the contract does not report SHAPE");
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

let crashed = null;
try {
  await main();
} catch (error) {
  crashed = error;
  console.log(`the walkthrough itself failed: ${error?.stack ?? error}`);
}

console.log("\nsummary");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ms}ms${r.ok ? "" : `  ${r.error}`}`);
console.log(`\nscreenshots: ${OUT_DIR}`);
process.exit(crashed || results.some((r) => !r.ok) ? 1 : 0);

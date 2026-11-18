/** Returning-wallet and rejected-view checks against an actual local production build/fork. */
import assert from "node:assert/strict";
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {chromium} from "playwright";
import {createPublicClient, http} from "viem";
import {installTestWallet, TEST_WALLET_NAME} from "./wallet.mjs";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3205";
const rpcUrl = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8597";
for (const url of [base, rpcUrl]) assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
assert.equal(await createPublicClient({transport: http(rpcUrl)}).getChainId(), 1);
const browser = await chromium.launch({headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROME_PATH} : {})});
const results = [];
const errors = [];
const account = page => page.locator(".site-account .site-connect-btn");
const walletOption = page => page.getByRole("button", {name: new RegExp(`${TEST_WALLET_NAME}|Injected`, "i")}).first();
async function connected(page) { await account(page).and(page.locator('[aria-haspopup="menu"]')).waitFor(); }
async function connect(page) {
  await page.locator('.site-header[data-wallet-ready="true"]').waitFor();
  await account(page).click();
  await walletOption(page).click();
  await connected(page);
}
async function navigate(page, name, path) {
  await page.locator(".site-header").getByRole("link", {name, exact: true}).click();
  await page.waitForURL(url => url.pathname === path);
}
async function check(name, run) {
  await run(); results.push(name); console.log(`PASS ${name}`);
}

function holdWalletAccounts() {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.__releaseAccounts = release;
    window.__accountsWaiting = 0;
    window.__accountsResolved = 0;
    const wrapped = new WeakSet();
    const wrap = provider => {
      if (!provider || wrapped.has(provider)) return;
      wrapped.add(provider);
      const request = provider.request.bind(provider);
      provider.request = async args => {
        // Delay the real wallet's reply; never supply a synthetic successful answer.
        if (args.method === "eth_accounts") {
          window.__accountsWaiting++; await gate;
          const result = await request(args); window.__accountsResolved++; return result;
        }
        return request(args);
      };
    };
    wrap(window.ethereum);
    window.addEventListener("eip6963:announceProvider", event => wrap(event.detail.provider));
}

try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  let page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  const wallet = await installTestWallet(page, {rpcUrl, chainId: 1});
  await page.goto(base, {waitUntil: "domcontentloaded"});
  await connect(page);
  await check("Saved wallet renders immediately and early Connect waits for successful reconnection", async () => {
    assert.ok((await context.cookies()).some(c => c.name === "wagmi.store" && c.value.toLowerCase().includes(wallet.address.toLowerCase())));
    await page.addInitScript(() => {
      window.__firstFullAccount = undefined;
      new MutationObserver(() => {
        if (window.__firstFullAccount !== undefined) return;
        const header = document.querySelector('.site-header[data-wallet-ready="true"]');
        if (header) window.__firstFullAccount = header.querySelector('.site-connect-btn[aria-haspopup="menu"]') !== null;
      }).observe(document, {subtree: true, childList: true, attributes: true});
    });
    await page.addInitScript(holdWalletAccounts);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", {cacheDisabled: true});
    await cdp.send("Network.emulateNetworkConditions", {offline: false, latency: 100, downloadThroughput: 200000, uploadThroughput: 100000});
    await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4});
    await page.reload({waitUntil: "domcontentloaded"});
    await page.locator(".mint-panel").waitFor();
    assert.equal(await page.locator('.site-header[data-wallet-ready="true"]').count(), 0);
    await page.locator(".mint-panel").getByRole("button", {name: "Connect wallet", exact: true}).click();
    await page.waitForFunction(() => window.__accountsWaiting > 0);
    await connected(page);
    assert.equal(await page.evaluate(() => window.__firstFullAccount), true);
    assert.equal(await walletOption(page).count(), 0);
    await page.evaluate(() => window.__releaseAccounts());
    await page.waitForFunction(() => window.__accountsResolved > 0);
    // Observe after the real provider's replies have reached Wagmi/RainbowKit.
    await page.waitForTimeout(1000);
    await connected(page);
    assert.equal(await walletOption(page).count(), 0, "Successful reconnect opened an unnecessary modal");
    assert.equal(wallet.sent.length, 0);
  });

  await page.close();
  page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  // A new real wallet instance has no authorization; the site's saved connection remains.
  const lockedWallet = await installTestWallet(page, {rpcUrl, chainId: 1});
  await page.addInitScript(holdWalletAccounts);
  await check("One early Connect survives unsuccessful saved-wallet reconnection", async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", {cacheDisabled: true});
    await cdp.send("Network.emulateNetworkConditions", {offline: false, latency: 100, downloadThroughput: 200000, uploadThroughput: 100000});
    await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4});
    await page.goto(base, {waitUntil: "domcontentloaded"});
    const panel = page.locator(".mint-panel");
    await panel.waitFor();
    assert.equal(await page.locator('.site-header[data-wallet-ready="true"]').count(), 0);
    await panel.getByRole("button", {name: "Connect wallet", exact: true}).click();
    await page.waitForFunction(() => window.__accountsWaiting > 0);
    await page.locator('.site-header[data-wallet-ready="true"]').waitFor();
    // The saved account is temporarily visible while the real connector is still deciding.
    await connected(page);
    assert.equal(await walletOption(page).count(), 0);
    await page.evaluate(() => window.__releaseAccounts());
    await walletOption(page).click({timeout: 30_000});
    await connected(page);
    assert.equal(lockedWallet.sent.length, 0);
  });
  await context.close();

  await check("Rejected Gallery download preserves wallet/navigation and Reload recovers", async () => {
    const failed = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await failed.newPage();
    page.on("pageerror", e => errors.push(e.message));
    const wallet = await installTestWallet(page, {rpcUrl, chainId: 1});
    const chunks = new URL("../.next/static/chunks/", import.meta.url);
    const files = readdirSync(chunks).filter(name => name.endsWith(".js") && readFileSync(new URL(name, chunks), "utf8").includes("gallery-grid"));
    assert.ok(files.length > 0, "Cannot identify the built Gallery download");
    let blocked = 0;
    for (const file of files) await page.route(`**/_next/static/chunks/${file}`, async route => { blocked++; await route.abort("failed"); });
    await page.goto(base, {waitUntil: "domcontentloaded"});
    await connect(page);
    await navigate(page, "GALLERY", "/gallery");
    await page.getByRole("alert").filter({hasText: "This page couldn’t load."}).waitFor();
    assert.ok(blocked > 0);
    assert.equal(await page.locator(".site-header").count(), 1);
    await connected(page);
    await navigate(page, "MINT", "/mint");
    await page.locator(".mint-panel .qty-input").waitFor();
    await connected(page);
    await page.goBack();
    await page.waitForURL(url => url.pathname === "/gallery");
    await page.getByRole("alert").filter({hasText: "This page couldn’t load."}).waitFor();
    await connected(page);
    await page.unrouteAll({behavior: "wait"});
    // Reload discards React.lazy's cached rejection and requests the actual recovered asset.
    await page.getByRole("button", {name: "Reload", exact: true}).click();
    await page.locator(".gallery-grid").waitFor({timeout: 30_000});
    await connected(page);
    await navigate(page, "PACKS", "/packs");
    await connected(page);
    await navigate(page, "SHAPES", "/");
    await page.locator(".mint-panel").waitFor();
    await connected(page);
    assert.equal(wallet.sent.length, 0);
    await failed.close();
  });
  assert.deepEqual(errors, [], "Uncaught runtime errors");
  const output = {ok: true, results, transactions: 0, errors};
  if (process.env.REGRESSION_OUTPUT) writeFileSync(process.env.REGRESSION_OUTPUT, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally { await browser.close(); }

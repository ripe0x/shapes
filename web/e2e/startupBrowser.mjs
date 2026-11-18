/** Startup/navigation regression check against a local production build and real local mainnet fork. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {chromium} from "playwright";
import {createPublicClient, formatEther, http, parseAbi, parseEther} from "viem";
import {installTestWallet, TEST_WALLET_NAME} from "./wallet.mjs";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3197";
const rpcUrl = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8597";
const isLoopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
assert.ok(isLoopback(baseUrl) && isLoopback(rpcUrl), "Startup checks require a local site and fork RPC");
const client = createPublicClient({transport: http(rpcUrl)});
assert.equal(await client.getChainId(), 1, "This check expects a real local mainnet fork");

const browser = await chromium.launch({headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROME_PATH} : {})});
const pageErrors = [];
const observe = (page) => page.on("pageerror", (error) => pageErrors.push(error.message));
const results = [];
async function check(name, body) {
  const start = Date.now();
  await body();
  results.push({name, ms: Date.now() - start});
  console.log(`PASS ${name} (${Date.now() - start}ms)`);
}
const accountButton = (page) => page.locator(".site-account .site-connect-btn");
async function connected(page, address) {
  await page.waitForFunction((prefix) => {
    const button = document.querySelector(".site-account .site-connect-btn");
    return button && !button.disabled && button.getAttribute("aria-haspopup") === "menu" &&
      button.textContent.toLowerCase().includes(prefix);
  }, address.slice(0, 6).toLowerCase(), {timeout: 30_000});
}
async function disconnected(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector(".site-account .site-connect-btn");
    return button && !button.disabled && button.textContent.trim() === "CONNECT WALLET";
  }, undefined, {timeout: 30_000});
}
async function navigate(page, label, path) {
  await page.locator(".site-header").getByRole("link", {name: label, exact: true}).click();
  await page.waitForURL((url) => url.pathname === path);
}

try {
  await check("Public HTML has working navigation without JavaScript", async () => {
    const context = await browser.newContext({javaScriptEnabled: false, viewport: {width: 1280, height: 800}});
    const page = await context.newPage();
    const response = await page.goto(baseUrl, {waitUntil: "domcontentloaded"});
    assert.equal(response.status(), 200);
    for (const [label, href] of [["SHAPES", "/"], ["MINT", "/mint"], ["GALLERY", "/gallery"], ["PACKS", "/packs"], ["FWA", "/fwa"]]) {
      assert.equal(await page.locator(".site-header").getByRole("link", {name: label, exact: true}).getAttribute("href"), href);
    }
    assert.equal(await accountButton(page).isDisabled(), true);
    assert.equal(await page.locator(".mint-panel").count(), 0);
    await navigate(page, "GALLERY", "/gallery");
    assert.equal(await page.locator(".site-header").count(), 1);
    await context.close();
  });

  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await context.newPage();
  observe(page);
  const wallet = await installTestWallet(page, {rpcUrl, chainId: 1});
  await check("Actual wallet modal connects the real local wallet", async () => {
    await page.goto(baseUrl, {waitUntil: "domcontentloaded"});
    await disconnected(page);
    await accountButton(page).click();
    await page.getByRole("button", {name: new RegExp(`${TEST_WALLET_NAME}|Injected`, "i")}).first().click();
    await connected(page, wallet.address);
  });
  await check("Mint quotes preserve actual backing and fees for quantities one and two", async () => {
    const deployment = JSON.parse(readFileSync(new URL("../public/deployment.json", import.meta.url), "utf8"));
    const abi = parseAbi(["function unit() view returns (uint256)", "function mintFee() view returns (uint256)"]);
    const blockNumber = await client.getBlockNumber();
    const [unit, fee] = await Promise.all(["unit", "mintFee"].map((functionName) =>
      client.readContract({address: deployment.shapes, abi, functionName, blockNumber})));
    assert.equal(unit, parseEther("0.01"), "Mainnet smallest denomination changed");
    await navigate(page, "MINT", "/mint");
    await page.locator(".mint-panel").waitFor();
    const quoteValue = async (label) => {
      const text = await page.locator(".mint-panel").getByText(label, {exact: true})
        .evaluate((element) => element.nextElementSibling.textContent.trim());
      const match = text.match(/^(\d+(?:\.\d+)?) ETH\b/);
      assert.ok(match, `Missing ETH amount for ${label}: ${text}`);
      return parseEther(match[1]);
    };
    const assertQuote = async (quantity) => {
      const amounts = {backing: unit * quantity, "mint fee": fee * quantity, total: (unit + fee) * quantity};
      await page.waitForFunction((expected) => Object.entries(expected).every(([label, value]) => {
        const element = [...document.querySelectorAll(".mint-panel div")].find((node) => node.textContent === label);
        return element?.nextElementSibling?.textContent.trim().startsWith(`${value} ETH`);
      }), Object.fromEntries(Object.entries(amounts).map(([label, value]) => [label, formatEther(value)])));
      for (const [label, amount] of Object.entries(amounts)) assert.equal(await quoteValue(label), amount, `${quantity} Shape(s): ${label}`);
    };
    const quantity = page.locator(".mint-panel .qty-input");
    assert.equal(await quantity.inputValue(), "1");
    await assertQuote(1n);
    await quantity.fill("2");
    await quantity.blur();
    await assertQuote(2n);
    await quantity.fill("1");
    await quantity.blur();
    await assertQuote(1n);
    assert.equal(wallet.sent.length, 0, "Quote inspection must not submit transactions");
    console.log(`Quote verified at local fork block ${blockNumber}: backing ${formatEther(unit)} ETH, fee ${formatEther(fee)} ETH per Shape`);
    await navigate(page, "SHAPES", "/");
  });
  await check("Wallet persists through header navigation and browser history", async () => {
    for (const [label, path] of [["GALLERY", "/gallery"], ["PACKS", "/packs"], ["MINT", "/mint"], ["SHAPES", "/"]]) {
      await navigate(page, label, path);
      await connected(page, wallet.address);
    }
    await page.goBack({waitUntil: "domcontentloaded"});
    await page.waitForURL((url) => url.pathname === "/mint");
    await connected(page, wallet.address);
    await page.goForward({waitUntil: "domcontentloaded"});
    await page.waitForURL((url) => url.pathname === "/");
    await connected(page, wallet.address);
  });
  await check("Reload restores the connection cookie before the app mounts", async () => {
    assert.ok((await context.cookies()).some((cookie) => cookie.name === "wagmi.store" &&
      cookie.value.toLowerCase().includes(wallet.address.toLowerCase())), "Connected wallet was not persisted");
    await page.reload({waitUntil: "domcontentloaded"});
    await connected(page, wallet.address);
  });
  await check("Docs round trip keeps the wallet connected", async () => {
    await page.getByRole("link", {name: "Docs", exact: true}).click();
    await page.waitForURL((url) => url.pathname === "/docs");
    await page.locator(".docs-main").waitFor();
    await navigate(page, "SHAPES", "/");
    await connected(page, wallet.address);
  });
  await check("Mobile menu navigates and releases its scroll lock", async () => {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole("button", {name: "Menu", exact: true}).click();
    await page.locator(".site-mobile-nav-panel").getByRole("button", {name: "PACKS", exact: true}).click();
    await page.waitForURL((url) => url.pathname === "/packs");
    await connected(page, wallet.address);
    await page.waitForFunction(() => document.body.style.overflow !== "hidden" &&
      document.querySelector(".site-mobile-nav-toggle")?.getAttribute("aria-expanded") === "false");
    await page.setViewportSize({width: 1280, height: 800});
  });
  await check("Another browser context receives no wallet state", async () => {
    const guest = await browser.newContext({viewport: {width: 1280, height: 800}});
    const guestPage = await guest.newPage();
    observe(guestPage);
    await guestPage.goto(baseUrl, {waitUntil: "domcontentloaded"});
    await disconnected(guestPage);
    assert.equal((await guest.cookies()).some((cookie) => cookie.value.toLowerCase().includes(wallet.address.toLowerCase())), false);
    await guest.close();
  });
  await check("Disconnect remains disconnected after reload", async () => {
    await accountButton(page).click();
    await page.getByRole("menuitem", {name: "DISCONNECT", exact: true}).click();
    await disconnected(page);
    await page.reload({waitUntil: "domcontentloaded"});
    await disconnected(page);
    assert.equal(wallet.sent.length, 0, "Startup/navigation must not send transactions");
  });
  await context.close();

  await check("RPC failure retains public navigation and retry recovers against the real RPC", async () => {
    const failed = await browser.newContext({viewport: {width: 1280, height: 800}});
    const failedPage = await failed.newPage();
    observe(failedPage);
    let aborted = 0;
    const abortRpc = async (route) => {
      const request = route.request();
      let body;
      try { body = request.postDataJSON(); } catch { /* Other assets have no JSON body. */ }
      const calls = Array.isArray(body) ? body : [body];
      if (request.method() === "POST" && calls.some((call) => call?.jsonrpc === "2.0")) {
        aborted += 1;
        await route.abort("failed");
      } else await route.continue();
    };
    await failed.route("**/*", abortRpc);
    await failedPage.goto(`${baseUrl}/mint`, {waitUntil: "domcontentloaded"});
    await failedPage.locator(".site-startup-status[role=alert]").waitFor({timeout: 45_000});
    assert.ok(aborted > 0, "The test did not reach a real RPC request");
    assert.equal(await accountButton(failedPage).isDisabled(), true);
    assert.equal(await failedPage.locator(".mint-panel").count(), 0);
    await navigate(failedPage, "GALLERY", "/gallery");
    await navigate(failedPage, "MINT", "/mint");
    assert.equal(await failedPage.locator(".mint-panel").count(), 0);
    await failed.unroute("**/*", abortRpc);
    await failedPage.getByRole("button", {name: "Retry", exact: true}).click();
    await disconnected(failedPage);
    await failedPage.locator(".mint-panel").waitFor({timeout: 30_000});
    await failed.close();
  });
  assert.deepEqual(pageErrors, [], "Browser runtime errors");
  console.log(JSON.stringify({ok: true, results}, null, 2));
} finally {
  await browser.close();
}

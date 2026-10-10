/** Read-only browser check against a local Sepolia site build. Wallet signing is disabled. */
import assert from "node:assert/strict";
import {chromium} from "playwright";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3191";
const owner = "0xCB43078C32423F5348Cab5885911C3B5faE217F9";
const browser = await chromium.launch({headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROME_PATH} : {})});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", (response) => {if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);});

await page.addInitScript(({address}) => {
  const listeners = new Map();
  const provider = {
    request: async ({method}) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "net_version") return "11155111";
      if (method === "eth_sendTransaction" || method.startsWith("personal_sign") || method.startsWith("eth_sign")) {
        throw new Error("This browser check cannot sign or send transactions.");
      }
      throw new Error(`Read-only wallet does not support ${method}`);
    },
    on(event, handler) {const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); return provider;},
    removeListener(event, handler) {listeners.get(event)?.delete(handler); return provider;},
  };
  const info = {uuid: "76e08320-0d37-4d3a-af95-bb9ba6227c52", name: "Read-only Packs Wallet",
    rdns: "wtf.ripe.shapes.packs-read-only", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"};
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {detail: Object.freeze({info, provider})}));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, {address: owner});

try {
  const guest = await browser.newPage({viewport: {width: 1280, height: 800}});
  await guest.goto(`${baseUrl}/packs`, {waitUntil: "domcontentloaded"});
  await guest.locator("button.site-connect-btn").getByText("CONNECT WALLET", {exact: true}).waitFor();
  await guest.locator(".packs-page").getByRole("button", {name: "CONNECT WALLET", exact: true}).waitFor();
  await guest.setViewportSize({width: 390, height: 844});
  await guest.getByRole("button", {name: "Menu"}).click();
  await guest.locator(".site-mobile-nav-panel").getByRole("button", {name: "CONNECT WALLET", exact: true}).waitFor();
  await guest.close();

  await page.goto(`${baseUrl}/packs`, {waitUntil: "domcontentloaded"});
  await page.waitForFunction(() => /Minimum new pack backing:|new Sepolia Packs deployment is not visible/.test(document.body.innerText),
    undefined, {timeout: 60_000});
  assert.equal(await page.title(), "Shape Packs · Shapes");
  const pending = await page.getByText(/new Sepolia Packs deployment is not visible/).count() > 0;
  if (pending) {
    await page.getByRole("button", {name: "RETRY"}).waitFor();
    assert.equal(await page.getByRole("button", {name: "MERGE PACKS"}).count(), 0);
    assert.equal(await page.locator(".packs-builder-grid").count(), 0);
    console.log("PASS Sepolia browser: supplied deployment has no bytecode; pending state and retry are visible");
  } else {
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".packs-denomination-thumb img")];
      return images.length === 9 && images.every((image) => image.complete && image.naturalWidth > 0);
    }, undefined, {timeout: 60_000});
    assert.deepEqual((await page.locator(".site-section-label").allTextContents()).filter((label) =>
      ["BUILD A PACK", "YOUR PACKS", "YOUR SHAPES"].includes(label)), ["BUILD A PACK", "YOUR PACKS", "YOUR SHAPES"]);
    await page.setViewportSize({width: 3015, height: 900});
    assert.ok((await page.locator(".packs-builder-grid").boundingBox()).width <= 1221);
    const previewBox = await page.locator(".packs-preview-panel").boundingBox();
    const formBox = await page.locator(".packs-builder-form").boundingBox();
    assert.ok(previewBox.x + previewBox.width < formBox.x);
    await page.setViewportSize({width: 1280, height: 800});

    const liveCards = page.locator(".packs-card").filter({hasText: /LIVE ·/});
    const liveCount = await liveCards.count();
    if (liveCount > 0) {
      await liveCards.first().click();
      assert.equal(await page.locator(".packs-detail-heading .packs-art img").count(), 1);
      assert.equal(await page.getByRole("button", {name: "UNSEAL FOR CHUNKED EXIT"}).count(), 0);
      await page.getByRole("button", {name: "REDEEM · ETH"}).click();
      await page.getByText("Redeem burns every Shape and pays its backing in ETH to your wallet.").waitFor();
      if (liveCount > 1) {
        const sourceGroup = page.getByRole("group", {name: "Source packs to merge"});
        assert.equal(await sourceGroup.getByRole("button").count(), liveCount - 1);
        const source = sourceGroup.getByRole("button").first();
        await source.click();
        assert.equal(await source.getAttribute("aria-pressed"), "true");
        assert.equal(await page.getByRole("button", {name: "MERGE PACKS"}).isEnabled(), true);
        await source.click();
      }
    } else {
      await page.getByText("This wallet has no live packs or unfinished pack claims.").waitFor();
    }

    const thumbs = page.locator(".packs-denomination-thumb img");
    const initialSample = await thumbs.first().getAttribute("src");
    const untouchedSample = await thumbs.nth(1).getAttribute("src");
    const input = page.locator("#packs-denom-0");
    await input.fill("3");
    assert.equal(await page.locator(".packs-preview-card").count(), 3);
    const samples = await page.locator(".packs-preview-card img").evaluateAll((images) => images.map((image) => image.src));
    assert.equal(new Set(samples).size, 3);
    assert.notEqual(await thumbs.first().getAttribute("src"), initialSample);
    assert.equal(await thumbs.nth(1).getAttribute("src"), untouchedSample);
    await page.locator(".packs-denomination .btn-outline").nth(1).click();
    assert.equal(await input.inputValue(), "4");
    assert.equal(await page.locator(".packs-preview-card").count(), 4);
    if (process.env.E2E_SCREENSHOT_DESKTOP) await page.screenshot({path: process.env.E2E_SCREENSHOT_DESKTOP, fullPage: true});
    console.log(`PASS Sepolia browser: ${liveCount} owned live packs, samples, preview, available merge choices, desktop layout`);
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole("button", {name: "Menu"}).click();
  await page.locator(".site-mobile-nav-panel").getByRole("button", {name: "PACKS"}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.E2E_SCREENSHOT) await page.screenshot({path: process.env.E2E_SCREENSHOT, fullPage: true});
  assert.deepEqual(errors.filter((error) => !error.includes("429 https://gateway.tenderly.co/public/sepolia") &&
    !error.includes("server responded with a status of 429")), []);
} finally {
  await browser.close();
}

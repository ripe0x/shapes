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
  await page.getByText(/minimum new pack backing: 0\.0003 ETH/i).waitFor({timeout: 60_000});
  assert.equal(await page.title(), "Shape Packs · Shapes");
  await page.getByText("YOUR PACKS").waitFor({timeout: 60_000});
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(".packs-denomination-thumb img")];
    return images.length === 9 && images.every((image) => image.complete && image.naturalWidth > 0);
  }, undefined, {timeout: 60_000});
  assert.equal(await page.locator(".packs-group-label").count(), 0);
  await page.setViewportSize({width: 3015, height: 900});
  assert.ok((await page.locator(".packs-builder-grid").boundingBox()).width <= 1221);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.E2E_SCREENSHOT_WIDE) await page.screenshot({path: process.env.E2E_SCREENSHOT_WIDE, fullPage: true});
  await page.setViewportSize({width: 1280, height: 800});
  assert.deepEqual((await page.locator(".site-section-label").allTextContents()).filter((label) =>
    ["BUILD A PACK", "YOUR PACKS", "YOUR SHAPES"].includes(label)), ["BUILD A PACK", "YOUR PACKS", "YOUR SHAPES"]);
  const packCard = page.getByRole("button", {name: /Shape Pack 3.*LIVE/});
  await packCard.waitFor({timeout: 60_000});
  assert.equal(await packCard.locator(".packs-art img").evaluate((img) => img.complete && img.naturalWidth > 0), true);
  await packCard.click();
  await page.getByRole("heading", {name: "Shape Pack 3"}).waitFor();
  assert.equal(await page.locator(".packs-detail-heading .packs-art img").evaluate((img) => img.complete && img.naturalWidth > 0), true);
  await page.getByText(/backing/i).first().waitFor();
  const chunkedExit = page.getByRole("button", {name: "UNSEAL FOR CHUNKED EXIT"});
  assert.equal(await chunkedExit.count(), 0);
  const failLargeExitEstimate = async (route) => {
    const request = route.request().postDataJSON();
    if (request?.method !== "eth_estimateGas") return route.continue();
    return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
      jsonrpc: "2.0", id: request.id, error: {code: -32000, message: "gas required exceeds allowance"},
    })});
  };
  await page.route("https://gateway.tenderly.co/public/sepolia", failLargeExitEstimate);
  await page.getByRole("button", {name: "OPEN PACK"}).click();
  await chunkedExit.waitFor();
  assert.equal(await page.getByRole("button", {name: "OPEN PACK"}).count(), 0);
  await page.getByRole("button", {name: "OPEN · SHAPES"}).click();
  assert.equal(await chunkedExit.count(), 1);
  await page.unroute("https://gateway.tenderly.co/public/sepolia", failLargeExitEstimate);
  await page.getByRole("button", {name: "REDEEM · ETH"}).click();
  await page.getByText("Redeem burns every Shape and pays its backing in ETH to your wallet.").waitFor();
  assert.equal(await chunkedExit.count(), 0);
  await page.getByRole("button", {name: "REDEEM PACK"}).waitFor();
  await page.getByRole("button", {name: "CREATE", exact: true}).click();
  const denominationInputs = page.locator(".packs-denomination-groups input");
  assert.equal(await denominationInputs.count(), 9);
  await denominationInputs.first().fill("3");
  await page.getByText("0.00033 ETH").waitFor({timeout: 30_000});
  assert.equal(await page.locator(".packs-preview-card").count(), 3);
  assert.equal(await page.locator(".packs-draft-art").getAttribute("aria-label"), "3 Shapes in draft pack");
  await page.locator(".packs-denomination .btn-outline").nth(1).click();
  assert.equal(await denominationInputs.first().inputValue(), "4");
  await page.locator(".packs-denomination .btn-outline").first().click();
  assert.equal(await denominationInputs.first().inputValue(), "3");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) =>
    button.textContent?.trim() === "CREATE PACK" && !button.disabled), undefined, {timeout: 30_000});
  assert.equal(await page.getByRole("button", {name: "CREATE PACK"}).isEnabled(), true);
  await page.getByRole("group", {name: "Pack action"}).getByRole("button", {name: "ADD TO PACK"}).click();
  await page.getByRole("group", {name: "Pack destination"}).getByRole("button", {name: "Shape Pack 3"}).click();
  assert.equal(await page.getByRole("button", {name: "ADD TO PACK"}).last().isEnabled(), true);
  const draftBeforeOwned = Number((await page.locator(".packs-draft-art").getAttribute("aria-label")).split(" ")[0]);
  await page.waitForFunction(() => !document.body.innerText.includes("Reading your Shapes…"), undefined, {timeout: 90_000});
  const shapePick = page.locator(".packs-picks .compose-select-card").first();
  await shapePick.click();
  assert.equal(await shapePick.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".packs-draft-art").getAttribute("aria-label"), `${draftBeforeOwned + 1} Shapes in draft pack`);
  await page.getByRole("group", {name: "Pack destination"}).getByRole("button", {name: "NEW PACK"}).click();
  await page.getByRole("button", {name: "CREATE PACK"}).waitFor();
  await denominationInputs.first().fill("0");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) =>
    button.textContent?.trim() === "CREATE PACK" && !button.disabled), undefined, {timeout: 30_000});
  assert.equal(await page.locator(".packs-draft-art").getAttribute("aria-label"), "1 Shape in draft pack");
  await shapePick.click();
  assert.equal(await shapePick.getAttribute("aria-pressed"), "false");
  if (process.env.E2E_SCREENSHOT_DESKTOP) await page.screenshot({path: process.env.E2E_SCREENSHOT_DESKTOP, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole("button", {name: "Menu"}).click();
  await page.locator(".site-mobile-nav-panel").getByRole("button", {name: "PACKS"}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.E2E_SCREENSHOT) await page.screenshot({path: process.env.E2E_SCREENSHOT, fullPage: true});
  await page.setViewportSize({width: 320, height: 700});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  // Public Tenderly can rate-limit a retried read; the checks above require recovered data.
  assert.deepEqual(errors.filter((error) => !error.includes("429 https://gateway.tenderly.co/public/sepolia") &&
    !error.includes("server responded with a status of 429")), []);
  console.log("PASS Sepolia browser: navigation, wallet, pack artwork, selection, conditional chunked exit, steppers, exact quote, mobile layout");
} finally {
  await browser.close();
}

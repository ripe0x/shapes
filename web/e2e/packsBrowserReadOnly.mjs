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
  await page.goto(`${baseUrl}/packs`, {waitUntil: "domcontentloaded"});
  await page.getByText(/minimum new pack backing: 0\.0003 ETH/i).waitFor({timeout: 60_000});
  assert.equal(await page.title(), "Shape Packs · Shapes");
  await page.getByText("YOUR PACKS").waitFor({timeout: 60_000});
  const packCard = page.getByRole("button", {name: /Shape Pack 3.*PACK #3/});
  await packCard.waitFor({timeout: 60_000});
  assert.equal(await packCard.locator(".packs-art img").evaluate((img) => img.complete && img.naturalWidth > 0), true);
  await page.getByRole("heading", {name: "Shape Pack 3"}).waitFor();
  assert.equal(await page.locator(".packs-detail-heading .packs-art img").evaluate((img) => img.complete && img.naturalWidth > 0), true);
  await page.getByText(/backing/i).first().waitFor();
  await page.getByRole("button", {name: "REDEEM · ETH"}).click();
  await page.getByText("Redeem burns every Shape and pays its backing in ETH to your wallet.").waitFor();
  await page.getByRole("button", {name: "CREATE", exact: true}).click();
  const denominationInputs = page.locator(".packs-denominations input");
  assert.equal(await denominationInputs.count(), 9);
  await denominationInputs.first().fill("3");
  await page.getByText("0.00033 ETH").waitFor({timeout: 30_000});
  await page.locator(".packs-denomination .btn-outline").nth(1).click();
  assert.equal(await denominationInputs.first().inputValue(), "4");
  await page.locator(".packs-denomination .btn-outline").first().click();
  assert.equal(await denominationInputs.first().inputValue(), "3");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) =>
    button.textContent?.trim() === "CREATE PACK" && !button.disabled), undefined, {timeout: 30_000});
  assert.equal(await page.getByRole("button", {name: "CREATE PACK"}).isEnabled(), true);
  await page.getByRole("group", {name: "Pack action"}).getByRole("button", {name: "ADD TO PACK"}).click();
  await page.getByText("Adding to pack #3.").waitFor();
  assert.equal(await page.getByRole("button", {name: "ADD TO PACK"}).last().isEnabled(), true);
  await page.waitForFunction(() => !document.body.innerText.includes("Reading your Shapes…"), undefined, {timeout: 90_000});
  const shapePick = page.locator(".packs-picks .compose-select-card").first();
  await shapePick.click();
  assert.equal(await shapePick.getAttribute("aria-pressed"), "true");
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
  console.log("PASS Sepolia browser: navigation, wallet, pack artwork, selection, steppers, exit modes, exact quote, mobile layout");
} finally {
  await browser.close();
}

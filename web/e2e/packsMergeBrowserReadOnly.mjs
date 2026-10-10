/** Browser fixture: read existing Sepolia pack state through a proxy, then simulate the new merge wallet path. */
import assert from "node:assert/strict";
import {chromium} from "playwright";
import {decodeFunctionData, parseAbi, toFunctionSelector} from "viem";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3192";
const rpc = "https://gateway.tenderly.co/public/sepolia";
const newPacks = "0x6DB763fB3FA5B988BEDa8E7a4288c79d7E1E6f45";
const newRenderer = "0xbFa47D2047D61AE8eAA685008e1272E4F9d6ea60";
const oldPacks = "0xd1cfc13abcbb370d381ac192aeb6f2e1b414022a";
const oldRenderer = "0xFeF50a388BDE6B222c6F5FecaFE590BF561c8Bda";
const owner = "0xCB43078C32423F5348Cab5885911C3B5faE217F9";
const mergeAbi = parseAbi(["function mergePacks(uint256 targetPackId,uint256[] sourcePackIds)"]);
const mergeSelector = toFunctionSelector("mergePacks(uint256,uint256[])");
const browser = await chromium.launch({headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROME_PATH} : {})});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(({address}) => {
  const listeners = new Map();
  const provider = {
    request: async ({method, params}) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "net_version") return "11155111";
      if (method === "eth_sendTransaction") {
        window.__mergeTx = params[0];
        throw new Error("Signing disabled in the merge browser test.");
      }
      if (method.startsWith("personal_sign") || method.startsWith("eth_sign")) throw new Error("Signing disabled.");
      throw new Error(`Read-only wallet does not support ${method}`);
    },
    on(event, handler) {const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); return provider;},
    removeListener(event, handler) {listeners.get(event)?.delete(handler); return provider;},
  };
  const info = {uuid: "76e08320-0d37-4d3a-af95-bb9ba6227c53", name: "Read-only Merge Wallet",
    rdns: "wtf.ripe.shapes.merge-read-only", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"};
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {detail: Object.freeze({info, provider})}));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, {address: owner});

// The supplied new addresses had no code when this test was written. Proxy the old deployment's
// read-only six-pack state into the new address, and let merge preflight succeed without broadcasting.
await page.route(rpc, async (route) => {
  const raw = route.request().postData();
  if (!raw) return route.continue();
  const request = JSON.parse(raw);
  const call = Array.isArray(request) ? null : request;
  const isMerge = (call?.method === "eth_call" || call?.method === "eth_estimateGas") &&
    call.params?.[0]?.data?.startsWith(mergeSelector);
  if (isMerge) return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
    jsonrpc: "2.0", id: call.id, result: call.method === "eth_call" ? "0x" : "0x2dc6c0",
  })});
  const outgoing = raw
    .replace(new RegExp(newPacks.slice(2), "ig"), oldPacks.slice(2))
    .replace(new RegExp(newRenderer.slice(2), "ig"), oldRenderer.slice(2));
  const response = await route.fetch({postData: outgoing});
  const body = (await response.text()).replace(new RegExp(oldRenderer.slice(2), "ig"), newRenderer.slice(2));
  return route.fulfill({response, body});
});

try {
  await page.goto(`${baseUrl}/packs`, {waitUntil: "domcontentloaded"});
  await page.getByRole("button", {name: /Shape Pack 3.*LIVE/}).waitFor({timeout: 60_000});
  await page.getByRole("button", {name: /Shape Pack 3.*LIVE/}).click();
  const sourceGroup = page.getByRole("group", {name: "Source packs to merge"});
  assert.equal(await sourceGroup.getByRole("button").count(), 5);
  const source2 = sourceGroup.getByRole("button", {name: /Shape Pack 2/});
  const source1 = sourceGroup.getByRole("button", {name: /Shape Pack 1/});
  const mergeButton = page.getByRole("button", {name: "MERGE PACKS"});
  assert.equal(await mergeButton.isDisabled(), true);
  await source2.click();
  await source1.click();
  assert.equal(await source2.getAttribute("aria-pressed"), "true");
  assert.equal(await source1.getAttribute("aria-pressed"), "true");
  await page.getByText("2 source pack tokens will be burned.").waitFor();
  assert.equal(await mergeButton.isEnabled(), true);
  if (process.env.E2E_SCREENSHOT_MERGE) await page.locator(".packs-merge").screenshot({path: process.env.E2E_SCREENSHOT_MERGE});
  await mergeButton.click();
  await page.waitForFunction(() => window.__mergeTx !== undefined, undefined, {timeout: 30_000});
  const tx = await page.evaluate(() => window.__mergeTx);
  assert.equal(tx.to.toLowerCase(), newPacks.toLowerCase());
  const decoded = decodeFunctionData({abi: mergeAbi, data: tx.data});
  assert.equal(decoded.functionName, "mergePacks");
  assert.deepEqual(decoded.args, [3n, [2n, 1n]]);
  await page.locator(".packs-status.is-error").waitFor();
  assert.deepEqual(errors, []);
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  console.log("PASS read-only merge browser: selection, source burn summary, preflight, wallet calldata, mobile layout");
} finally {
  await browser.close();
}

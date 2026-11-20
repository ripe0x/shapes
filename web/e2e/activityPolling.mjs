/** Poll recovery against a running site and its real indexer; only failures are injected. */
import assert from "node:assert/strict";
import {chromium} from "playwright";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3193";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname),
  "Run recovery checks against a local preview with a working indexer");
const browser = await chromium.launch({headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROME_PATH} : {})});
const page = await browser.newPage({viewport: {width: 1280, height: 1000}});
const errors = [];
page.on("pageerror", error => errors.push(error.message));
let failFirstPage = true;
let failPagination = false;
let firstPageRequests = 0;
let paginationFailures = 0;
await page.route("**/api/indexer?*", async route => {
  const params = new URL(route.request().url()).searchParams;
  if (/^query Activity\(/.test(params.get("query") ?? "")) {
    const {after} = JSON.parse(params.get("variables") ?? "{}");
    if (after === null) firstPageRequests++;
    if ((after === null && failFirstPage) || (after !== null && failPagination)) {
      if (after !== null) paginationFailures++;
      await route.fulfill({status: 503, contentType: "application/json",
        body: JSON.stringify({errors: [{message: "Indexer temporarily unavailable"}]})});
      return;
    }
  }
  await route.continue();
});

try {
  await page.goto(baseUrl, {waitUntil: "domcontentloaded"});
  const feed = page.locator("#activity");
  await feed.getByText("The activity index is unavailable right now.").waitFor({timeout: 60_000});
  const failedRequests = firstPageRequests;
  failFirstPage = false;
  await feed.locator(".activity-row").first().waitFor({timeout: 30_000});
  assert.ok(firstPageRequests > failedRequests, "Initial failure disabled polling");
  assert.equal(await feed.locator(".activity-note").count(), 0);
  console.log("PASS initial indexer outage recovers automatically without reloading");

  const showMore = feed.getByRole("button", {name: "Show more", exact: true});
  await showMore.waitFor();
  const originalLinks = await feed.locator(".activity-row-foot a").evaluateAll(links => links.map(link => link.href));
  failPagination = true;
  await showMore.click();
  await showMore.waitFor();
  assert.ok(paginationFailures > 0, "Pagination failure was not exercised");
  const beforePoll = firstPageRequests;
  failPagination = false;
  await page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/indexer" && response.ok() &&
      /^query Activity\(/.test(url.searchParams.get("query") ?? "") &&
      JSON.parse(url.searchParams.get("variables") ?? "{}").after === null;
  }, {timeout: 30_000});
  assert.ok(firstPageRequests > beforePoll, "Pagination failure disabled polling");
  const retainedLinks = await feed.locator(".activity-row-foot a").evaluateAll(links => links.map(link => link.href));
  for (const link of originalLinks) assert.ok(retainedLinks.includes(link), "A retry discarded a loaded row");
  await showMore.click();
  await page.waitForFunction(count => document.querySelectorAll("#activity .activity-row").length > count,
    originalLinks.length, {timeout: 30_000});
  console.log("PASS pagination failure keeps polling and loaded rows; Show more can retry");

  failFirstPage = true;
  await feed.getByRole("button", {name: "Shapes", exact: true}).click();
  await feed.getByText("The activity index is unavailable right now.").waitFor();
  failFirstPage = false;
  await feed.locator(".activity-row").first().waitFor({timeout: 30_000});
  assert.equal(await feed.getByRole("button", {name: "Shapes", exact: true}).getAttribute("aria-pressed"), "true");
  assert.equal(await feed.locator(".activity-pack-thumb").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS a failed filter load retries and displays only the selected filter");
} catch (error) {
  console.error({firstPageRequests, paginationFailures, errors,
    feed: await page.locator("#activity").innerText().catch(() => "Feed did not mount")});
  throw error;
} finally {
  await browser.close();
}

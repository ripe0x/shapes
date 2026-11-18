/** Compare local production builds with the same wallet configuration, RPC and browser profile. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const targets = { baseline: process.env.BASELINE_URL ?? "http://127.0.0.1:3196", candidate: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3197" };
if (process.env.PERF_TARGET) {
  assert.ok(process.env.PERF_TARGET in targets, "PERF_TARGET must be baseline or candidate");
  for (const key of Object.keys(targets)) if (key !== process.env.PERF_TARGET) delete targets[key];
}
for (const value of Object.values(targets)) assert.ok(["127.0.0.1", "localhost"].includes(new URL(value).hostname));
const samples = Number(process.env.PERF_SAMPLES ?? 3);
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROME_PATH} : {})});
const results = [];
try {
  for (const profile of ["desktop", "constrained"]) for (let sample = 0; sample < samples; sample++) for (const [target, url] of Object.entries(targets)) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", {cacheDisabled: true});
    if (profile === "constrained") {
      await cdp.send("Network.emulateNetworkConditions", {offline: false, latency: 100, downloadThroughput: 200000, uploadThroughput: 100000});
      await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4});
    }
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__startup = {};
      const observe = () => {
        for (const [name, selector] of [["header", ".site-header"], ["walletReady", '.site-header[data-wallet-ready="true"]']]) {
          if (window.__startup[name] === undefined && document.querySelector(selector)) window.__startup[name] = performance.now();
        }
        const panel = document.querySelector(".mint-panel");
        const input = panel?.querySelector(".qty-input");
        const connect = panel && [...panel.querySelectorAll("button")].find((button) => button.textContent.trim() === "Connect wallet");
        if (window.__startup.mint === undefined && panel?.getBoundingClientRect().width > 0 &&
            input && !input.disabled && connect && !connect.disabled &&
            panel.querySelectorAll(".row-denom").length === 9) window.__startup.mint = performance.now();
      };
      new MutationObserver(observe).observe(document, {childList: true, subtree: true, attributes: true});
    });
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.waitForFunction(() => window.__startup.mint !== undefined, undefined, {timeout: 30000});
    if (target === "candidate") await page.locator('.site-header[data-wallet-ready="true"]').waitFor({timeout: 30000});
    // Keep a fixed observation window so background connector downloads count equally.
    await page.waitForFunction(() => performance.now() >= 8000);
    const timings = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource");
      const scripts = resources.filter((entry) => new URL(entry.name).pathname.endsWith(".js") && entry.responseEnd <= 8000);
      const nav = performance.getEntriesByType("navigation")[0];
      return { ...window.__startup, ttfb: nav.responseStart, fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
        jsFiles: scripts.length, jsBytes: scripts.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        jsBeforeHeaderBytes: scripts.filter((entry) => entry.responseEnd <= window.__startup.header).reduce((sum, entry) => sum + entry.encodedBodySize, 0) };
    });
    assert.deepEqual(errors, [], `${target} runtime errors`);
    const result = {target, profile, sample, ...timings};
    results.push(result);
    console.log(JSON.stringify(result));
    await context.close();
  }
  const summary = [];
  for (const profile of ["desktop", "constrained"]) for (const target of Object.keys(targets)) {
    const rows = results.filter((row) => row.profile === profile && row.target === target);
    const median = (key) => rows.map((row) => row[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    summary.push({target, profile, samples: rows.length, headerMs: median("header"), mintMs: median("mint"), walletReadyMs: median("walletReady") ?? null, fcpMs: median("fcp"), ttfbMs: median("ttfb"), jsFiles: median("jsFiles"), jsBytes: median("jsBytes"), jsBeforeHeaderBytes: median("jsBeforeHeaderBytes")});
  }
  writeFileSync(process.env.PERF_OUTPUT ?? "/tmp/shapes-startup-performance.json", JSON.stringify({conditions: {cache: "disabled; fresh browser context per sample", constrained: {latencyMs: 100, bytesPerSecond: 200000, cpuSlowdown: 4}, observationMs: 8000}, results, summary}, null, 2));
  console.log(JSON.stringify({summary}, null, 2));
  for (const row of results.filter((row) => row.target === "candidate" && row.profile === "constrained")) {
    assert.ok(row.mint < 2000, `Constrained mint sample ${row.sample} exceeded 2 seconds: ${row.mint.toFixed(1)}ms`);
  }
  for (const row of summary.filter((row) => row.target === "candidate" && row.profile === "constrained")) {
    assert.ok(row.mintMs < 2000, `Constrained mint median exceeded 2 seconds: ${row.mintMs.toFixed(1)}ms`);
  }
} finally { await browser.close(); }

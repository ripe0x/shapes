/**
 * Build the preview harness as a single self-contained HTML file.
 *
 * No server, no install, no network: open it and it runs. Useful for reviewing the collection
 * on a machine that has no toolchain, and for sharing a frozen snapshot of a design state.
 *
 *   npm run standalone            -> shapes-preview.html
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
execSync("npx vite build", { cwd: root, stdio: "inherit" });

const dist = resolve(root, "dist");
let html = readFileSync(resolve(dist, "index.html"), "utf8");

const assets = readdirSync(resolve(dist, "assets"));
for (const file of assets) {
  const body = readFileSync(resolve(dist, "assets", file), "utf8");
  if (file.endsWith(".js")) {
    // NOTE: the replacement MUST be a function. A replacement string would have `$&`, `$\'`
    // and similar sequences inside the bundle interpreted by String.replace, which silently
    // re-injects surrounding markup — including the very script tag being replaced.
    html = html.replace(
      new RegExp(`<script[^>]*src="[^"]*${file}"[^>]*></script>`),
      () => `<script type="module">\n${body}\n</script>`,
    );
  } else if (file.endsWith(".css")) {
    html = html.replace(
      new RegExp(`<link[^>]*href="[^"]*${file}"[^>]*>`),
      () => `<style>\n${body}\n</style>`,
    );
  }
}

// Precise check: nothing may still point at the assets directory. A loose scan for
// `<script src=` would false-positive on markup inside the inlined bundle.
if (/(?:src|href)="[^"]*assets\//.test(html)) {
  throw new Error("standalone build still references external assets");
}

const out = resolve(root, "shapes-preview.html");
writeFileSync(out, html);
console.log(`\nwrote ${out}  (${(html.length / 1024).toFixed(0)} KB, fully self-contained)`);

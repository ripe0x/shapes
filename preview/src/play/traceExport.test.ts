import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTraceSvg, traceFilename, type TraceGeometry } from "../app/traceExport";

const WAD = 1_000_000_000_000_000_000n;
const artwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" width="2000" height="2800"><rect x="0" y="0" width="250" height="350" fill="#000"/></svg>`;

// 2x1 grid, cell 10 units, origin (5, 20): cell 0 at (5,20), cell 1 at (15,20).
const geometry: TraceGeometry = { cols: 2, rows: 1, cell: 10n * WAD, x0: 5n * WAD, y0: 20n * WAD };

test("buildTraceSvg: contains the artwork and one rect per colored cell at its geometry position", () => {
  const colors = ["#e63946", "#457b9d"];
  const out = buildTraceSvg(artwork, geometry, (j) => colors[j]);
  assert.ok(out.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" width="2000" height="2800">`));
  assert.ok(out.endsWith("</svg>"));
  assert.ok(out.includes(`<rect x="0" y="0" width="250" height="350" fill="#000"/>`), "artwork's own background rect survives");
  assert.equal((out.match(/<rect/g) ?? []).length, 3); // artwork background + 2 overlay cells
  assert.ok(out.includes(`<rect x="5" y="20" width="10" height="10" fill="#e639464d"/>`));
  assert.ok(out.includes(`<rect x="15" y="20" width="10" height="10" fill="#457b9d4d"/>`));
});

test("buildTraceSvg: a cell with no color is left untinted", () => {
  const out = buildTraceSvg(artwork, geometry, (j) => (j === 0 ? "#e63946" : undefined));
  assert.equal((out.match(/<rect/g) ?? []).length, 2); // artwork background + one overlay cell
  assert.ok(!out.includes("457b9d"));
});

test("traceFilename: appends -trace before the extension", () => {
  assert.equal(traceFilename("png", "shape-197"), "shape-197-trace.png");
  assert.equal(traceFilename("svg", "shape-0.1eth-1a2b3c4d"), "shape-0.1eth-1a2b3c4d-trace.svg");
});

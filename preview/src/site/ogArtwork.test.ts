import {test} from "node:test";
import assert from "node:assert/strict";

import {MAX_OG_TOKEN_URI_LENGTH, safeImageFromTokenURI} from "./ogArtwork";

function tokenUri(image: string): string {
  const metadata = Buffer.from(JSON.stringify({name: "Shape 0", image})).toString("base64");
  return `data:application/json;base64,${metadata}`;
}

function svgUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

test("safeImageFromTokenURI accepts canonical self-contained SVG artwork", () => {
  const image = svgUri(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"><rect width="250" height="350"/></svg>',
  );
  assert.equal(safeImageFromTokenURI(tokenUri(image)), image);
});

test("safeImageFromTokenURI rejects external image locations", () => {
  assert.equal(safeImageFromTokenURI(tokenUri("http://127.0.0.1/admin")), null);
  assert.equal(safeImageFromTokenURI(tokenUri("file:///etc/passwd")), null);
});

test("safeImageFromTokenURI rejects active or externally-referencing SVG", () => {
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://127.0.0.1/a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><audio src="http://127.0.0.1/a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://127.0.0.1/a)"/></svg>',
  ]) {
    assert.equal(safeImageFromTokenURI(tokenUri(svgUri(svg))), null);
  }
});

test("safeImageFromTokenURI rejects malformed and oversized metadata", () => {
  assert.equal(safeImageFromTokenURI("data:application/json;base64,%%%"), null);
  assert.equal(safeImageFromTokenURI(`data:application/json;base64,${"A".repeat(MAX_OG_TOKEN_URI_LENGTH)}`), null);
});

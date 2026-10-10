import {test} from "node:test";
import assert from "node:assert/strict";

import {MAX_OG_TOKEN_URI_LENGTH, safeImageFromTokenURI, safeMetadataFromTokenURI} from "./ogArtwork";

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
  assert.deepEqual(safeMetadataFromTokenURI(tokenUri(image)), {name: "Shape 0", image});
});

test("safeMetadataFromTokenURI keeps a safe name when artwork is unavailable", () => {
  assert.deepEqual(safeMetadataFromTokenURI(tokenUri("https://example.com/image.svg")), {name: "Shape 0", image: null});
});

test("safeImageFromTokenURI accepts pack filters and clipping with local ids", () => {
  const image = svgUri('<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="d"><feDropShadow dx="0"/></filter><clipPath id="c0"><rect width="5" height="5"/></clipPath></defs><g filter="url(#d)" clip-path="url(#c0)"><rect width="5" height="5"/></g></svg>');
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
    '<svg xmlns="http://www.w3.org/2000/svg"><g filter="url(https://example.com/f.svg#d)"/></svg>',
  ]) {
    assert.equal(safeImageFromTokenURI(tokenUri(svgUri(svg))), null);
  }
});

test("safeImageFromTokenURI rejects malformed and oversized metadata", () => {
  assert.equal(safeImageFromTokenURI("data:application/json;base64,%%%"), null);
  assert.equal(safeImageFromTokenURI(`data:application/json;base64,${"A".repeat(MAX_OG_TOKEN_URI_LENGTH)}`), null);
});

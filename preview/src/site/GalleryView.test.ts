import {strict as assert} from "node:assert";
import {test} from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {filterGallery, GalleryView} from "./GalleryView";

// Server rendering executes GalleryView's hooks without needing a browser DOM.

const OWNER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OTHER = "0x2222222222222222222222222222222222222222" as `0x${string}`;

test("filterGallery composes the denomination filter with the owner filter", () => {
  const tokens = [
    {id: 3n, di: 0, owner: OWNER},
    {id: 2n, di: 1, owner: OTHER},
    {id: 1n, di: 0, owner: OTHER},
  ];
  // Denomination alone.
  assert.deepEqual(filterGallery(tokens, 0, false, undefined).map((t) => t.id), [3n, 1n]);
  // Owner alone (all denominations).
  assert.deepEqual(filterGallery(tokens, -1, true, OTHER).map((t) => t.id), [2n, 1n]);
  // Both: denomination 0, owned by OTHER.
  assert.deepEqual(filterGallery(tokens, 0, true, OTHER).map((t) => t.id), [1n]);
  // ownerOnly with no connected address falls back to the denomination filter alone.
  assert.deepEqual(filterGallery(tokens, 0, true, undefined).map((t) => t.id), [3n, 1n]);
});

test("GalleryView shows the My Shapes chip only when a wallet is connected", () => {
  const base = {
    data: null,
    filter: -1,
    setFilter: () => {},
    ownerOnly: false,
    setOwnerOnly: () => {},
    onOpenToken: () => {},
  };
  assert.equal(renderToStaticMarkup(React.createElement(GalleryView, {...base, address: undefined})).includes("My Shapes"), false);
  assert.equal(renderToStaticMarkup(React.createElement(GalleryView, {...base, address: OWNER})).includes("My Shapes"), true);
});

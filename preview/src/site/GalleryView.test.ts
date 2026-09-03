import {strict as assert} from "node:assert";
import {test} from "node:test";
import {filterGallery, GalleryView} from "./GalleryView";

// No jsdom/react-dom is wired into this suite (see wagmi.test.ts's plain node:test pattern), so
// GalleryView is exercised as a plain function returning a React element tree, and the tree is
// searched directly instead of rendering it to a DOM.

const OWNER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OTHER = "0x2222222222222222222222222222222222222222" as `0x${string}`;

/** Depth-first search of a React element tree (as returned by calling a function component
 *  directly) for a node whose children include `text` verbatim. */
function findByText(node: unknown, text: string): boolean {
  if (node == null || typeof node === "boolean" || typeof node === "number") return false;
  if (typeof node === "string") return node === text;
  if (Array.isArray(node)) return node.some((n) => findByText(n, text));
  if (typeof node === "object" && "props" in node) {
    return findByText((node as {props: {children?: unknown}}).props.children, text);
  }
  return false;
}

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
  assert.equal(findByText(GalleryView({...base, address: undefined}), "My Shapes"), false);
  assert.equal(findByText(GalleryView({...base, address: OWNER}), "My Shapes"), true);
});

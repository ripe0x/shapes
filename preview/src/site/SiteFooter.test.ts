import {strict as assert} from "node:assert";
import {test} from "node:test";
import {SiteFooter} from "./SiteFooter";

// No jsdom/react-dom is wired into this suite (see wagmi.test.ts's plain node:test pattern), so
// SiteFooter is exercised as a plain function returning a React element tree, and the tree's props
// are asserted directly instead of rendering it to a DOM.

/** Depth-first search of a React element tree for a node whose props satisfy `match`. */
function find(node: unknown, match: (props: Record<string, unknown>) => boolean): {props: Record<string, unknown>} | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!("props" in node)) return null;
  const el = node as {props: Record<string, unknown>};
  if (match(el.props)) return el;
  return find(el.props.children, match);
}

test("SiteFooter: with no onContracts, the contracts link is a plain /contracts href", () => {
  const el = SiteFooter({});
  const link = find(el, (p) => p.href === "/contracts");
  assert.ok(link, "expected an <a href=\"/contracts\">");
});

test("SiteFooter: with onContracts, the contracts link drives it instead of a raw href", () => {
  const onContracts = () => {};
  const el = SiteFooter({onContracts});
  const anchor = find(el, (p) => p.href === "/contracts");
  assert.equal(anchor, null, "should not fall back to a raw href when onContracts is given");
  const button = find(el, (p) => p.onClick === onContracts);
  assert.ok(button, "expected a button wired to onContracts");
});

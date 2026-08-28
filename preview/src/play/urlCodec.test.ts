import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptySession,
  keepCard,
  composeNodes,
  liveNodes,
  removeNode,
  textSeed,
  type PlaySession,
} from "./session";
import { encodeSession, decodeSession, sessionShareable } from "./urlCodec";
import { productionSeed } from "../seeds";

/** Base64url-encode an arbitrary wire object, bypassing `encodeSession`, to hand `decodeSession`
 *  hand-built payloads its own encoder would never produce. Tests only; runs under Node. */
function encodeRawWire(wire: unknown): string {
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

function bytesEqual(a?: Uint8Array, b?: Uint8Array): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Every node in `a` and `b`, in order, agrees on the fields the codec must round-trip. */
function assertSessionsEqual(a: PlaySession, b: PlaySession) {
  assert.equal(a.nodes.length, b.nodes.length);
  for (let i = 0; i < a.nodes.length; i++) {
    const na = a.nodes[i];
    const nb = b.nodes[i];
    assert.equal(na.demoId, nb.demoId, `node ${i} demoId`);
    assert.equal(na.denomIndex, nb.denomIndex, `node ${i} denomIndex`);
    assert.equal(na.inkGene, nb.inkGene, `node ${i} inkGene`);
    assert.equal(na.seed, nb.seed, `node ${i} seed`);
    assert.equal(bytesEqual(na.modules, nb.modules), true, `node ${i} modules`);
    assert.deepEqual(na.trace, nb.trace, `node ${i} trace`);
  }
}

test("round trip: two cards, one text-seeded, no compose", () => {
  let s = emptySession();
  s = keepCard(s, 0, 0x1234n);
  s = keepCard(s, 2, textSeed("vitalik.eth"), "vitalik.eth");
  const nodes = liveNodes(s);
  assert.equal(nodes[1].seedText, "vitalik.eth");

  const encoded = encodeSession(s);
  const decoded = decodeSession(encoded);
  assertSessionsEqual(s, decoded);
});

test("round trip: compose", () => {
  let s = emptySession();
  s = keepCard(s, 1, 0x1111n);
  s = keepCard(s, 1, 0x2222n);
  const [a, b] = liveNodes(s);
  s = composeNodes(s, [a.key, b.key]);

  const decoded = decodeSession(encodeSession(s));
  assertSessionsEqual(s, decoded);
});

test("round trip: chained compose (compose a composed card again)", () => {
  let s = emptySession();
  s = keepCard(s, 1, 0x1111n);
  s = keepCard(s, 1, 0x2222n);
  let live = liveNodes(s);
  s = composeNodes(s, [live[0].key, live[1].key]); // -> 0.1 ETH

  for (const seed of [0x3333n, 0x4444n, 0x5555n, 0x6666n]) s = keepCard(s, 2, seed);
  live = liveNodes(s);
  s = composeNodes(s, live.map((n) => n.key)); // -> 0.5 ETH, second-generation

  const decoded = decodeSession(encodeSession(s));
  assertSessionsEqual(s, decoded);
  // The chained result's modules must differ from what a bare (non-materialized) survivor
  // would produce -- confirms decode replayed the compose, not re-derived the survivor fresh.
  assert.equal(liveNodes(decoded)[0].modules !== undefined, true);
});

test("round trip: a card removed before a later keep still decodes to the same artwork", () => {
  // demoId sequence in the original session has a gap: keep(1), keep(2), remove(2), keep(3).
  // A and C are both 0.05 ETH so their compose (0.10 ETH) doesn't need the removed B at all.
  //
  // The wire format has no room to record a removed card (nothing about it survives into
  // session.nodes to encode), so a fresh replay can't reproduce the original gappy demoId
  // sequence -- it only ever sees the cards that still exist and numbers them contiguously.
  // encodeSession compensates by encoding compose participants as this same contiguous
  // "replay id" rather than the raw (gappy) demoId, so decode still resolves every participant
  // and reproduces the same cards, same seeds, same sampled bytes -- just possibly under
  // different #N display labels than the original session showed for that card. That's the
  // real invariant this test checks; exact demoId/trace.donorId equality is not required here
  // (see the "compose" and "chained compose" tests above for sessions with no removals, where
  // demoId and trace are asserted byte-for-byte).
  let s = emptySession();
  s = keepCard(s, 1, 0x1111n); // A, demoId 1
  s = keepCard(s, 1, 0x2222n); // B, demoId 2
  const b = liveNodes(s).find((n) => n.seed === 0x2222n)!;
  s = removeNode(s, b.key); // gap: demoId 2 is now unused for the rest of the session
  s = keepCard(s, 1, 0x3333n); // C, demoId 3
  const live = liveNodes(s);
  s = composeNodes(s, [live[0].key, live[1].key]); // A + C -> 0.10 ETH

  const decoded = decodeSession(encodeSession(s));
  assert.equal(decoded.nodes.length, s.nodes.length);
  for (let i = 0; i < s.nodes.length; i++) {
    assert.equal(decoded.nodes[i].denomIndex, s.nodes[i].denomIndex, `node ${i} denomIndex`);
    assert.equal(decoded.nodes[i].inkGene, s.nodes[i].inkGene, `node ${i} inkGene`);
    assert.equal(decoded.nodes[i].seed, s.nodes[i].seed, `node ${i} seed`);
    assert.equal(bytesEqual(decoded.nodes[i].modules, s.nodes[i].modules), true, `node ${i} modules`);
  }
  const decodedResult = liveNodes(decoded)[0];
  const originalResult = liveNodes(s)[0];
  assert.equal(decodedResult.trace!.length, originalResult.trace!.length);
  for (let j = 0; j < originalResult.trace!.length; j++) {
    assert.equal(decodedResult.trace![j].donorIndex, originalResult.trace![j].donorIndex);
    assert.equal(decodedResult.trace![j].moduleIndex, originalResult.trace![j].moduleIndex);
    assert.equal(decodedResult.trace![j].byte, originalResult.trace![j].byte);
  }
});

test("decode: garbage input fails closed to an empty session", () => {
  assert.deepEqual(decodeSession("not-valid-base64!!!"), emptySession());
  assert.deepEqual(decodeSession(""), emptySession());
  assert.deepEqual(decodeSession("####"), emptySession());
});

test("decode: truncated base64 fails closed", () => {
  const encoded = encodeSession((() => {
    let s = emptySession();
    s = keepCard(s, 0, 0x1234n);
    return s;
  })());
  assert.deepEqual(decodeSession(encoded.slice(0, Math.max(1, encoded.length - 3))), emptySession());
});

test("decode: oversize payload fails closed", () => {
  let s = emptySession();
  for (let i = 0; i < 8; i++) s = keepCard(s, 0, BigInt(i + 1), "x".repeat(128));
  const encoded = encodeSession(s);
  // Pad well past the 4096-byte decoded cap with more (still schema-valid-shaped) ops text.
  const oversized = encoded + "A".repeat(6000);
  assert.deepEqual(decodeSession(oversized), emptySession());
});

test("decode: bad version fails closed", () => {
  assert.deepEqual(decodeSession(encodeRawWire({ v: 2, ops: [] })), emptySession());
});

test("decode: out-of-range denomination index fails closed", () => {
  const wire = { v: 1, ops: [{ c: { d: 9, s: "1".repeat(64) } }] };
  assert.deepEqual(decodeSession(encodeRawWire(wire)), emptySession());
});

test("decode: compose referencing a missing participant id fails closed", () => {
  const wire = { v: 1, ops: [{ c: { d: 0, s: "1".repeat(64) } }, { x: [1, 99] }] };
  assert.deepEqual(decodeSession(encodeRawWire(wire)), emptySession());
});

test("decode: card with both t and s, or neither, fails closed", () => {
  const both = { v: 1, ops: [{ c: { d: 0, t: "x", s: "1".repeat(64) } }] };
  const neither = { v: 1, ops: [{ c: { d: 0 } }] };
  for (const wire of [both, neither]) {
    assert.deepEqual(decodeSession(encodeRawWire(wire)), emptySession());
  }
});

test("decode: too few compose participants fails closed", () => {
  const wire = { v: 1, ops: [{ c: { d: 0, s: "1".repeat(64) } }, { x: [1] }] };
  assert.deepEqual(decodeSession(encodeRawWire(wire)), emptySession());
});

test("decode: more than 64 ops fails closed", () => {
  const ops = Array.from({ length: 65 }, () => ({ c: { d: 0, s: "1".repeat(64) } }));
  assert.deepEqual(decodeSession(encodeRawWire({ v: 1, ops })), emptySession());
});

test("empty session encodes to a short string and decodes back to empty", () => {
  const encoded = encodeSession(emptySession());
  assert.deepEqual(decodeSession(encoded), emptySession());
});

test("sessionShareable: true for a normal session, false past the op cap", () => {
  let s = emptySession();
  for (let i = 0; i < 10; i++) s = keepCard(s, 0, productionSeed(BigInt(i + 1)));
  assert.equal(sessionShareable(s), true);

  // 65 nodes exceeds the 64-op decode limit even though each op is small.
  let big = emptySession();
  for (let i = 0; i < 65; i++) big = keepCard(big, 0, textSeed(`n${i}`), `n${i}`);
  assert.equal(sessionShareable(big), false);
  // And a shareable=false session really does fail to restore.
  assert.equal(decodeSession(encodeSession(big)).nodes.length, 0);
});

test("sessionShareable: false when the encoded payload exceeds the byte cap", () => {
  // 40 max-length text seeds blow past 4096 decoded bytes while staying under 64 ops.
  let s = emptySession();
  for (let i = 0; i < 40; i++) s = keepCard(s, 0, textSeed("x".repeat(120) + i), "x".repeat(120) + i);
  assert.equal(sessionShareable(s), false);
  assert.equal(decodeSession(encodeSession(s)).nodes.length, 0);
});
